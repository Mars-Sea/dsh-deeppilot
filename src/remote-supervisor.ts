import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from './token.ts'
import { normalizeFunnelConnectionLimit } from './funnel-policy.ts'

export type RemotePhase =
  | 'disabled'
  | 'starting'
  | 'login_required'
  | 'online'
  | 'error'
  | 'unavailable'
  | 'stopped'

export interface RemoteStatus {
  provider: 'tailscale-funnel'
  phase: RemotePhase
  publicURL?: string
  authURL?: string
  message?: string
  updatedAt: number
}

export interface RemoteSupervisorOptions {
  enabled: boolean
  hostname: string
  statePath: string
  helperPath?: string
  funnelPort?: 443 | 8443 | 10000
  maxConnectionsPerSource?: number
  log: (message: string) => void
}

interface HelperEvent {
  phase?: RemotePhase
  publicURL?: string
  authURL?: string
  message?: string
}

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
/**
 * Throttle for configuration-level failures (helper binary missing, state dir
 * unwritable). The environment will not self-heal between attempts, so the
 * previous "1s..30s exponential" backoff was a CPU/for-loop on a misconfigured
 * Host. 60s matches the APNs sender-failure throttle on the host plugin
 * (index.ts SENDER_FAILURE_RETRY_MS) and the relay enrollment throttle.
 */
const UNAVAILABLE_RETRY_MS = 60_000

/**
 * Exposed for tests: the backoff schedule depends on the failure category
 * (unavailable = config, won't self-heal; crash = transient). Tying this to
 * the constants above keeps the public schedule easy to assert against.
 */
export function restartDelayMs(kind: 'unavailable' | 'crash', attempt: number): number {
  if (kind === 'unavailable') return UNAVAILABLE_RETRY_MS
  const index = Math.min(attempt, RESTART_DELAYS_MS.length - 1)
  // RESTART_DELAYS_MS is a non-empty literal array, so the indexed value is
  // always defined; the explicit fallback is just to satisfy the strict
  // noUncheckedIndexedAccess setting without a non-null assertion.
  return RESTART_DELAYS_MS[index] ?? RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1]!
}

export const DEFAULT_REMOTE_HOSTNAME = 'dsh-deeppilot'

/** Preserve custom node names while migrating every pre-DeepPilot default. */
export function normalizeRemoteHostname(value: string | undefined): string {
  const hostname = value?.trim() ?? ''
  if (hostname === '' || ['dsh-phone', 'dsh-pocket', 'harnesspocket'].includes(hostname.toLowerCase())) {
    return DEFAULT_REMOTE_HOSTNAME
  }
  return hostname
}

export function tunnelHelperArguments(
  originURL: string,
  statePath: string,
  options: Pick<RemoteSupervisorOptions, 'hostname' | 'funnelPort' | 'maxConnectionsPerSource'>,
): string[] {
  return [
    '--origin', originURL,
    '--hostname', normalizeRemoteHostname(options.hostname),
    '--state-dir', statePath,
    '--port', String(options.funnelPort ?? 443),
    '--max-connections-per-source', String(normalizeFunnelConnectionLimit(options.maxConnectionsPerSource)),
  ]
}

/** Parse one helper IPC line without ever evaluating or interpolating it. */
export function parseHelperEvent(line: string): HelperEvent | null {
  try {
    const value = JSON.parse(line) as Record<string, unknown>
    const phases: RemotePhase[] = ['starting', 'login_required', 'online', 'error', 'stopped']
    if (typeof value.phase !== 'string' || !phases.includes(value.phase as RemotePhase)) return null
    return {
      phase: value.phase as RemotePhase,
      ...(typeof value.publicURL === 'string' ? { publicURL: value.publicURL } : {}),
      ...(typeof value.authURL === 'string' ? { authURL: value.authURL } : {}),
      ...(typeof value.message === 'string' ? { message: value.message.slice(0, 500) } : {}),
    }
  } catch {
    return null
  }
}

function isTailscaleAuthURL(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      (url.hostname === 'login.tailscale.com' || url.hostname.endsWith('.login.tailscale.com'))
  } catch {
    return false
  }
}

/** Translate Node's platform/architecture names to the GOOS/GOARCH directory
 *  names used by the committed helper matrix. */
