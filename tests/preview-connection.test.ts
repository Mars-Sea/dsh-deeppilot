/**
 * 预览连接（clientRole: "preview"）在 BridgeConnection 上的整条链路：
 * 认证 → 角色限制 → 授权（含会话历史核对）→ 打开通道 → 二进制数据帧上下行。
 *
 * 转发细节（窗口、压缩、关闭原因）由 preview-tunnel.test.ts 覆盖；这里钉住的是
 * 连接层的接线：哪些帧在哪种连接上可用、二进制帧走哪条路径、预览连接不改设备状态。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { BridgeConnection } from '../src/connection.ts'
import { HostBridge, type ApiProxyLike } from '../src/host-bridge.ts'
import { DeviceStore } from '../src/token.ts'
import { decodeBinaryFrame, encodeBinaryFrame } from '../src/binary-frame.ts'
import type { DeviceScope } from '../src/device-auth.ts'
import type { HostWebEntry } from '../src/host-web.ts'
import { authenticateTestSocket, createTestIdentity, registerTestIdentity } from './auth-fixture.ts'

/** 只实现 BridgeConnection 用到的 ws 面；二进制下行解成 {header..., body}。 */
class FakeWebSocket {
  OPEN = 1
  readyState = 1
  bufferedAmount = 0
  sent: any[] = []
  closes: Array<{ code: number | undefined; reason: string }> = []
  private handlers = new Map<string, (...args: unknown[]) => void>()

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.set(event, handler)
  }

  send(data: string | Buffer): void {
    if (typeof data === 'string') return void this.sent.push(JSON.parse(data))
    const decoded = decodeBinaryFrame(data)
    assert.ok(decoded, 'binary frame must decode')
    this.sent.push({ ...(decoded.header as object), body: decoded.body })
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return
    this.closes.push({ code, reason: reason ?? '' })
    this.readyState = 3
    this.handlers.get('close')?.(code)
  }

  terminate(): void {
    this.readyState = 3
    this.handlers.get('close')?.(1006)
  }

  receive(payload: unknown): void {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(payload)), false)
  }

  receiveBinary(header: object, body: Uint8Array): void {
    this.handlers.get('message')?.(encodeBinaryFrame(header, body), true)
  }
}

/** 会话历史里出现过 `mentioned` 这段文本（一条助手消息）。 */
function makeProxy(mentioned: string): ApiProxyLike {
  return {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async (request: any) => request.payload.sessionId === 'missing'
        ? { result: { ok: false, error: { code: 'not_found' } } }
        : { result: { ok: true, value: { hasMore: false, events: [
            { event: { seq: 1, type: 'message', payload: { role: 'assistant', text: `画布已启动：${mentioned}/design/` } } },
          ] } } },
      prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
      create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      attachment: async () => ({ result: { ok: true, value: { data: '' } } }),
      projections: async () => ({ result: { ok: true, value: null } }),
    },
    respond: async () => ({ accepted: true }),
    events: {
      mux: async function* () { await new Promise(() => {}) },
      host: async function* () { await new Promise(() => {}) },
    },
  } as unknown as ApiProxyLike
}

async function makeConnection(opts: {
  mentioned?: string
  scopes?: DeviceScope[]
  enabled?: () => boolean
  /** 电脑端网页相关的预览依赖（开关与登录地址），缺省不提供。 */
  hostWeb?: { isHostWebEnabled?: () => boolean; hostWeb?: () => HostWebEntry | undefined }
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pbb-preview-'))
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  const identity = createTestIdentity()
  registerTestIdentity(store, identity)
  if (opts.scopes) store.setScopes(identity.deviceId, opts.scopes)
  const ws = new FakeWebSocket()
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const connection = new BridgeConnection(ws as never, {
    bridge: new HostBridge(makeProxy(opts.mentioned ?? '127.0.0.1:1'), 100),
    devices: store,
    serverVersion: 'test',
    audience: 'deeppilot:test-audience',
    log: () => {},
    preview: { isEnabled: opts.enabled ?? (() => true), reservedPorts: () => [3098], ...opts.hostWeb },
    onClosed: () => {
      void store.drain().then(() => rm(dir, { recursive: true, force: true })).catch(() => {}).finally(resolveClosed)
    },
  })
  const last = () => ws.sent[ws.sent.length - 1]
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
  return { ws, connection, store, identity, closed, last, settle,
    authenticate: (clientRole?: 'preview') => authenticateTestSocket(ws, identity, clientRole ? { clientRole, deviceName: 'Preview' } : {}) }
}

async function echoServer() {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); for (const s of sockets) s.destroy() }),
  }
}

