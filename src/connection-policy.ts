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

export function sanitizeDeviceField(value: unknown, maxChars: number): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxChars)
}

/**
 * Runtime shape guard for a frame after JSON.parse. The old `as Envelope`
 * cast alone let JSON `null` reach `env.v` and let a missing or mistyped
 * `type` reach `requiredScope()`'s string operations — one anonymous frame
 * could crash the host process. Reject anything that is not a plain object
 * with a numeric version and a non-empty string type, so field access below
 * is always safe. The payload is intentionally opaque here; each handler
 * validates its own payload shape.
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

export function requiredScope(type: string): DeviceScope | undefined {
  // Defense in depth: callers must pass the validated envelope's `type`, but
  // a non-string value must never reach the startsWith checks below.
  if (typeof type !== 'string') return undefined
  if (type === 'c2s.ping' || type === 'c2s.resume') return undefined
  if (type === 'c2s.session.sendPrompt' || type === 'c2s.session.delivery') return 'prompt.send'
  if (type === 'c2s.pending.list') return 'interactions.respond'
  if (type === 'c2s.approval.respond' || type === 'c2s.question.respond') return 'interactions.respond'
  if (type === 'c2s.liveActivity.register' || type === 'c2s.liveActivity.unregister') return 'notifications.register'
  if (type === 'c2s.push.register' || type === 'c2s.widget.push.register') return 'notifications.register'
  if (
    type === 'c2s.workspace.create' ||
    type === 'c2s.session.create' ||
    type === 'c2s.session.rename' ||
    type === 'c2s.session.archive' ||
    type === 'c2s.session.cancel' ||
    type === 'c2s.session.selectModel'
  ) return 'sessions.manage'
  if (type.startsWith('c2s.')) return 'sessions.read'
  return undefined
}

/** Broadcast and replay authorization. Unknown frame types fail closed. */
const PUSH_SCOPE_BY_TYPE: Partial<Record<string, DeviceScope>> = {
  's2c.session.event': 'sessions.read',
  's2c.sessions.delta': 'sessions.read',
  's2c.session.tail': 'sessions.read',
  's2c.history.page': 'sessions.read',
  's2c.pending.approval': 'interactions.respond',
  's2c.pending.question': 'interactions.respond',
  's2c.pending.cleared': 'interactions.respond',
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

export const ERROR_CODES = {
  E_AUTH: 'device proof missing or invalid',
  E_FORBIDDEN: 'device scope does not allow this operation',
  E_PROTOCOL: 'unknown type or malformed payload',
  E_NOT_FOUND: 'session or request not found',
  E_BUSY: 'session is busy',
  E_UNSUPPORTED: 'protocol version or capability unsupported',
  E_INTERNAL: 'internal error',
} as const

/** Error code for a failed approval/question response outcome. */
export function pendingResponseErrorCode(reason: 'not-pending' | 'bad-response' | 'transport'): keyof typeof ERROR_CODES {
  switch (reason) {
    case 'not-pending': return 'E_NOT_FOUND'
    // The host refused the answer batch (shape/labels mismatch) — a client
    // payload problem, not a missing pending request.
    case 'bad-response': return 'E_PROTOCOL'
    case 'transport': return 'E_INTERNAL'
  }
}

/** Human-readable failure detail; `question not pending` must only ever mean
 * "nothing pending", never "the host rejected the answer". */
export function pendingResponseMessage(
  kind: 'approval' | 'question',
  reason: 'not-pending' | 'bad-response' | 'transport',
): string {
  switch (reason) {
    case 'not-pending': return kind + ' not pending'
    case 'bad-response': return kind + ' answer rejected by host: answer does not match the asked questions'
    case 'transport': return 'host connection failed while answering ' + kind
  }
}

export function managementErrorCode(
  kind: 'unsupported' | 'not-found' | 'busy' | 'invalid' | 'internal',
): keyof typeof ERROR_CODES {
  switch (kind) {
    case 'unsupported': return 'E_UNSUPPORTED'
    case 'not-found': return 'E_NOT_FOUND'
    case 'busy': return 'E_BUSY'
    case 'invalid': return 'E_PROTOCOL'
    case 'internal': return 'E_INTERNAL'
  }
}