export function bundledHelperPlatformDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const goos = platform === 'win32' ? 'windows' : platform
  const goarch = arch === 'x64' ? 'amd64' : arch
  return `${goos}-${goarch}`
}

/** Build the list of candidate locations for the embedded tunnel helper, in
 *  priority order. The first existing executable wins at start() time. The
 *  order matters: explicit config (handled by the caller) > npm install
 *  layout > DSH-bundled layout > user data dir. */
export function bundledHelperCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkgRoot = resolve(here, '..')
  const fileName = platform === 'win32' ? 'dsh-deeppilot-tunnel.exe' : 'dsh-deeppilot-tunnel'
  const platformDir = bundledHelperPlatformDir(platform, arch)

  const candidates: string[] = []
  // 1. Standard npm layout: <pkgRoot>/bin/<os>-<arch>/<file>
  candidates.push(resolve(pkgRoot, 'bin', platformDir, fileName))
  // 2. DSH sometimes relocates lib/ into apps/web or a build cache while
  //    leaving bin/ beside the original package root. Try a few hops up.
  candidates.push(resolve(pkgRoot, '..', '..', '..', 'node_modules', 'dsh-deeppilot', 'bin', platformDir, fileName))
  candidates.push(resolve(pkgRoot, '..', '..', 'dsh-deeppilot', 'bin', platformDir, fileName))
  candidates.push(resolve(pkgRoot, '..', '..', '..', '..', 'node_modules', 'dsh-deeppilot', 'bin', platformDir, fileName))

  // 3. As a last resort, ask the loader to resolve the binary via Node's
  //    package resolution. Works when bin/ is shipped but import.meta.url
  //    points somewhere unexpected.
  try {
    const require = createRequire(import.meta.url)
    const resolved = require.resolve(`dsh-deeppilot/bin/${platformDir}/${fileName}`)
    if (!candidates.includes(resolved)) candidates.push(resolved)
  } catch {
    /* package.json exports field may not list bin/ — ignore */
  }

  // 4. User data dir fallback so power users can drop a custom build in.
  const home = process.env.DSH_HOME?.trim()
    || process.env.HOME
    || process.env.USERPROFILE
  if (home && home.length > 0) {
    const dataDir = resolve(home, '.dsh')
    candidates.push(join(dataDir, 'deeppilot', 'bin', platformDir, fileName))
  }

  return candidates
}

/** Owns exactly one embedded tunnel helper and restarts it after failures. */
export class RemoteSupervisor {
  private child: ChildProcess | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private restartAttempt = 0
  private stopping = false
  private statusValue: RemoteStatus

  constructor(private readonly options: RemoteSupervisorOptions) {
    this.statusValue = {
      provider: 'tailscale-funnel',
      phase: options.enabled ? 'stopped' : 'disabled',
      updatedAt: Date.now(),
    }
  }

  status(): RemoteStatus {
    return { ...this.statusValue }
  }

