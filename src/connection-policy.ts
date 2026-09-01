import type { DeviceScope } from './device-auth.ts'

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

export function requiredScope(type: string): DeviceScope | undefined {
  if (type === 'c2s.ping' || type === 'c2s.resume') return undefined
  if (type === 'c2s.session.sendPrompt') return 'prompt.send'
  if (type === 'c2s.approval.respond' || type === 'c2s.question.respond') return 'interactions.respond'
  if (type === 'c2s.push.register') return 'notifications.register'
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
