import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const PAIRING_CODE_TTL_MS = 5 * 60_000
export const AUTH_CHALLENGE_TTL_MS = 30_000

export const DEVICE_SCOPES = [
  'sessions.read',
  'prompt.send',
  'sessions.manage',
  'interactions.respond',
  'notifications.register',
] as const

export type DeviceScope = (typeof DEVICE_SCOPES)[number]

export const DEFAULT_DEVICE_SCOPES: readonly DeviceScope[] = DEVICE_SCOPES

export interface PairingGrant {
  code: string
  expiresAt: number
  audience?: string
}

export async function loadOrCreateHostAudience(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim()
    if (/^deeppilot:[A-Za-z0-9_-]{22}$/.test(existing)) return existing
    throw new Error(`host audience is malformed at ${path}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const audience = 'deeppilot:' + randomBytes(16).toString('base64url')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, audience + '\n', { mode: 0o600 })
  return audience
}

export interface AuthChallenge {
  nonce: string
  audience: string
  issuedAt: number
  expiresAt: number
}

export interface AuthProofFields extends AuthChallenge {
  deviceId: string
  deviceName: string
  appVersion: string
  resumeCursor?: number
}

function b64urlText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * Cross-language signature input. Text fields are base64url encoded before
 * joining so names cannot create ambiguous separators. Decimal timestamps
 * and cursor values are finite integers, or `-` when the cursor is absent.
 */
export function canonicalAuthChallenge(fields: AuthProofFields): Buffer {
  const cursor = fields.resumeCursor === undefined ? '-' : String(fields.resumeCursor)
  return Buffer.from([
    'deeppilot-auth-v2',
    `device-id:${b64urlText(fields.deviceId)}`,
    `nonce:${fields.nonce}`,
    `audience:${b64urlText(fields.audience)}`,
    `issued-at:${fields.issuedAt}`,
    `expires-at:${fields.expiresAt}`,
    `device-name:${b64urlText(fields.deviceName)}`,
    `app-version:${b64urlText(fields.appVersion)}`,
    `resume-cursor:${cursor}`,
  ].join('\n'), 'utf8')
}

/** Accept only an uncompressed ANSI X9.63 P-256 public key (65 bytes). */
export function parseP256PublicKey(encoded: string): { key: KeyObject; raw: Buffer } {
  const raw = Buffer.from(encoded, 'base64url')
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new TypeError('publicKey must be an uncompressed P-256 X9.63 key')
  }
  // SubjectPublicKeyInfo prefix for id-ecPublicKey / prime256v1 followed by
  // the 65-byte uncompressed point.
  const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new TypeError('publicKey must use P-256')
  }
  return { key, raw }
}

export function deviceIdForPublicKey(publicKey: string): string {
  const { raw } = parseP256PublicKey(publicKey)
  return createHash('sha256').update(raw).digest('base64url')
}

export function fingerprintForPublicKey(publicKey: string): string {
  const { raw } = parseP256PublicKey(publicKey)
  return createHash('sha256').update(raw).digest('hex')
}

export function verifyAuthProof(publicKey: string, fields: AuthProofFields, signature: string): boolean {
  try {
    const { key } = parseP256PublicKey(publicKey)
    const der = Buffer.from(signature, 'base64url')
    if (der.length < 64 || der.length > 80) return false
    return verify('sha256', canonicalAuthChallenge(fields), key, der)
  } catch {
    return false
  }
}

export function normalizeDeviceScopes(value: unknown): DeviceScope[] {
  if (!Array.isArray(value)) return [...DEFAULT_DEVICE_SCOPES]
  const allowed = new Set<string>(DEVICE_SCOPES)
  return [...new Set(value.filter((scope): scope is DeviceScope => typeof scope === 'string' && allowed.has(scope)))]
}

/** One active, single-use pairing grant per plugin runtime. */
export class PairingCodeManager {
  private active: PairingGrant | null = null

  issue(now = Date.now()): PairingGrant {
    const grant = {
      code: randomBytes(24).toString('base64url'),
      expiresAt: now + PAIRING_CODE_TTL_MS,
    }
    this.active = grant
    return { ...grant }
  }

  consume(presented: string, now = Date.now()): boolean {
    const active = this.active
    if (active === null || now > active.expiresAt) {
      this.active = null
      return false
    }
    const expected = Buffer.from(active.code)
    const actual = Buffer.from(presented)
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual)
    if (matches) this.active = null
    return matches
  }

  invalidate(): void {
    this.active = null
  }
}

export function createAuthChallenge(audience: string, now = Date.now()): AuthChallenge {
  return {
    nonce: randomBytes(24).toString('base64url'),
    audience,
    issuedAt: now,
    expiresAt: now + AUTH_CHALLENGE_TTL_MS,
  }
}
