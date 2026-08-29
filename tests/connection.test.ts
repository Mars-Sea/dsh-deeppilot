import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeConnection, AUTH_TIMEOUT_MS, MAX_OUTBOUND_BUFFER_BYTES, PRE_AUTH_FRAME_BYTES } from '../src/connection.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike } from '../src/host-bridge.ts'
import { DeviceStore } from '../src/token.ts'

// ---------- fakes ----------

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'

class FakeWebSocket {
  static OPEN = 1
  OPEN = 1
  readyState = 1
  bufferedAmount = 0
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

  /** Deliver a pre-serialized ws message; for oversized pre-auth frames
   *  where JSON.stringify would itself balloon memory. */
  receiveRaw(raw: string): void {
    this.handlers.get('message')?.(Buffer.from(raw))
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
  closed: Promise<void>
}

async function makeConnection(opts: {
  transportAuthenticated?: boolean
  proxyOverrides?: Partial<ApiProxyLike>
} = {}): Promise<Harness> {
  const bridge = new HostBridge(makeProxy(opts.proxyOverrides), 100)
  // Each harness gets its own registry file so tests never share state.
  const dir = await mkdtemp(join(tmpdir(), 'pbb-conn-'))
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  const ws = new FakeWebSocket()
  const logs: string[] = []
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const connection = new BridgeConnection(ws as never, {
    bridge,
    devices: store,
    serverVersion: 'test',
    expectedToken: TOKEN,
    ...(opts.transportAuthenticated ? { transportAuthenticated: true } : {}),
    log: (m) => logs.push(m),
    onClosed: () => {
      void (async () => {
        await store.drain()
        await rm(dir, { recursive: true, force: true })
      })().catch(() => {}).finally(resolveClosed)
    },
  })
  return { ws, connection, bridge, store, logs, closed }
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
  assert.ok(lastFrame(ws).payload.capabilities.pendingSnapshot === true)
  assert.ok(lastFrame(ws).payload.capabilities.notifyAllCategories === true)

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
      deviceName: '[deeppilot] pwned\n' + 'n'.repeat(300),
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

test('pending.list returns the complete answerable approval and question snapshot', async () => {
  const { ws, bridge } = await makeConnection({ transportAuthenticated: true })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ;(bridge as any).onMuxFrame({
    type: 'approval/requested', rpcId: 'rpc-a', sessionId: 's1',
    approvalId: 'apr-1', toolName: 'bash', reason: 'install dependency',
  })
  ;(bridge as any).onMuxFrame({
    type: 'question/requested', rpcId: 'rpc-q', sessionId: 's1',
    questions: [{ id: 'mode', question: 'A or B?', options: [{ label: 'A' }] }],
  })
  ws.sent.length = 0

  ws.receive({ v: 1, type: 'c2s.pending.list', id: 'pending-1', payload: {} })

  const frame = lastFrame(ws)
  assert.equal(frame.type, 's2c.pending.snapshot')
  assert.equal(frame.id, 'pending-1')
  assert.equal(frame.payload.approvals[0].requestId, 'apr-1')
  assert.equal(frame.payload.questions[0].requestId, 'q-rpc-q')
  assert.equal(frame.payload.questions[0].questions[0].question, 'A or B?')
})

test('answering an unknown question still reads "question not pending"', async () => {
  const { ws } = await makeConnection({ transportAuthenticated: true })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({
    v: 1,
    type: 'c2s.question.respond',
    id: 'q-none',
    payload: { requestId: 'q-ghost', answers: [{ id: 'x', selected: [] }] },
  })
  await new Promise((r) => setTimeout(r, 10))

  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).id, 'q-none')
  assert.equal(lastFrame(ws).payload.code, 'E_NOT_FOUND')
  assert.equal(lastFrame(ws).payload.message, 'question not pending')
})

