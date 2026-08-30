import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'

export const CLIENT_IP_HEADER = 'x-deeppilot-client-ip'

export function rejectUpgrade(socket: Duplex, status: number, reason: string, retryAfterSeconds?: number): void {
  const body = JSON.stringify({ error: reason })
  const statusText: Record<number, string> = {
    401: 'Unauthorized',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
  }
  const authenticate = status === 401 ? 'WWW-Authenticate: Bearer realm="deeppilot"\r\n' : ''
  const retryAfter = status === 429 && retryAfterSeconds !== undefined
    ? `Retry-After: ${Math.max(1, Math.ceil(retryAfterSeconds))}\r\n`
    : ''
  socket.end(
    'HTTP/1.1 ' + status + ' ' + (statusText[status] ?? 'Error') + '\r\n' +
    authenticate +
    retryAfter +
    'Content-Type: application/json\r\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
    'Connection: close\r\n' +
    '\r\n' +
    body,
  )
}

/** Credentials are accepted only from the Authorization header. */
export function requestToken(req: Pick<IncomingMessage, 'url' | 'headers'>): string | null {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1]
  }
  return null
}

function normalizedAddress(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.startsWith('::ffff:') ? value.slice(7) : value
  return isIP(normalized) === 0 ? null : normalized
}

function isLoopback(value: string | undefined): boolean {
  const address = normalizedAddress(value)
  return address === '127.0.0.1' || address === '::1'
}

/**
 * Resolve a stable rate-limit key. The helper-supplied address is trusted only
 * on the private loopback hop; direct clients cannot spoof it.
 */
export function requestClientIdentity(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
): string {
  if (isLoopback(req.socket.remoteAddress)) {
    const forwarded = req.headers[CLIENT_IP_HEADER]
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
    const address = normalizedAddress(value)
    if (address !== null) return address
  }
  return normalizedAddress(req.socket.remoteAddress) ?? 'unknown'
}
