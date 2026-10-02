/**
 * 连接层常量与载荷清洗。
 *
 * 本 module 的职责已经收窄：scope 表随 wire 注册表（每帧一行）迁到
 * wire-registry，错误码映射随错误词表迁到 wire-errors，请求形状校验随行内
 * validate 迁到各特性模块。剩下的都是与帧类型无关的东西——资源上限、
 * 清洗函数、envelope 形状守卫、下行广播权限。
 */

import type { DeviceScope } from './device-auth.ts'
import type { Envelope } from './protocol.ts'

export const AUTH_TIMEOUT_MS = 35_000
export const MAX_OUTBOUND_BUFFER_BYTES = 4 * 1024 * 1024
/**
 * Pre-auth frame cap. The 64 MiB cap on a fully authenticated socket exists
 * to support multi-MB image attachments; before hello the only legal frames
 * are c2s.ping and c2s.auth.prove, neither of which can legitimately exceed
 * a few KB. Capping unauthenticated frames at 64 KiB keeps an anonymous TCP
 * peer from forcing expensive JSON.parse work on a 64 MiB payload inside
 * the 5-second auth window.
 */
export const PRE_AUTH_FRAME_BYTES = 64 * 1024
export const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
export const MAX_PROMPT_IMAGES = 4
export const MAX_BASE64_CHARS_PER_IMAGE = 8 * 1024 * 1024
export const MAX_PROMPT_DOCUMENTS = 4
export const MAX_DOCUMENT_TEXT_CHARS = 256 * 1024
export const MAX_DOCUMENT_NAME_CHARS = 180
export const MAX_DOCUMENT_MEDIA_TYPE_CHARS = 120
/** Bounds a single prompt's text; the frame itself is capped by ws maxPayload. */
export const MAX_PROMPT_TEXT_CHARS = 256 * 1024
// Client-supplied identity fields land in logs and devices-v2.json — keep them
// short and free of control characters so they can neither flood the registry
// nor forge log lines.
export const MAX_DEVICE_ID_CHARS = 128
export const MAX_DEVICE_NAME_CHARS = 64
export const MAX_APP_VERSION_CHARS = 32

/**
 * clientSendId / clientRequestId 的形态：13 位纪元前缀 + UUID。
 * wire 层据此校验载荷，journal 侧据此守卫（见 dispatch-journal.ts）。
 */
export function validSendId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

export function sanitizeDeviceField(value: unknown, maxChars: number): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxChars)
}

/**
 * Runtime shape guard for a frame after JSON.parse. The old `as Envelope`
 * cast alone let JSON `null` reach `env.v` and let a missing or mistyped
 * `type` reach the registry lookup's string operations — one anonymous frame
 * could crash the host process. Reject anything that is not a plain object
 * with a numeric version and a non-empty string type, so field access below
 * is always safe. The payload is intentionally opaque here; each row
 * validates its own payload shape (see the per-row `validate` in
 * wire-registry.ts).
 */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  if (typeof frame.v !== 'number') return false
  if (typeof frame.type !== 'string' || frame.type.length === 0) return false
  if (frame.id !== undefined && typeof frame.id !== 'string') return false
  if (frame.ts !== undefined && typeof frame.ts !== 'number') return false
  if (frame.seq !== undefined && typeof frame.seq !== 'number') return false
  return true
}

/**
 * 下行广播与重放授权。未知帧类型 fail-closed：不下发。
 *
 * `s2c.session.tail` 与 `s2c.history.page` 是 PROTOCOL.md 下行权限表里的类型，
 * 但由连接点对点直推（不经 record()/重放环）。条目保留：将来任何把它们送进
 * ring 的路径都会自动受到这里的 gate 约束，而不是静默全量广播。
 */
const PUSH_SCOPE_BY_TYPE: Partial<Record<string, DeviceScope>> = {
  's2c.session.event': 'sessions.read',
  's2c.sessions.delta': 'sessions.read',
  's2c.session.tail': 'sessions.read',
  's2c.history.page': 'sessions.read',
  's2c.pending.approval': 'interactions.respond',
  's2c.pending.question': 'interactions.respond',
  's2c.pending.cleared': 'interactions.respond',
  's2c.schedule.changed': 'schedule.manage',
}

export function pushScopeFor(type: string, payload?: unknown): DeviceScope | undefined {
  const fixed = PUSH_SCOPE_BY_TYPE[type]
  if (fixed !== undefined) return fixed
  if (type === 's2c.notify') {
    const category = (payload as { category?: unknown } | undefined)?.category
    if (category === 'approval.required' || category === 'question.asked') return 'interactions.respond'
    if (category === 'turn.completed' || category === 'session.error') return 'sessions.read'
  }
  return undefined
}

export function sanitizeImageName(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 120)
}

export function sanitizeDocumentField(value: string, maxChars: number): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxChars)
}
