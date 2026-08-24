import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeConnection, AUTH_TIMEOUT_MS } from '../src/connection.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike } from '../src/host-bridge.ts'
import { DeviceStore } from '../src/token.ts'

// ---------- fakes ----------

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'

class FakeWebSocket {
  static OPEN = 1
  OPEN = 1
  readyState = 1
  sent: any[] = []
  closes: Array<{ code: number | undefined; reason: string }> = []
  terminated = false
  private handlers = new Map<string, (arg?: unknown) => void>()

  on(event: string, handler: (arg?: unknown) => void): void {
    this.handlers.set(event, handler)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return
    this.closes.push({ code, reason: reason ?? '' })
    this.readyState = 3
    this.handlers.get('close')?.()
  }

  terminate(): void {
    this.terminated = true
    this.readyState = 3
    this.handlers.get('close')?.()
  }

  /** Deliver one protocol frame as the ws 'message' event would. */
  receive(payload: unknown): void {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(payload)))
  }
}

function makeProxy(overrides: Partial<ApiProxyLike> = {}): ApiProxyLike {
  return {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
      prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
      create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      attachment: async () => ({ result: { ok: true, value: { attachment: { mediaType: 'image/png' }, data: 'aGk=' } } }),
    },
    respond: async () => ({ accepted: true }),
    events: {
      mux: async function* () { await new Promise(() => {}) },
      host: async function* () { await new Promise(() => {}) },
    },
    ...overrides,
  } as ApiProxyLike
}

interface Harness {
  ws: FakeWebSocket
  connection: BridgeConnection
  bridge: HostBridge
  store: DeviceStore
  logs: string[]
}

async function makeConnection(opts: {
  transportAuthenticated?: boolean
} = {}): Promise<Harness> {
  const bridge = new HostBridge(makeProxy(), 100)
  // Each harness gets its own registry file so tests never share state.
  const dir = await mkdtemp(join(tmpdir(), 'pbb-conn-'))
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  const ws = new FakeWebSocket()
  const logs: string[] = []
  const connection = new BridgeConnection(ws as never, {
    bridge,
    devices: store,
    serverVersion: 'test',
    expectedToken: TOKEN,
    ...(opts.transportAuthenticated ? { transportAuthenticated: true } : {}),
    log: (m) => logs.push(m),
    onClosed: () => { void rm(dir, { recursive: true, force: true }) },
  })
  return { ws, connection, bridge, store, logs }
}

const lastFrame = (ws: FakeWebSocket) => ws.sent[ws.sent.length - 1]

// ---------- pre-auth behaviour ----------

test('unauthenticated ping is answered; other frames demand authentication first', async () => {
  const { ws } = await makeConnection()

  ws.receive({ v: 1, type: 'c2s.ping', id: 'p1' })
  assert.equal(lastFrame(ws).type, 's2c.pong')
  assert.equal(lastFrame(ws).id, 'p1')

  ws.receive({ v: 1, type: 'c2s.sessions.list', id: 'l1' })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')

  assert.deepEqual(ws.closes, [], 'no socket close before the auth deadline')
})

test('hello with a wrong token fails closed without revealing which part was wrong', async () => {
  const { ws, store } = await makeConnection()

  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { token: 'w'.repeat(43), deviceId: 'd1' } })

  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_AUTH')
  assert.deepEqual(ws.closes, [{ code: 4401, reason: 'invalid token' }])
  assert.deepEqual(store.list(), [], 'failed pairing must not register a device')
})

// ---------- hello / device identity ----------

test('hello registers a sanitized device and sends welcome with capabilities', async () => {
  const { ws, store } = await makeConnection()

  ws.receive({
    v: 1,
    type: 'c2s.hello.auth',
    id: 'h1',
    payload: { token: TOKEN, deviceId: 'device-1', deviceName: 'iPhone', appVersion: '0.1.0' },
  })

  assert.equal(lastFrame(ws).type, 's2c.welcome')
  assert.equal(lastFrame(ws).payload.protocolVersion, 1)
  assert.equal(typeof lastFrame(ws).payload.cursor, 'number')
  assert.ok(lastFrame(ws).payload.capabilities.replay === true)

  const rows = store.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].deviceId, 'device-1')
})

