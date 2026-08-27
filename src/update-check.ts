/**
 * Lightweight self-update check for dsh-deeppilot.
 *
 * On Host boot we ask the GitHub Releases API (REST) which is the latest
 * stable tag, compare it to the installed plugin version, and surface a
 * "newer release exists" flag plus the GitHub release URL through the
 * report Remote. The settings page renders one small line at the bottom;
 * a successful check is enough — no manual button, no persistent cache
 * (the host process is the lifetime of the answer).
 *
 * Deliberately no third-party dependency: we use {@link https.request}
 * directly to keep parity with the rest of the project (remote-supervisor
 * uses node:http, host-bridge uses ws, etc).
 *
 * Failure policy: every network/parse error collapses to a single log
 * line and the in-memory snapshot stays "unknown". The bridge must never
 * crash because GitHub rate-limited us, returned a 5xx, or the user is
 * offline.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https'

/** GitHub repo (no .git suffix). Public, unauthenticated, low rate limit. */
const RELEASES_PATH = '/repos/Mars-Sea/dsh-deeppilot/releases'

/** Hard ceiling on the network round-trip. The host must never hang. */
const FETCH_TIMEOUT_MS = 8_000

/** Per-page limit. We only need the first stable release, but pre-releases
 *  tend to be listed first; fetching 20 gives the comparator enough room. */
const PER_PAGE = 20

/**
 * Public snapshot surfaced to the report Remote. `available` is `false`
 * until the network answer lands; on failure it stays `false` so the UI
 * simply doesn't render the "new version" hint.
 */
export interface UpdateInfo {
  /** Host plugin version (from package.json). */
  currentVersion: string
  /** True once a newer stable release has been found on GitHub. */
  available: boolean
  /** GitHub release page URL, when an update is available. */
  releaseUrl: string | null
  /** Newer stable tag, when an update is available. */
  latestVersion: string | null
}

interface GitHubRelease {
  tag_name?: unknown
  prerelease?: unknown
  draft?: unknown
  html_url?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseStableEntry(value: unknown): { tag: string; url: string | null } | null {
  if (!isPlainObject(value)) return null
  const tag = value.tag_name
  if (typeof tag !== 'string') return null
  if (value.prerelease === true || value.draft === true) return null
  if (parseStableTag(tag) === null) return null
  const url = value.html_url
  return { tag, url: typeof url === 'string' ? url : null }
}

/** Parse one stable release from the `tag_name` shape `vX.Y.Z` (the v is
 *  optional; `1.2.3` is also accepted). Pre-release tags like `0.3.0-rc.1`
 *  return null — the policy is "stable channel only". */
export function parseStableTag(tag: string): { major: number; minor: number; patch: number } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/** Semver compare for X.Y.Z. Returns -1 / 0 / 1. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseStableTag(a)
  const pb = parseStableTag(b)
  if (pa === null && pb === null) return 0
  if (pa === null) return -1
  if (pb === null) return 1
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return 0
}

/** Hit the GitHub Releases API. Resolves with the first stable release
 *  GitHub returned, or null if the list contains no stable entries.
 *  Network / parse errors reject — the caller is responsible for
 *  collapsing them to a log line. */
export function fetchLatestStableRelease(): Promise<{ tag: string; url: string | null } | null> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method: 'GET',
      host: 'api.github.com',
      path: `${RELEASES_PATH}?per_page=${PER_PAGE}`,
      headers: {
        'user-agent': 'dsh-deeppilot-update-check',
        'accept': 'application/vnd.github+json',
      },
    }
    const req = httpsRequest(options, (res) => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        res.resume()
        reject(new Error(`github releases http ${status}`))
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          const parsed = JSON.parse(body) as unknown
          if (!Array.isArray(parsed)) {
            reject(new Error('github releases: response is not an array'))
            return
          }
          for (const entry of parsed) {
            const stable = parseStableEntry(entry)
            if (stable !== null) {
              resolve(stable)
              return
            }
          }
          resolve(null)
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
      res.on('error', (error) => reject(error))
    })
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error('github releases: timeout after ' + FETCH_TIMEOUT_MS + 'ms'))
    })
    req.on('error', (error) => reject(error))
    req.end()
  })
}

/**
 * Process-wide check state. Constructed once in `apply()`, queried
 * synchronously by the report snapshot. The check itself fires once in
 * the background shortly after boot; the answer lives for the lifetime
 * of the host process — re-running the page in the Web UI does not
 * trigger another network call.
 */
export class UpdateChecker {
  private readonly log: (message: string) => void
  private readonly currentVersion: string
  private readonly fetchImpl: typeof fetchLatestStableRelease
  private readonly initialDelayMs: number
  private snapshot: UpdateInfo
  private inflight: Promise<void> | null = null

  constructor(options: {
    log: (message: string) => void
    currentVersion: string
    fetchImpl?: typeof fetchLatestStableRelease
    initialDelayMs?: number
  }) {
    this.log = options.log
    this.currentVersion = options.currentVersion
    this.fetchImpl = options.fetchImpl ?? fetchLatestStableRelease
    this.initialDelayMs = options.initialDelayMs ?? 2_000
    this.snapshot = {
      currentVersion: this.currentVersion,
      available: false,
      releaseUrl: null,
      latestVersion: null,
    }
  }

  /** Return the current in-memory snapshot — safe to call from any host
   *  thread. Never throws, never awaits. */
  get(): UpdateInfo {
    return this.snapshot
  }

  /**
   * Schedule one background refresh after the configured initial delay.
   * Used by the plugin entry to do the first check without blocking boot.
   */
  scheduleInitial(): void {
    if (this.initialDelayMs <= 0) {
      void this.runOnce()
      return
    }
    const timer = setTimeout(() => {
      void this.runOnce()
    }, this.initialDelayMs)
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref()
    }
  }

  private async runOnce(): Promise<void> {
    if (this.inflight !== null) {
      await this.inflight
      return
    }
    const task = (async () => {
      try {
        const stable = await this.fetchImpl()
        if (stable === null) {
          // No stable release on GitHub (yet) — leave `available` false.
          return
        }
        if (compareSemver(stable.tag, this.currentVersion) > 0) {
          this.snapshot = {
            currentVersion: this.currentVersion,
            available: true,
            releaseUrl: stable.url,
            latestVersion: stable.tag,
          }
        } else {
          // Up to date. Clear any previous "available" state so a host
          // restart after an upgrade immediately stops showing the hint.
          this.snapshot = {
            currentVersion: this.currentVersion,
            available: false,
            releaseUrl: null,
            latestVersion: null,
          }
        }
      } catch (error) {
        this.log('update check failed: ' + (error instanceof Error ? error.message : String(error)))
        // Leave the previous snapshot in place. Even "no answer" is a
        // worse signal than the last successful check.
      }
    })()
    this.inflight = task.finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** No-op kept for API symmetry with the host lifecycle wiring. */
  dispose(): void {
    // The initial-delay timer is unref'd; nothing to track here.
  }
}
