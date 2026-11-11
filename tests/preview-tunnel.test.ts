/**
 * 本机预览转发（PreviewTunnel）的行为测试。
 *
 * 用真实的回环 TCP / HTTP 服务器，不用假 socket：转发的核心风险在字节边界、背压和
 * 关闭时序上，假 socket 很容易把这些问题一起「模拟」掉。PreviewTunnel 的出口
 * （send / sendBinary）被替换成记录器，测试直接按协议读回它下发的帧。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { inflateRawSync } from 'node:zlib'
import {
  PREVIEW_INITIAL_WINDOW,
  PREVIEW_MAX_CHUNK,
  PREVIEW_MAX_STREAMS,
  PreviewTunnel,
  type PreviewTunnelDeps,
} from '../src/preview-tunnel.ts'

interface Sent {
  type: string
  payload: any
  id?: string
  body?: Buffer
}

interface Harness {
  tunnel: PreviewTunnel
  sent: Sent[]
  state: { enabled: boolean; writable: boolean; mentioned: boolean | null; reserved: number[] }
  /** 某通道已收到的下行原始字节（已按 z 解压）。 */
  downstream(streamId: number): Buffer
  errors(): Sent[]
}

function makeTunnel(overrides: Partial<PreviewTunnelDeps> = {}): Harness {
  const sent: Sent[] = []
  const state = { enabled: true, writable: true, mentioned: true as boolean | null, reserved: [3098] }
  const tunnel = new PreviewTunnel({
    send: (type, payload, id) => void sent.push({ type, payload, ...(id !== undefined ? { id } : {}) }),
    sendBinary: (type, payload, body) => void sent.push({ type, payload, body: Buffer.from(body) }),
    writable: () => state.writable,
    isEnabled: () => state.enabled,
    reservedPorts: () => state.reserved,
    sessionMentions: async () => state.mentioned,
    ...overrides,
  })
  return {
    tunnel,
    sent,
    state,
    downstream: (streamId) => Buffer.concat(sent
      .filter((f) => f.type === 's2c.preview.data' && f.payload.streamId === streamId)
      .map((f) => (f.payload.z === true ? inflateRawSync(f.body!) : f.body!))),
    errors: () => sent.filter((f) => f.type === 's2c.error'),
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function listen<T extends HttpServer | NetServer>(server: T): Promise<{ server: T; port: number; close: () => Promise<void> }> {
  // 记下服务器侧的每条连接：测试结束时逐条销毁，否则被 pause 的连接读不到 FIN，
  // server.close 会一直等它们，测试进程也就不退出。
  const sockets = new Set<Socket>()
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      for (const socket of sockets) socket.destroy()
    }),
  }
}

/** 拿一个当前没人监听的端口：先占后放。 */
async function freePort(): Promise<number> {
  const probe = await listen(createNetServer())
  await probe.close()
  return probe.port
}

const closedFrame = (h: Harness, streamId: number) =>
  h.sent.find((f) => f.type === 's2c.preview.closed' && f.payload.streamId === streamId)

// ---------- 授权 ----------

test('授权按顺序检查：开关、URL、保留端口、会话读取、会话提及', async () => {
  const h = makeTunnel()
  const reasons: string[] = []
  const attempt = async (url: string) => {
    const before = h.sent.length
    await h.tunnel.authorize('a', 's', url)
    const frame = h.sent[before]!
    reasons.push(frame.type === 's2c.error' ? `${frame.payload.code}/${frame.payload.reason}` : frame.type)
  }

  h.state.enabled = false
  await attempt('http://127.0.0.1:4720/')
  h.state.enabled = true
  await attempt('https://127.0.0.1:4720/')
  await attempt('http://127.0.0.1:3080/')
  await attempt('http://127.0.0.1:3098/')
  h.state.mentioned = null
  await attempt('http://127.0.0.1:4720/')
  h.state.mentioned = false
  await attempt('http://127.0.0.1:4720/')
  h.state.mentioned = true
  await attempt('http://127.0.0.1:4720/design/x')

  assert.deepEqual(reasons, [
    'E_FORBIDDEN/disabled',
    'E_PROTOCOL/bad-url',
    'E_FORBIDDEN/reserved-port',
    'E_FORBIDDEN/reserved-port',
    'E_NOT_FOUND/session-not-found',
    'E_FORBIDDEN/not-mentioned',
    's2c.preview.authorized',
  ])
  const ok = h.sent.at(-1)!
  assert.deepEqual(ok.payload, { port: 4720, origin: 'http://127.0.0.1:4720' })
  assert.equal(ok.id, 'a', '响应带请求 id')
})

