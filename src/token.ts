import { randomBytes } from 'node:crypto'
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import {
  deviceIdForPublicKey,
  fingerprintForPublicKey,
  normalizeDeviceScopes,
  type DeviceScope,
} from './device-auth.ts'

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

/** Create or repair the canonical secret-bearing directory as owner-only. */
export async function ensurePrivateBridgeDataDir(): Promise<string> {
  const target = bridgeDataDir()
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  return target
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
  /** Uncompressed P-256 X9.63 public key, base64url encoded. */
  publicKey?: string
  /** SHA-256 fingerprint of publicKey, hex encoded for local display. */
  fingerprint?: string
  scopes?: DeviceScope[]
  revokedAt?: number
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

  /** Register one public key after a valid, single-use pairing grant. */
  register(
    record: { publicKey: string; deviceName: string; appVersion: string; scopes?: unknown },
    now: number,
  ): DeviceRecord {
    const deviceId = deviceIdForPublicKey(record.publicKey)
    const existing = this.devices.get(deviceId)
    if (!existing && this.devices.size >= MAX_DEVICES) {
      throw new Error('device registry is full')
    }
    const next: DeviceRecord = {
      deviceId,
      deviceName: record.deviceName,
      appVersion: record.appVersion,
      publicKey: record.publicKey,
      fingerprint: fingerprintForPublicKey(record.publicKey),
      scopes: normalizeDeviceScopes(record.scopes),
      firstSeenTs: existing?.firstSeenTs ?? now,
      lastSeenTs: now,
      ...(existing?.apns ? { apns: existing.apns } : {}),
    }
    this.devices.set(deviceId, next)
    void this.flush()
    return structuredClone(next)
  }

  /** Return an active cryptographic identity. */
  authorized(deviceId: string): DeviceRecord | undefined {
    const record = this.devices.get(deviceId)
    if (!record?.publicKey || record.revokedAt !== undefined) return undefined
    return record
  }

  markAuthenticated(deviceId: string, deviceName: string, appVersion: string, now: number): void {
    const record = this.authorized(deviceId)
    if (!record) return
    record.deviceName = deviceName || record.deviceName
    record.appVersion = appVersion || record.appVersion
    record.lastSeenTs = now
    void this.flush()
  }

  revoke(deviceId: string, now: number): boolean {
    const record = this.devices.get(deviceId)
    if (!record || record.revokedAt !== undefined) return false
    record.revokedAt = now
    delete record.apns
    void this.flush()
    return true
  }

  setScopes(deviceId: string, scopes: unknown): DeviceScope[] | null {
    const record = this.authorized(deviceId)
    if (!record) return null
    record.scopes = normalizeDeviceScopes(scopes)
    void this.flush()
    return [...record.scopes]
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].map((record) => structuredClone(record))
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
    const record = this.authorized(deviceId)
    if (!record) return
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
      { version: 2, devices: this.list() },
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
