import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from './token.ts'

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
  log: (message: string) => void
}

interface HelperEvent {
  phase?: RemotePhase
  publicURL?: string
  authURL?: string
  message?: string
}

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

export const DEFAULT_REMOTE_HOSTNAME = 'dsh-deeppilot'

/** Preserve custom node names while migrating every pre-DeepPilot default. */
export function normalizeRemoteHostname(value: string | undefined): string {
  const hostname = value?.trim() ?? ''
  if (hostname === '' || ['dsh-phone', 'dsh-pocket', 'harnesspocket'].includes(hostname.toLowerCase())) {
    return DEFAULT_REMOTE_HOSTNAME
  }
  return hostname
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

function bundledHelperPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '..', 'bin', `${process.platform}-${process.arch}`, 'dsh-deeppilot-tunnel')
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
    const helper = expandHome(this.options.helperPath ?? bundledHelperPath())
    const statePath = expandHome(this.options.statePath)
    try {
      await access(helper, fsConstants.X_OK)
      await mkdir(statePath, { recursive: true, mode: 0o700 })
    } catch (error) {
      // A dispose() that raced these checks must not be overwritten by a
      // late failure report.
      if (this.stopping) return
      this.setStatus({
        phase: 'unavailable',
        message: `embedded tunnel helper unavailable: ${String(error)}`,
      })
      return
    }

    // dispose() may have run while the filesystem checks above were in
    // flight; spawning afterwards would orphan a helper process that nothing
    // will ever reap (dispose already returned seeing no child).
    if (this.stopping) return

    this.setStatus({ phase: 'starting', message: undefined })
    const child = spawn(helper, [
      '--origin', originURL,
      '--hostname', normalizeRemoteHostname(this.options.hostname),
      '--state-dir', statePath,
      '--port', String(this.options.funnelPort ?? 443),
    ], {
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
      this.scheduleRestart(originURL)
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
    if (event.phase === 'online') this.restartAttempt = 0
    this.setStatus({ ...event, phase: event.phase })
  }

  private scheduleRestart(originURL: string): void {
    if (this.stopping || this.restartTimer !== undefined) return
    const delay = RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)]
    this.restartAttempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.start(originURL)
    }, delay)
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