test('oversized or control-bearing device fields are clamped and stripped', async () => {
  const { ws, store, logs } = await makeConnection()

  ws.receive({
    v: 1,
    type: 'c2s.hello.auth',
    id: 'h1',
    payload: {
      token: TOKEN,
      deviceId: 'd'.repeat(500) + '\nevil-log-line',
      deviceName: '[phone-bridge] pwned\n' + 'n'.repeat(300),
      appVersion: 'v'.repeat(200),
    },
  })

  const rows = store.list()
  assert.equal(rows.length, 1, 'one logical device despite oversized fields')
  const row = rows[0]
  assert.ok(row.deviceId.length <= 128 && !row.deviceId.includes('\n'), 'id clamped, no newline')
  assert.ok(row.deviceName.length <= 64 && !row.deviceName.includes('\n'), 'name clamped, no newline')
  assert.ok(row.appVersion.length <= 32, 'version clamped')
  for (const line of logs) {
    assert.equal(line.includes('\n'), false, 'log lines stay single-line')
  }
})

test('hello timeout drops an unauthenticated socket at the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ws } = await makeConnection()

  t.mock.timers.tick(AUTH_TIMEOUT_MS)
  assert.deepEqual(ws.closes.map((c) => c.code), [4402])

  // A second tick after closure must not stack another close record.
  t.mock.timers.tick(AUTH_TIMEOUT_MS)
  assert.equal(ws.closes.length, 1)
})

test('a successful hello cancels the auth deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ws } = await makeConnection({ transportAuthenticated: true })

  // transportAuthenticated short-circuits the token check in hello.
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'device-2' } })
  assert.equal(lastFrame(ws).type, 's2c.welcome')

  t.mock.timers.tick(AUTH_TIMEOUT_MS * 10)
  assert.deepEqual(ws.closes, [], 'authenticated connection survives past the deadline')
})

// ---------- authenticated frames ----------

test('prompt text beyond the cap is rejected before reaching the host', async () => {
  const { ws } = await makeConnection({ transportAuthenticated: true })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({
    v: 1,
    type: 'c2s.session.sendPrompt',
    id: 'm1',
    payload: { sessionId: 's1', text: 'x'.repeat(256 * 1024 + 1) },
  })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.equal(lastFrame(ws).id, 'm1')
})

test('an ordinary prompt passes validation and is acknowledged', async () => {
  const { ws } = await makeConnection({ transportAuthenticated: true })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({
    v: 1,
    type: 'c2s.session.sendPrompt',
    id: 'm2',
    payload: { sessionId: 's1', text: '帮我看看这段代码' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(lastFrame(ws).type, 's2c.ack')
  assert.equal(lastFrame(ws).id, 'm2')
})

test('attachment read-back validates the payload and relays host image data', async () => {
  const { ws } = await makeConnection({ transportAuthenticated: true })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({ v: 1, type: 'c2s.session.attachment', id: 'a1', payload: {} })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.equal(lastFrame(ws).id, 'a1')

  ws.receive({
    v: 1,
    type: 'c2s.session.attachment',
    id: 'a2',
    payload: { sessionId: 's1', attachmentId: 'att-9' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastFrame(ws).type, 's2c.ack')
  assert.equal(lastFrame(ws).id, 'a2')
  assert.deepEqual(lastFrame(ws).payload, { mediaType: 'image/png', data: 'aGk=' })
})

test('protocol version mismatch closes with 4500 after an error frame', async () => {
  const { ws } = await makeConnection()
  ws.receive({ v: 99, type: 'c2s.ping', id: 'p9' })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_UNSUPPORTED')
  assert.deepEqual(ws.closes.map((c) => c.code), [4500])
})