test('主连接 welcome 声明 localPreview 但不列出 preview.open；预览连接的 welcome 列出', async () => {
  // 早期 App 严格解码 welcome.scopes，见到未知值会断连；权限只在预览连接上告知。
  const main = await makeConnection()
  main.authenticate()
  const welcome = main.ws.sent.find((f) => f.type === 's2c.welcome')
  assert.equal(welcome.payload.capabilities.localPreview, true)
  assert.equal(welcome.payload.scopes.includes('preview.open'), false)
  assert.equal(welcome.payload.capabilities.hostWeb, true)
  assert.equal(welcome.payload.scopes.includes('hostweb.open'), false)
  assert.ok(welcome.payload.scopes.includes('sessions.read'))
  main.ws.close()
  await main.closed

  const preview = await makeConnection()
  preview.authenticate('preview')
  assert.ok(preview.last().payload.scopes.includes('preview.open'))
  assert.ok(preview.last().payload.scopes.includes('hostweb.open'))
  preview.ws.close()
  await preview.closed
})

test('预览连接只收 ping 与 c2s.preview.*，不改设备名、不压推送、不订阅广播', async () => {
  const h = await makeConnection()
  h.authenticate('preview')
  assert.equal(h.last().type, 's2c.welcome')
  assert.equal(h.last().payload.resumed, false)
  assert.equal(h.connection.suppressesAlertPush, false, '预览连接在线不代表用户在看会话')
  assert.equal(h.store.authorized(h.identity.deviceId)?.deviceName, 'iPhone', '预览连接不改设备名')

  for (const type of ['c2s.sessions.list', 'c2s.session.sendPrompt', 'c2s.resume', 'c2s.nope']) {
    h.ws.receive({ v: 2, type, id: type, payload: {} })
    assert.equal(h.last().payload.code, 'E_FORBIDDEN', type)
    assert.equal(h.last().payload.message, 'preview connection only carries preview frames')
  }
  h.ws.receive({ v: 2, type: 'c2s.ping', id: 'p', payload: null })
  assert.equal(h.last().type, 's2c.pong')
  h.ws.close()
  await h.closed
})

test('主连接上的预览帧与二进制帧被拒，连接不断', async () => {
  const h = await makeConnection()
  h.authenticate()
  h.ws.receive({ v: 2, type: 'c2s.preview.authorize', id: 'a', payload: { sessionId: 's', url: 'http://127.0.0.1:4720/' } })
  await h.settle()
  assert.equal(h.last().payload.code, 'E_FORBIDDEN')
  assert.equal(h.last().payload.message, 'preview connection required')
  h.ws.receiveBinary({ v: 2, type: 'c2s.preview.data', payload: { streamId: 1 } }, Buffer.from('x'))
  await h.settle()
  assert.equal(h.last().type, 's2c.error', '主连接的二进制帧仍按旧路径拒绝')
  assert.deepEqual(h.ws.closes, [])
  h.ws.close()
  await h.closed
})

test('没有 preview.open 权限的设备不能授权，也不能发数据帧', async () => {
  const h = await makeConnection({ scopes: ['sessions.read'] })
  h.authenticate('preview')
  h.ws.receive({ v: 2, type: 'c2s.preview.authorize', id: 'a', payload: { sessionId: 's', url: 'http://127.0.0.1:4720/' } })
  await h.settle()
  assert.equal(h.last().payload.code, 'E_FORBIDDEN')
  h.ws.receiveBinary({ v: 2, type: 'c2s.preview.data', payload: { streamId: 1 } }, Buffer.from('x'))
  assert.equal(h.last().payload.message, 'scope preview.open required')
  h.ws.close()
  await h.closed
})

test('授权按会话历史核对；打开通道后二进制数据双向转发', async () => {
  const echo = await echoServer()
  const h = await makeConnection({ mentioned: `127.0.0.1:${echo.port}` })
  try {
    h.authenticate('preview')
    h.ws.receive({ v: 2, type: 'c2s.preview.authorize', id: 'other', payload: { sessionId: 's', url: 'http://127.0.0.1:4720/' } })
    await h.settle()
    assert.equal(h.last().payload.reason, 'not-mentioned', '消息里没出现过的端口不放行')
    h.ws.receive({ v: 2, type: 'c2s.preview.authorize', id: 'gone', payload: { sessionId: 'missing', url: `http://127.0.0.1:${echo.port}/` } })
    await h.settle()
    assert.equal(h.last().payload.reason, 'session-not-found')

    h.ws.receive({ v: 2, type: 'c2s.preview.authorize', id: 'a', payload: { sessionId: 's', url: `http://127.0.0.1:${echo.port}/design/` } })
    await h.settle()
    assert.equal(h.last().type, 's2c.preview.authorized')
    assert.equal(h.last().id, 'a')
    assert.deepEqual(h.last().payload, { port: echo.port, origin: `http://127.0.0.1:${echo.port}` })

    h.ws.receive({ v: 2, type: 'c2s.preview.open', id: 'o', payload: { streamId: 5, port: echo.port } })
    await h.settle()
    assert.equal(h.last().type, 's2c.preview.opened')

    const text = Buffer.alloc(4096, 'echo ')
    h.ws.receiveBinary({ v: 2, type: 'c2s.preview.data', payload: { streamId: 5 } }, text)
    await h.settle()
    const data = h.ws.sent.filter((f) => f.type === 's2c.preview.data')
    const received = Buffer.concat(data.map((f) => (f.payload.z ? inflateRawSync(f.body) : f.body)))
    assert.ok(received.equals(text), '回显内容逐字节一致')
    assert.ok(h.ws.sent.some((f) => f.type === 's2c.preview.credit' && f.payload.bytes === text.length), '上行写入后归还额度')

    h.ws.receiveBinary({ v: 2, type: 'c2s.preview.data', payload: { streamId: 'x' } }, text)
    assert.equal(h.last().payload.message, 'malformed preview data frame')
  } finally {
    h.ws.close()
    await h.closed
    await echo.close()
  }
})

