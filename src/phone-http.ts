import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = JSON.stringify({ error: reason })
  const statusText: Record<number, string> = {
    401: 'Unauthorized',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
  }
  const authenticate = status === 401 ? 'WWW-Authenticate: Bearer realm="deeppilot"\r\n' : ''
  socket.end(
    'HTTP/1.1 ' + status + ' ' + (statusText[status] ?? 'Error') + '\r\n' +
    authenticate +
    'Content-Type: application/json\r\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
    'Connection: close\r\n' +
    '\r\n' +
    body,
  )
}

/** Authorization is preferred; the query form remains for older app builds. */
export function requestToken(req: Pick<IncomingMessage, 'url' | 'headers'>): string | null {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1]
  }
  try {
    return new URL(req.url ?? '/', 'http://phone.local').searchParams.get('token')
  } catch {
    return null
  }
}