test('会话核对用 host:port 原文查找', async () => {
  const needles: string[] = []
  const h = makeTunnel({ sessionMentions: async (_s, needle) => { needles.push(needle); return true } })
  await h.tunnel.authorize('a', 's', 'http://localhost:5173/')
  await h.tunnel.authorize('b', 's', 'http://[::1]:8080/')
  assert.deepEqual(needles, ['localhost:5173', '[::1]:8080'])
})

test('未授权端口不能打开；授权后连不上回 connect-refused', async () => {
  const h = makeTunnel()
  const port = await freePort()
  await h.tunnel.open('o1', 1, port)
  assert.equal(h.errors().at(-1)?.payload.reason, 'not-authorized')
  await h.tunnel.authorize('a', 's', `http://127.0.0.1:${port}/`)
  await h.tunnel.open('o2', 1, port)
  const error = h.errors().at(-1)!
  assert.equal(error.payload.reason, 'connect-refused')
  assert.equal(error.payload.code, 'E_NOT_FOUND')
  assert.equal(error.id, 'o2')
  assert.equal(h.tunnel.streamCount, 0)
})

// ---------- 电脑端网页 ----------

/** 电脑端网页放宽所需的状态：开关、scope 与宿主网页端入口均可在用例里改。 */
function makeHostWebTunnel(entryPort = 3080) {
  const web = { enabled: true, scope: true, available: true }
  const h = makeTunnel({
    isHostWebEnabled: () => web.enabled,
    hasHostWebScope: () => web.scope,
    hostWeb: () => (web.available
      ? {
          target: { hostname: '127.0.0.1' as const, port: entryPort, origin: `http://127.0.0.1:${entryPort}`, mention: `127.0.0.1:${entryPort}`, connectHosts: ['127.0.0.1'] },
          url: `http://127.0.0.1:${entryPort}/?token=secret`,
        }
      : undefined),
  })
  h.state.reserved = [3098, entryPort]
  return { h, web }
}

const lastReason = (h: Harness) => h.errors().at(-1)?.payload.reason

test('hostWeb 入口按顺序检查：本机预览开关、电脑端网页开关、scope、宿主支持', () => {
  const { h, web } = makeHostWebTunnel()
  h.state.enabled = false
  h.tunnel.hostWeb('a')
  assert.equal(lastReason(h), 'disabled')
  h.state.enabled = true
  web.enabled = false
  web.scope = false
  h.tunnel.hostWeb('b')
  assert.equal(lastReason(h), 'hostweb-disabled', '开关关闭优先于缺 scope')
  web.enabled = true
  h.tunnel.hostWeb('c')
  assert.equal(lastReason(h), 'hostweb-forbidden')
  web.scope = true
  web.available = false
  h.tunnel.hostWeb('d')
  const unavailable = h.errors().at(-1)!
  assert.equal(unavailable.payload.reason, 'hostweb-unavailable')
  assert.equal(unavailable.payload.code, 'E_UNSUPPORTED')
  web.available = true
  h.tunnel.hostWeb('e')
  const ok = h.sent.at(-1)!
  assert.equal(ok.type, 's2c.preview.hostWeb')
  assert.equal(ok.id, 'e')
  assert.deepEqual(ok.payload, { port: 3080, origin: 'http://127.0.0.1:3080', url: 'http://127.0.0.1:3080/?token=secret' })
})