test('设置页关闭本机预览后授权回 disabled', async () => {
  const h = await makeConnection({ enabled: () => false })
  h.authenticate('preview')
  h.ws.receive({ v: 2, type: 'c2s.preview.authorize', id: 'a', payload: { sessionId: 's', url: 'http://127.0.0.1:4720/' } })
  await h.settle()
  assert.equal(h.last().payload.reason, 'disabled')
  h.ws.close()
  await h.closed
})

const HOST_WEB_ENTRY: HostWebEntry = {
  target: { hostname: '127.0.0.1', port: 3080, origin: 'http://127.0.0.1:3080', mention: '127.0.0.1:3080', connectHosts: ['127.0.0.1'] },
  url: 'http://127.0.0.1:3080/?token=secret',
}

test('c2s.preview.hostWeb 经预览连接下发登录地址；缺 hostweb.open 的设备回 hostweb-forbidden', async () => {
  const h = await makeConnection({ hostWeb: { isHostWebEnabled: () => true, hostWeb: () => HOST_WEB_ENTRY } })
  h.authenticate('preview')
  h.ws.receive({ v: 2, type: 'c2s.preview.hostWeb', id: 'w', payload: {} })
  await h.settle()
  assert.equal(h.last().type, 's2c.preview.hostWeb')
  assert.equal(h.last().id, 'w')
  assert.deepEqual(h.last().payload, { port: 3080, origin: 'http://127.0.0.1:3080', url: 'http://127.0.0.1:3080/?token=secret' })
  h.ws.close()
  await h.closed

  const narrow = await makeConnection({
    scopes: ['sessions.read', 'preview.open'],
    hostWeb: { isHostWebEnabled: () => true, hostWeb: () => HOST_WEB_ENTRY },
  })
  narrow.authenticate('preview')
  narrow.ws.receive({ v: 2, type: 'c2s.preview.hostWeb', id: 'w', payload: {} })
  await narrow.settle()
  assert.equal(narrow.last().payload.reason, 'hostweb-forbidden')
  narrow.ws.close()
  await narrow.closed
})

test('电脑端网页开关缺省关闭：hostWeb 回 hostweb-disabled，主连接上的 hostWeb 帧被拒', async () => {
  const h = await makeConnection({ hostWeb: { hostWeb: () => HOST_WEB_ENTRY } })
  h.authenticate('preview')
  h.ws.receive({ v: 2, type: 'c2s.preview.hostWeb', id: 'w', payload: {} })
  await h.settle()
  assert.equal(h.last().payload.reason, 'hostweb-disabled')
  h.ws.close()
  await h.closed

  const main = await makeConnection({ hostWeb: { isHostWebEnabled: () => true, hostWeb: () => HOST_WEB_ENTRY } })
  main.authenticate()
  main.ws.receive({ v: 2, type: 'c2s.preview.hostWeb', id: 'w', payload: {} })
  await main.settle()
  assert.equal(main.last().type, 's2c.error')
  assert.equal(main.ws.sent.some((f) => f.type === 's2c.preview.hostWeb'), false)
  main.ws.close()
  await main.closed
})

test('sessionMentions 向前翻页查找，读取失败返回 null，翻到头返回 false', async () => {
  const pages: Array<number | undefined> = []
  const proxy = makeProxy('unused')
  ;(proxy.sessions as any).history = async (request: any) => {
    const beforeSeq = request.payload.beforeSeq as number | undefined
    pages.push(beforeSeq)
    if (request.payload.sessionId === 'broken') throw new Error('boom')
    // 三页：seq 201..300、101..200、1..100；目标文本只在最早一页。
    const top = beforeSeq === undefined ? 300 : beforeSeq - 1
    const events = Array.from({ length: 100 }, (_, i) => ({
      event: { seq: top - i, type: 'message', payload: { text: top - i === 7 ? 'http://localhost:5173/' : 'hi' } },
    }))
    return { result: { ok: true, value: { events, hasMore: top - 99 > 1 } } }
  }
  const bridge = new HostBridge(proxy, 100)
  assert.equal(await bridge.sessionMentions('s', 'localhost:5173'), true)
  assert.deepEqual(pages, [undefined, 201, 101])
  assert.equal(await bridge.sessionMentions('s', 'localhost:9999'), false)
  assert.equal(await bridge.sessionMentions('s', 'localhost:5173', 150), false, '超过扫描上限即停')
  assert.equal(await bridge.sessionMentions('broken', 'x'), null)
})