  async start(originURL: string): Promise<void> {
    if (!this.options.enabled || this.child !== undefined || this.stopping) return
    const statePath = expandHome(this.options.statePath)
    // Resolve a usable helper path. An explicit remote.helperPath wins; if it
    // is missing, fall back to a small set of candidate locations so that
    // DSH-bundled layouts and manually-dropped builds still work.
    const configured = this.options.helperPath?.trim() ?? ''
    const candidates = configured
      ? [expandHome(configured)]
      : bundledHelperCandidates()
    let helper: string | undefined
    let lastError: unknown
    for (const candidate of candidates) {
      try {
        await access(candidate, fsConstants.X_OK)
        helper = candidate
        break
      } catch (error) {
        lastError = error
      }
    }
    if (helper === undefined) {
      // A dispose() that raced these checks must not be overwritten by a
      // late failure report.
      if (this.stopping) return
      const platform = `${process.platform}-${process.arch}`
      const message = configured
        ? `embedded tunnel helper unavailable: ${configured}: ${String(lastError ?? 'not found')}`
        : `embedded tunnel helper not found for ${platform} (tried: ${candidates.join(', ')}); set remote.helperPath to override`
      this.setStatus({ phase: 'unavailable', message })
      this.scheduleRestart(originURL, 'unavailable')
      return
    }
    try {
      await mkdir(statePath, { recursive: true, mode: 0o700 })
    } catch (error) {
      if (this.stopping) return
      this.setStatus({ phase: 'unavailable', message: `cannot create remote state dir: ${String(error)}` })
      this.scheduleRestart(originURL, 'unavailable')
      return
    }

    // dispose() may have run while the filesystem checks above were in
    // flight; spawning afterwards would orphan a helper process that nothing
    // will ever reap (dispose already returned seeing no child).
    if (this.stopping) return

    this.setStatus({ phase: 'starting', message: undefined })
    const child = spawn(helper, tunnelHelperArguments(originURL, statePath, this.options), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
      },
    })
    this.child = child
    if (child.stdout === null || child.stderr === null) {
      this.setStatus({ phase: 'error', message: 'helper stdio unavailable' })
      child.kill('SIGTERM')
      return
    }

    let stdoutBuffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) this.acceptLine(line)
    })

    let stderrBuffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer = (stderrBuffer + chunk).slice(-2_000)
    })

    child.once('error', (error) => {
      this.setStatus({ phase: 'error', message: `helper launch failed: ${String(error)}` })
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (this.stopping) {
        this.setStatus({ phase: 'stopped', message: undefined })
        return
      }
      const detail = stderrBuffer.trim().split('\n').at(-1)
      this.setStatus({
        phase: 'error',
        message: detail || `helper exited (${signal ?? String(code)})`,
      })
      this.scheduleRestart(originURL, 'crash')
    })
  }

  async dispose(): Promise<void> {
    this.stopping = true
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const child = this.child
    this.child = undefined
    if (child === undefined) {
      this.setStatus({ phase: 'stopped', message: undefined })
      return
    }
    await new Promise<void>((resolveDone) => {
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(force)
        resolveDone()
      })
      child.kill('SIGTERM')
    })
    this.setStatus({ phase: 'stopped', message: undefined })
  }

  private acceptLine(line: string): void {
    const event = parseHelperEvent(line)
    if (event === null || event.phase === undefined) return
    if (event.phase === 'login_required') {
      // UserLogf is diagnostic output, not a typed auth callback. Accept only
      // the known login origin, and never let an incidental runtime URL knock
      // an already-online Funnel back into the setup state.
      if (this.statusValue.phase === 'online' || !isTailscaleAuthURL(event.authURL)) return
    }
    if (event.phase === 'online') this.restartAttempt = 0
    this.setStatus({ ...event, phase: event.phase })
  }

  private scheduleRestart(originURL: string, kind: 'unavailable' | 'crash' = 'crash'): void {
    if (this.stopping || this.restartTimer !== undefined) return
    // Configuration-level failures (helper missing, state dir unwritable)
    // cannot self-heal in a tight loop; throttle to one probe per minute so
    // a misconfigured Host stays observable without becoming a CPU sink.
    // Crashes still get the original exponential backoff so a transient
    // helper failure recovers quickly.
    const delay = kind === 'unavailable'
      ? UNAVAILABLE_RETRY_MS
      : RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)]
    if (kind === 'crash') this.restartAttempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.start(originURL)
    }, delay)
    this.restartTimer.unref?.()
  }

  private setStatus(next: Partial<RemoteStatus> & Pick<RemoteStatus, 'phase'>): void {
    const cleared: Partial<RemoteStatus> = next.phase === 'online'
      ? { authURL: undefined, message: undefined }
      : next.phase === 'login_required'
        ? { publicURL: undefined, message: undefined }
        : next.phase === 'starting' || next.phase === 'stopped' || next.phase === 'disabled'
          ? { publicURL: undefined, authURL: undefined, message: undefined }
          : {}
    this.statusValue = {
      ...this.statusValue,
      ...cleared,
      ...next,
      updatedAt: Date.now(),
    }
    if (next.phase === 'online') {
      this.options.log('remote Funnel online')
    } else if (next.phase === 'login_required') {
      this.options.log('remote Funnel requires browser authorization')
    } else if (next.phase === 'error' || next.phase === 'unavailable') {
      this.options.log(`remote Funnel ${next.phase}: ${next.message ?? 'unknown error'}`)
    }
  }
}