test('hostWeb 授权网页端端口（保留端口只能经此入口），日志不带登录令牌', async () => {
  const http = await listen(createHttpServer((_req, res) => res.end('dsh')))
  const logs: string[] = []
  const web = { enabled: true }
  const h = makeTunnel({
    isHostWebEnabled: () => web.enabled,
    hasHostWebScope: () => true,
    hostWeb: () => ({
      target: { hostname: '127.0.0.1' as const, port: http.port, origin: `http://127.0.0.1:${http.port}`, mention: `127.0.0.1:${http.port}`, connectHosts: ['127.0.0.1'] },
      url: `http://127.0.0.1:${http.port}/?token=secret`,
    }),
    log: (message) => void logs.push(message),
  })
  h.state.reserved = [3098, http.port]
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${http.port}/`)
    assert.equal(lastReason(h), 'reserved-port', 'authorize 不能授权网页端端口')
    h.tunnel.hostWeb('w')
    await h.tunnel.open('o1', 1, http.port)
    assert.equal(h.sent.find((f) => f.type === 's2c.preview.opened')?.payload.streamId, 1)
    assert.ok(logs.length > 0)
    assert.ok(logs.every((line) => !line.includes('secret')), '登录令牌不得进日志')

    web.enabled = false
    await h.tunnel.open('o2', 2, http.port)
    assert.equal(lastReason(h), 'hostweb-disabled', '开关关闭后不能再开新通道')
    h.tunnel.data(1, Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n'))
    assert.deepEqual(closedFrame(h, 1)!.payload, { streamId: 1, reason: 'disabled' }, '已开通道在下一批数据时断开')
  } finally {
    h.tunnel.dispose()
    await http.close()
  }
})

test('电脑端网页放宽：不带 sessionId 或会话没提及也放行；条件不满足时退回原有判定', async () => {
  const { h, web } = makeHostWebTunnel()
  h.state.mentioned = false
  await h.tunnel.authorize('a', undefined, 'http://127.0.0.1:4720/')
  assert.deepEqual(h.sent.at(-1)!.payload, { port: 4720, origin: 'http://127.0.0.1:4720' })
  await h.tunnel.authorize('b', 's', 'http://127.0.0.1:4721/')
  assert.equal(h.sent.at(-1)!.type, 's2c.preview.authorized', '会话没提及的端口也放行')
  await h.tunnel.authorize('c', undefined, 'http://127.0.0.1:3080/')
  assert.equal(lastReason(h), 'reserved-port', '放宽不越过保留端口')

  web.scope = false
  await h.tunnel.authorize('d', undefined, 'http://127.0.0.1:4722/')
  assert.equal(lastReason(h), 'hostweb-forbidden')
  await h.tunnel.authorize('e', 's', 'http://127.0.0.1:4722/')
  assert.equal(lastReason(h), 'not-mentioned', '带 sessionId 时退回会话核对的原因')
  web.scope = true
  web.enabled = false
  await h.tunnel.authorize('f', undefined, 'http://127.0.0.1:4722/')
  assert.equal(lastReason(h), 'hostweb-disabled')
  h.state.mentioned = null
  await h.tunnel.authorize('g', 's', 'http://127.0.0.1:4722/')
  assert.equal(lastReason(h), 'session-not-found')
})

test('会话来路的授权不被放宽来路覆盖，关闭电脑端网页开关后仍可用', async () => {
  const tcp = await listen(createNetServer(() => {}))
  const web = { enabled: true }
  const mentions = { value: true }
  const h = makeTunnel({
    isHostWebEnabled: () => web.enabled,
    hasHostWebScope: () => true,
    sessionMentions: async () => mentions.value,
  })
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    await h.tunnel.authorize('b', undefined, `http://127.0.0.1:${tcp.port}/`)
    web.enabled = false
    await h.tunnel.open('o1', 1, tcp.port)
    assert.equal(h.sent.at(-1)!.type, 's2c.preview.opened', 'mention 授权保留，不随开关失效')
    h.tunnel.data(1, Buffer.from('x'))
    assert.equal(closedFrame(h, 1), undefined)
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('dispose 后 hostWeb 静默', () => {
  const { h } = makeHostWebTunnel()
  h.tunnel.dispose()
  h.tunnel.hostWeb('a')
  assert.equal(h.sent.length, 0)
})

// ---------- 数据 ----------

test('HTTP 往返：上行写入后归还额度，下行按窗口发放、压缩、结束发 eof', async () => {
  // 600 KiB 可压缩正文：超过一个窗口，必须靠 credit 才能收完。
  const payload = Buffer.alloc(600 * 1024, 'deeppilot preview ')
  const http = await listen(createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(payload.length) })
    res.end(payload)
  }))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${http.port}/`)
    await h.tunnel.open('o', 7, http.port)
    assert.deepEqual(h.sent.at(-1), { type: 's2c.preview.opened', payload: { streamId: 7 }, id: 'o' })

    const request = Buffer.from(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${http.port}\r\nConnection: close\r\n\r\n`)
    h.tunnel.data(7, request)
    await waitFor(() => h.sent.some((f) => f.type === 's2c.preview.credit'), 'upstream credit')
    assert.deepEqual(h.sent.find((f) => f.type === 's2c.preview.credit')!.payload, { streamId: 7, bytes: request.length })

    // 不给额度时下行停在一个窗口。
    await waitFor(() => h.downstream(7).length === PREVIEW_INITIAL_WINDOW, 'first window')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(h.downstream(7).length, PREVIEW_INITIAL_WINDOW, '窗口用尽后不再下发')
    assert.equal(closedFrame(h, 7), undefined)

    const frames = h.sent.filter((f) => f.type === 's2c.preview.data')
    assert.ok(frames.some((f) => f.payload.z === true), '可压缩内容走压缩')
    for (const frame of frames) {
      const raw = frame.payload.z === true ? inflateRawSync(frame.body!) : frame.body!
      assert.ok(raw.length >= 1 && raw.length <= PREVIEW_MAX_CHUNK, '单帧原始字节在 1..64 KiB')
    }

    // 逐窗口归还额度直到收完。
    while (closedFrame(h, 7) === undefined) {
      h.tunnel.credit(7, PREVIEW_INITIAL_WINDOW)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.deepEqual(closedFrame(h, 7)!.payload, { streamId: 7, reason: 'eof' })
    const text = h.downstream(7).toString('latin1')
    assert.match(text, /^HTTP\/1\.1 200 OK\r\n/)
    assert.ok(h.downstream(7).subarray(text.indexOf('\r\n\r\n') + 4).equals(payload), '正文逐字节一致')
    assert.equal(h.tunnel.streamCount, 0)
  } finally {
    h.tunnel.dispose()
    await http.close()
  }
})

