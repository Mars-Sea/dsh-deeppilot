import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

export interface PhoneServerHandlers {
  health(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  pair(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

/**
 * A deliberately narrow transport listener. Both the LAN endpoint and the
 * loopback-only Funnel origin use this factory, so neither can accidentally
 * inherit DSH's wider web/API route surface.
 */
export function createPhoneServer(handlers: PhoneServerHandlers): Server {
  const server = createServer((req, res) => {
    const path = requestPath(req)
    if (path === '/phone/health') {
      void handlers.health(req, res)
    } else if (path === '/phone/pair') {
      void handlers.pair(req, res)
    } else {
      res.statusCode = 404
      res.end('not found')
    }
  })
  server.on('upgrade', (req, socket, head) => {
    if (requestPath(req) !== '/phone') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    handlers.upgrade(req, socket, head)
  })
  return server
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://phone.local').pathname
  } catch {
    return '/'
  }
}

export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

export function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}