test('host-rejected question answers surface E_PROTOCOL, and the entry stays retryable', async () => {
  // The host refuses the batch (e.g. a label it never offered); the phone must
  // NOT see the misleading "question not pending" for this case.
  let accept = false
  const { ws, bridge } = await makeConnection({
    transportAuthenticated: true,
    proxyOverrides: {
      respond: async () => ({ accepted: accept, ...(accept ? {} : { reason: 'bad-response' }) }),
    },
  })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ;(bridge as any).onMuxFrame({
    type: 'question/requested', rpcId: 'rpc-rej', sessionId: 's1',
    questions: [{ id: 'mode', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))
  ws.sent.length = 0

  ws.receive({
    v: 1,
    type: 'c2s.question.respond',
    id: 'q-rej',
    payload: { requestId: 'q-rpc-rej', answers: [{ id: 'mode', selected: ['Z'] }] },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.match(String(lastFrame(ws).payload.message), /rejected by host/)

  // The rejected answer restores the pending question, so a corrected retry succeeds.
  accept = true
  ws.receive({
    v: 1,
    type: 'c2s.question.respond',
    id: 'q-ok',
    payload: { requestId: 'q-rpc-rej', answers: [{ id: 'mode', selected: ['A'] }] },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(lastFrame(ws).type, 's2c.ack')
  assert.equal(lastFrame(ws).id, 'q-ok')
})

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

test('prompt failures surface the host error kind, not a blanket E_BUSY', async () => {
  const { ws } = await makeConnection({
    transportAuthenticated: true,
    proxyOverrides: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
        prompt: async () => ({ result: { ok: false, error: { code: 'session-not-found', message: 'no such session' } } }),
        create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      },
    },
  })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({
    v: 1,
    type: 'c2s.session.sendPrompt',
    id: 'm1',
    payload: { sessionId: 'missing', text: '在吗' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_NOT_FOUND', 'a missing session must not read as busy')
})

test('a failed session.open rolls back its viewer registration', async () => {
  const { ws, bridge } = await makeConnection({
    transportAuthenticated: true,
    proxyOverrides: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => ({ result: { ok: false, error: { code: 'session-not-found' } } }),
        prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
        create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      },
    },
  })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({ v: 1, type: 'c2s.session.open', id: 'o1', payload: { sessionId: 'missing-session' } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastFrame(ws).payload.code, 'E_NOT_FOUND')

  // No viewer interest may survive a failed open — otherwise turn.completed
  // notifications stay suppressed for a session this device never received.
  const viewers = (bridge as unknown as { sinkSessions: Map<unknown, Set<string>> }).sinkSessions
  assert.ok(
    [...viewers.values()].every((set) => !set.has('missing-session')),
    'failed open must not keep viewer interest registered',
  )
})

test('session.open sends tail before realtime events produced during history lookup', async () => {
  let historyStarted!: () => void
  let releaseHistory!: () => void
  const started = new Promise<void>((resolve) => { historyStarted = resolve })
  const gate = new Promise<void>((resolve) => { releaseHistory = resolve })
  const { ws, bridge } = await makeConnection({
    transportAuthenticated: true,
    proxyOverrides: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => {
          historyStarted()
          await gate
          return { result: { ok: true, value: { events: [], hasMore: false } } }
        },
        prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
        create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      },
    },
  })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({ v: 1, type: 'c2s.session.open', id: 'o1', payload: { sessionId: 's1' } })
  await started
  ;(bridge as any).onMuxFrame({
    type: 'session/event',
    sessionId: 's1',
    event: {
      type: 'assistant/chunk',
      seq: 7,
      data: { chunk: { type: 'text-delta', index: 0, text: 'new token' } },
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(ws.sent.length, 0, 'realtime event must wait while the tail is in flight')

  releaseHistory()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(
    ws.sent.map((frame) => frame.type),
    ['s2c.session.tail', 's2c.session.event'],
  )
  assert.equal(ws.sent[1].payload.data.text, 'new token')
})

test('session.history correlates the page with the request id', async () => {
  const { ws } = await makeConnection({
    transportAuthenticated: true,
    proxyOverrides: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => ({
          result: {
            ok: true,
            value: {
              events: [{ event: { type: 'user/message', seq: 4, time: 1, data: 'older row' } }],
              hasMore: false,
            },
          },
        }),
        prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
        create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      },
    },
  })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.sent.length = 0

  ws.receive({
    v: 1,
    type: 'c2s.session.history',
    id: 'history-1',
    payload: { sessionId: 's1', beforeSeq: 10, limit: 100 },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(lastFrame(ws).type, 's2c.history.page')
  assert.equal(lastFrame(ws).id, 'history-1')
  assert.equal(lastFrame(ws).payload.messages[0].seq, 4)
})

test('idle timeout uses the protocol 1001 close code', async () => {
  const { ws, connection } = await makeConnection({ transportAuthenticated: true })
  connection.closeIdle()
  assert.deepEqual(ws.closes, [{ code: 1001, reason: 'idle timeout' }])
  assert.equal(ws.terminated, false)
})

test('server shutdown announces E_INTERNAL before closing with 1001', async () => {
  const { ws, connection } = await makeConnection({ transportAuthenticated: true })
  connection.closeForServerStop()
  assert.equal(ws.sent[0]?.type, 's2c.error')
  assert.equal(ws.sent[0]?.payload.code, 'E_INTERNAL')
  assert.equal(ws.sent[0]?.payload.message, 'server stopping')
  assert.deepEqual(ws.closes, [{ code: 1001, reason: 'server stopping' }])
})

test('a persistently backpressured client is shed before buffering more data', async () => {
  const { ws, closed } = await makeConnection({ transportAuthenticated: true })
  ws.receive({ v: 1, type: 'c2s.hello.auth', id: 'h1', payload: { deviceId: 'd' } })
  ws.bufferedAmount = MAX_OUTBOUND_BUFFER_BYTES + 1
  ws.receive({ v: 1, type: 'c2s.ping', id: 'p1' })
  assert.deepEqual(ws.closes, [{ code: 1013, reason: 'client too slow' }])
  await closed
})

// ---------- pre-auth DoS hardening (P3-B) ----------

test('an oversized pre-auth frame is rejected without parsing or echoing an error', async () => {
  // Before P3-B the ws server happily JSON.parsed a 64 MiB payload inside
  // the 5-second auth window. Now any pre-auth frame over 64 KiB is closed
  // immediately with RFC 6455 code 1009, so an anonymous peer cannot force
  // expensive parse work before authenticating.
  const { ws } = await makeConnection()
  // Build a string that is parseable JSON but well over the cap; we do not
  // expect the implementation to touch JSON.parse for it.
  const huge = '{"v":1,"type":"c2s.ping","id":"p","payload":' + '"x"'.repeat(PRE_AUTH_FRAME_BYTES) + '}'
  assert.ok(huge.length > PRE_AUTH_FRAME_BYTES, 'frame must actually exceed the cap')
  const closed = new Promise<void>((resolve) => {
    ws.on('close', () => resolve())
  })
  ws.receiveRaw(huge)
  assert.deepEqual(ws.closes, [{ code: 1009, reason: 'pre-auth frame too large' }])
  // Crucially: no s2c.error frame is sent — the connection is dropped before
  // any work, and the cost of closing is just the length check.
  assert.equal(
    ws.sent.filter((f) => f.type === 's2c.error').length,
    0,
    'oversized pre-auth frame must not produce an s2c.error response',
  )
  await closed
})

test('authenticated sessions keep the full 64 MiB frame budget for image prompts', async () => {
  // P3-B only tightens the pre-auth cap; the 64 MiB cap remains for
  // authenticated sockets so image attachments are unaffected. Sanity-check
  // by sending a normal hello + a fat prompt text the post-auth path will
  // accept (it will bounce on the protocol's own prompt-text cap of 256 KiB
  // but never on the pre-auth length guard).
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
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL', 'protocol-level cap still applies post-auth')
  // No 1009 close: we passed the pre-auth gate, then hit the protocol's own
  // 256 KiB prompt-text cap. The cap we tightened is the pre-auth one.
  assert.equal(ws.closes.length, 0)
})