test('已压缩内容不压缩，小块不压缩', async () => {
  const random = Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 2654435761) >>> 24))
  const tcp = await listen(createNetServer((socket) => {
    socket.write(Buffer.from('hi'))
    setTimeout(() => socket.end(random), 10)
  }))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    await h.tunnel.open('o', 1, tcp.port)
    await waitFor(() => closedFrame(h, 1) !== undefined, 'eof')
    const frames = h.sent.filter((f) => f.type === 's2c.preview.data')
    assert.equal(frames[0]!.payload.z, undefined, '2 字节不压缩')
    assert.ok(h.downstream(1).equals(Buffer.concat([Buffer.from('hi'), random])))
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('上行超窗口或超单帧上限按 flow-control 关闭', async () => {
  const sockets: Socket[] = []
  const tcp = await listen(createNetServer((socket) => { sockets.push(socket); socket.pause() }))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    await h.tunnel.open('o1', 1, tcp.port)
    h.tunnel.data(1, Buffer.alloc(PREVIEW_MAX_CHUNK + 1))
    assert.deepEqual(closedFrame(h, 1)!.payload, { streamId: 1, reason: 'flow-control' })

    await h.tunnel.open('o2', 2, tcp.port)
    h.tunnel.data(2, Buffer.alloc(0))
    assert.equal(closedFrame(h, 2)!.payload.reason, 'flow-control', '空数据帧违反协议')

    // 窗口按「已发未归还」计：同步连发 5 个 64 KiB（写回调还没机会归还额度）。
    await h.tunnel.open('o3', 3, tcp.port)
    for (let i = 0; i < 5; i += 1) h.tunnel.data(3, Buffer.alloc(PREVIEW_MAX_CHUNK))
    assert.equal(closedFrame(h, 3)!.payload.reason, 'flow-control')
    assert.equal(h.tunnel.streamCount, 0)
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('并发 open 也受通道上限约束', async () => {
  const tcp = await listen(createNetServer(() => {}))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    // 不逐条等待：全部 open 在任何一条连上之前就已发出。
    await Promise.all(Array.from({ length: PREVIEW_MAX_STREAMS + 8 }, (_, i) => h.tunnel.open('o', i + 1, tcp.port)))
    assert.equal(h.tunnel.streamCount, PREVIEW_MAX_STREAMS)
    assert.equal(h.errors().filter((f) => f.payload.reason === 'too-many-streams').length, 8)
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('通道上限与重复 id', async () => {
  const tcp = await listen(createNetServer(() => {}))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    for (let id = 1; id <= PREVIEW_MAX_STREAMS; id += 1) await h.tunnel.open('o', id, tcp.port)
    assert.equal(h.tunnel.streamCount, PREVIEW_MAX_STREAMS)
    await h.tunnel.open('dup', 1, tcp.port)
    assert.equal(h.errors().at(-1)?.payload.reason, 'duplicate-stream')
    await h.tunnel.open('busy', PREVIEW_MAX_STREAMS + 1, tcp.port)
    const busy = h.errors().at(-1)!
    assert.equal(busy.payload.reason, 'too-many-streams')
    assert.equal(busy.payload.code, 'E_BUSY')
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('手机关闭通道不回帧并断开电脑侧连接；关闭开关后数据触发 disabled', async () => {
  let serverClosed = 0
  const tcp = await listen(createNetServer((socket) => { socket.on('close', () => { serverClosed += 1 }) }))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    await h.tunnel.open('o1', 1, tcp.port)
    await h.tunnel.open('o2', 2, tcp.port)
    h.tunnel.close(1)
    await waitFor(() => serverClosed === 1, 'server side close')
    assert.equal(closedFrame(h, 1), undefined, '手机主动关闭时不回 closed')

    h.state.enabled = false
    h.tunnel.data(2, Buffer.from('x'))
    assert.deepEqual(closedFrame(h, 2)!.payload, { streamId: 2, reason: 'disabled' })
    await h.tunnel.open('o3', 3, tcp.port)
    assert.equal(h.errors().at(-1)?.payload.reason, 'disabled')
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('电脑侧服务重置连接时以 error 告知手机', async () => {
  const tcp = await listen(createNetServer((socket) => setTimeout(() => socket.resetAndDestroy(), 10)))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    await h.tunnel.open('o', 1, tcp.port)
    await waitFor(() => closedFrame(h, 1) !== undefined, 'closed')
    assert.equal(closedFrame(h, 1)!.payload.reason, 'error')
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('发送缓冲偏高时暂缓下发，恢复后补发', async () => {
  const tcp = await listen(createNetServer((socket) => socket.end('hello')))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    h.state.writable = false
    await h.tunnel.open('o', 1, tcp.port)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.downstream(1).length, 0, '缓冲偏高时一帧不发')
    assert.equal(closedFrame(h, 1), undefined, 'pending 未排空前不发 eof')
    h.state.writable = true
    await waitFor(() => closedFrame(h, 1) !== undefined, 'eof after drain')
    assert.equal(h.downstream(1).toString(), 'hello')
  } finally {
    h.tunnel.dispose()
    await tcp.close()
  }
})

test('dispose 断开全部通道、作废授权，之后静默', async () => {
  let serverClosed = 0
  const tcp = await listen(createNetServer((socket) => { socket.on('close', () => { serverClosed += 1 }) }))
  const h = makeTunnel()
  try {
    await h.tunnel.authorize('a', 's', `http://127.0.0.1:${tcp.port}/`)
    await h.tunnel.open('o1', 1, tcp.port)
    await h.tunnel.open('o2', 2, tcp.port)
    h.tunnel.dispose()
    await waitFor(() => serverClosed === 2, 'both sockets closed')
    const count = h.sent.length
    await h.tunnel.open('o3', 3, tcp.port)
    h.tunnel.data(1, Buffer.from('x'))
    assert.equal(h.sent.length, count, 'dispose 后不再发任何帧')
  } finally {
    await tcp.close()
  }
})
