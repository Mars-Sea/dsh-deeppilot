import { randomBytes, timingSafeEqual } from 'node:crypto'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

/** Expand a leading ~ using the process home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return p
}

function dshDataRoot(): string {
  const dshHome = process.env.DSH_HOME
  if (dshHome && dshHome.trim().length > 0) return resolve(dshHome.trim())
  return resolve(homedir(), '.dsh')
}

/** DeepPilot data directory: under $DSH_HOME when set, else ~/.dsh. */
export function bridgeDataDir(): string {
  return resolve(dshDataRoot(), 'deeppilot')
}

/**
 * Move the pre-DeepPilot data directory as one atomic directory rename.
 * Existing canonical data always wins; secrets are never merged or replaced.
 */
export async function migrateLegacyBridgeDataDir(): Promise<string | null> {
  const target = bridgeDataDir()
  try {
    await access(target)
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const legacy = resolve(dshDataRoot(), 'pocket-bridge')
  try {
    await rename(legacy, target)
    return legacy
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Load the pairing token from disk or generate and persist a fresh one.
 * The file is written 0600; the token never appears in logs.
 */
export async function loadOrCreateToken(tokenPath: string): Promise<string> {
  const full = expandHome(tokenPath)
  try {
    const existing = (await readFile(full, 'utf8')).trim()
    if (existing.length >= 32) return existing
  } catch {
    // fall through to generation
  }
  const token = randomBytes(32).toString('base64url')
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, token + '\n', { mode: 0o600 })
  return token
}

/**
 * Generate a fresh pairing token and replace the stored one, invalidating
 * every copy of the old secret. The write goes to a same-directory temp file
 * renamed over the target so a crash can never leave a truncated token file.
 */
export async function writeNewToken(tokenPath: string): Promise<string> {
  const full = expandHome(tokenPath)
  const token = randomBytes(32).toString('base64url')
  await mkdir(dirname(full), { recursive: true })
  const temp = `${full}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, token + '\n', { mode: 0o600 })
  await rename(temp, full)
  return token
}

/** Constant-time token comparison; both sides are high-entropy secrets. */
export function tokenMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Burn a same-length comparison so wrong-length probes keep flat timing.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

export type ApnsEnvironment = 'development' | 'production'

/** Per-device APNs registration (F-9 离线推送). The raw token never leaves the registry file. */
export interface DeviceApnsInfo {
  /** Hex device token, lowercased, 32–512 chars. */
  token: string
  environment: ApnsEnvironment
  updatedAt: number
  /** Per-category opt-out mirror; absent keys mean enabled. */
  categories?: Record<string, boolean>
}

export interface DeviceRecord {
  deviceId: string
  deviceName: string
  appVersion: string
  firstSeenTs: number
  lastSeenTs: number
  apns?: DeviceApnsInfo
}

/** Hex shape of an APNs device token as delivered by iOS (usually 64 chars). */
const APNS_TOKEN_PATTERN = /^[0-9a-f]{32,512}$/

export function isValidApnsToken(token: unknown): token is string {
  return typeof token === 'string' && APNS_TOKEN_PATTERN.test(token)
}

/** Registry row cap: hello spam with fresh ids must not grow the file forever. */
export const MAX_DEVICES = 64

/**
 * Paired-device registry persisted as one JSON document. Whole-document
 * writes (serialized, never interleaved); a corrupt file falls back to an
 * empty registry rather than failing the plugin.
 */
export class DeviceStore {
  private devices = new Map<string, DeviceRecord>()
  private flushTail: Promise<void> = Promise.resolve()

  private constructor(private readonly filePath: string) {}

  static async load(filePath: string): Promise<DeviceStore> {
    const store = new DeviceStore(filePath)
    try {
      const raw = JSON.parse(await readFile(expandHome(filePath), 'utf8')) as {
        devices?: DeviceRecord[]
      }
      for (const rec of raw.devices ?? []) {
        if (typeof rec.deviceId === 'string') store.devices.set(rec.deviceId, rec)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        // First run on this home: nothing registered yet — normal.
      } else {
        // A truncated/corrupt registry silently wiping pairings and push
        // registrations would be indistinguishable from "never registered".
        // Make data loss loud so the cause (crash mid-write, disk, …) shows.
        console.log('[deeppilot] device registry unreadable, starting empty: ' + String(error))
      }
    }
    return store
  }

  touch(record: Omit<DeviceRecord, 'firstSeenTs' | 'lastSeenTs'>, now: number): void {
    const existing = this.devices.get(record.deviceId)
    if (existing) {
      existing.lastSeenTs = now
      existing.deviceName = record.deviceName || existing.deviceName
      existing.appVersion = record.appVersion || existing.appVersion
    } else {
      if (this.devices.size >= MAX_DEVICES) {
        // Evict the least-recently-seen device to make room for the newcomer.
        let oldestId: string | undefined
        let oldestTs = Number.POSITIVE_INFINITY
        for (const [id, value] of this.devices) {
          if (value.lastSeenTs < oldestTs) {
            oldestTs = value.lastSeenTs
            oldestId = id
          }
        }
        if (oldestId !== undefined) this.devices.delete(oldestId)
      }
      this.devices.set(record.deviceId, {
        ...record,
        firstSeenTs: now,
        lastSeenTs: now,
      })
    }
    void this.flush()
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()]
  }

  /**
   * Store (or refresh) the APNs registration of a paired device. Idempotent:
   * an unchanged registration does not rewrite the registry file, so the
   * app's re-register-on-every-handshake policy stays write-quiet.
   */
  setPushToken(
    deviceId: string,
    token: string,
    environment: ApnsEnvironment,
    categories: Record<string, boolean> | undefined,
    now: number,
  ): void {
    const normalized = token.toLowerCase()
    if (!isValidApnsToken(normalized)) return
    let record = this.devices.get(deviceId)
    if (!record) {
      // A live authenticated socket always has a row (hello touches it), but
      // a rotation could clear the registry mid-session; self-heal instead of
      // dropping the registration.
      record = { deviceId, deviceName: 'unknown', appVersion: 'unknown', firstSeenTs: now, lastSeenTs: now }
      this.devices.set(deviceId, record)
    }
    const next: DeviceApnsInfo = { token: normalized, environment, updatedAt: now }
    if (categories && typeof categories === 'object') {
      const clean: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(categories)) {
        if (/^[a-z.]{1,64}$/.test(key) && typeof value === 'boolean') clean[key] = value
      }
      if (Object.keys(clean).length > 0) next.categories = clean
    }
    const current = record.apns
    if (
      current &&
      current.token === next.token &&
      current.environment === next.environment &&
      JSON.stringify(current.categories ?? {}) === JSON.stringify(next.categories ?? {})
    ) {
      return
    }
    record.apns = next
    void this.flush()
  }

  /** Drop a device's APNs registration (APNs reported the token unregistered). */
  clearPushToken(deviceId: string): void {
    const record = this.devices.get(deviceId)
    if (!record?.apns) return
    delete record.apns
    void this.flush()
  }

  /**
   * Drop every paired-device record. Used by token rotation: devices paired
   * under the old token can no longer authenticate, so keeping their rows
   * would paint a misleading "still paired" picture.
   */
  clear(): void {
    this.devices.clear()
    void this.flush()
  }

  /** Serialized so concurrent touches can never interleave half-written JSON. */
  private flush(): Promise<void> {
    const next = this.flushTail.then(() => this.writeFile())
    this.flushTail = next.catch(() => {
      // best-effort persistence; the bridge still works without it
    })
    return next
  }

  /** Resolves once every queued registry write has landed (test support). */
  async drain(): Promise<void> {
    await this.flushTail
  }

  private async writeFile(): Promise<void> {
    const full = expandHome(this.filePath)
    const body = JSON.stringify(
      { version: 1, devices: this.list() },
      null,
      2,
    )
    try {
      await mkdir(dirname(full), { recursive: true })
      // Atomic replace: a restart mid-write previously left a truncated JSON
      // behind, which load() treats as corrupt and drops ENTIRELY — losing
      // pairings and push registrations on every unlucky shutdown.
      const temp = `${full}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temp, body + '\n', { mode: 0o600 })
      await rename(temp, full)
    } catch {
      // best-effort persistence; the bridge still works without it
    }
  }
}
