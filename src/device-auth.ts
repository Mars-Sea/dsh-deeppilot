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
import { formatLogLine } from './diagnostics.ts'

export function getPairingCodeTtlMs(): number {
  return Number(process.env.DEEPPILOT_PAIRING_TTL_MS) || 5 * 60_000
}
export const AUTH_CHALLENGE_TTL_MS = 30_000

export const DEVICE_SCOPES = [
  'sessions.read',
  'prompt.send',
  'sessions.manage',
  'interactions.respond',
  'notifications.register',
  'schedule.manage',
  // 本机预览（能力 localPreview，0.9.18 起）：经预览连接访问电脑回环地址上的网页。
  'preview.open',
  // 电脑端网页（能力 hostWeb，0.9.20 起）：经预览连接打开电脑上的 DSH 网页端（所有者权限），
  // 并可授权任意非保留本机端口。另受设置页开关约束，开关默认关闭。
  'hostweb.open',
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
  // 新建 Host 身份意味着 audience 变了：所有此前配对的设备都会在下一步
  // 认证失败（audience-mismatch）。这是「手机突然全部要重新配对」最直接的
  // 证据，必须留一行；只记事实与路径，不记 audience 原文（可被冒充）。
  console.log(formatLogLine('info', 'host identity created: ' + path + ' (previously paired devices must pair again)'))
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

/**
 * 历代「全部权限」。App 配对时一直申请 DeviceScope 的全部取值，设置页也没有收窄权限的
 * 入口，所以存量记录恰好等于某一代全量，只说明「配对时后来的权限还不存在」，不是有意关闭：
 * - 0.8.3 之前：五项，还没有 `schedule.manage`；
 * - 0.9.18 之前：六项，还没有 `preview.open`；
 * - 0.9.20 之前：七项，还没有 `hostweb.open`。
 */
const LEGACY_FULL_SCOPE_SETS: ReadonlyArray<readonly DeviceScope[]> = [
  ['sessions.read', 'prompt.send', 'sessions.manage', 'interactions.respond', 'notifications.register'],
  ['sessions.read', 'prompt.send', 'sessions.manage', 'interactions.respond', 'notifications.register', 'schedule.manage'],
  ['sessions.read', 'prompt.send', 'sessions.manage', 'interactions.respond', 'notifications.register', 'schedule.manage', 'preview.open'],
]

/**
 * 存量设备权限升级：恰好等于某一代全部权限时补齐为当前全部权限，返回新列表；
 * 其余情况（含任何非完整集合）返回 null，原样保留。只放宽「旧版全量」这一种形态，
 * 避免把将来可能出现的、有意收窄过的记录一并放开。
 */
export function upgradeLegacyFullScopes(value: unknown): DeviceScope[] | null {
  if (!Array.isArray(value)) return null
  const current = new Set(value)
  const matches = LEGACY_FULL_SCOPE_SETS.some((legacy) =>
    current.size === legacy.length && legacy.every((scope) => current.has(scope)))
  return matches ? [...DEFAULT_DEVICE_SCOPES] : null
}

/**
 * 只在预览连接的 welcome 里列出的 scope。
 *
 * 为什么：0.9.18 之前发布的 App 把 `welcome.scopes` 严格解码成固定枚举，见到未知值
 * 会判整帧无效、按「插件版本不兼容」停止重连。旧版全量设备载入及配对时会补上 `preview.open`，
 * 若照常列在主连接（及小组件连接）的 welcome 里，插件先升级、App 未升级的用户就会断连。
 * 只有新版 App 才会开预览连接，所以只在那里列出；权限判定本身不受影响。
 * `hostweb.open` 同理：它只在预览连接上用得到，开预览连接的 App 已按字符串宽松解码 scopes。
 */
const PREVIEW_ONLY_WELCOME_SCOPES: ReadonlySet<DeviceScope> = new Set(['preview.open', 'hostweb.open'])

/** welcome 里下发的 scope 列表：非预览连接去掉旧 App 不认识的 `preview.open`、`hostweb.open`。 */
export function welcomeScopes(scopes: Iterable<DeviceScope>, previewClient: boolean): DeviceScope[] {
  const list = [...scopes]
  return previewClient ? list : list.filter((scope) => !PREVIEW_ONLY_WELCOME_SCOPES.has(scope))
}

/** One active, single-use pairing grant per plugin runtime. */
export class PairingCodeManager {
  private active: PairingGrant | null = null

  issue(now = Date.now()): PairingGrant {
    const grant = {
      code: randomBytes(24).toString('base64url'),
      expiresAt: now + getPairingCodeTtlMs(),
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
