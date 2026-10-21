import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Duplex } from 'node:stream'

export interface PhoneServerHandlers {
  health(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  pair(req: IncomingMessage, res: ServerResponse): void | Promise<void>
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
}

export interface PhoneServerTls {
  key: string
  cert: string
}

/** 传输层错误：TLS 握手失败，或 HTTP 报文解析失败。 */
export interface PhoneServerTransportError {
  kind: 'tls-client-error' | 'client-error'
  /** 原始错误对象；调用方负责脱敏，不直接落日志。 */
  error: unknown
  /** 对端地址（原始值）；调用方必须哈希后再记录。 */
  remoteAddress: string | undefined
}

export interface PhoneServerOptions {
  /**
   * 传输层错误出口。缺省时不挂监听，保持 Node 默认行为。
   * 这两类错误此前完全静默：手机证书不对时浏览器侧只看到 «连接已重置»，
   * 电脑端没有任何一行日志，无法区分「证书钉住失败」与「端口没开」。
   */
  onTransportError?: (event: PhoneServerTransportError) => void
}

interface ErrorSocket {
  remoteAddress?: string | undefined
  destroy(): void
}

/**
 * A deliberately narrow transport listener. Both the LAN endpoint and the
 * loopback-only Funnel origin use this factory, so neither can accidentally
 * inherit DSH's wider web/API route surface.
 *
 * With `tls` the listener speaks HTTPS/WSS only (the LAN posture); without
 * it the listener is plain HTTP, which is reserved for the loopback Funnel
 * origin where tailscaled terminates TLS.
 */
export function createPhoneServer(
  handlers: PhoneServerHandlers,
  tls?: PhoneServerTls,
  options?: PhoneServerOptions,
): Server {
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const path = requestPath(req)
    if (path === '/phone/health') {
      void handlers.health(req, res)
    } else if (path === '/phone/pair') {
      void handlers.pair(req, res)
    } else {
      res.statusCode = 404
      res.end('not found')
    }
  }
  const server: Server = tls === undefined
    ? createHttpServer(onRequest)
    : createHttpsServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, onRequest)
  server.on('upgrade', (req, socket, head) => {
    if (requestPath(req) !== '/phone') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    handlers.upgrade(req, socket, head)
  })
  const onTransportError = options?.onTransportError
  if (onTransportError !== undefined) {
    // TLS 握手失败（证书钉住不符、客户端版本过旧……）。
    if (tls !== undefined) {
      const tlsServer = server as unknown as {
        on(event: 'tlsClientError', listener: (error: Error, socket: ErrorSocket) => void): unknown
      }
      tlsServer.on('tlsClientError', (error, socket) => {
        onTransportError({ kind: 'tls-client-error', error, remoteAddress: socket.remoteAddress })
        socket.destroy()
      })
    }
    // HTTP 报文层错误（畸形请求行 / 头）。挂上监听即接管 Node 的默认
    // 400 响应，因此必须自己收尾；直接销毁，不向未认证对端多写一个字节。
    server.on('clientError', (error: Error, socket: ErrorSocket) => {
      onTransportError({ kind: 'client-error', error, remoteAddress: socket.remoteAddress })
      socket.destroy()
    })
  }
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
