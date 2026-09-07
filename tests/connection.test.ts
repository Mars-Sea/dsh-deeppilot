import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeConnection, AUTH_TIMEOUT_MS, MAX_OUTBOUND_BUFFER_BYTES, PRE_AUTH_FRAME_BYTES } from '../src/connection.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike } from '../src/host-bridge.ts'
import { DeviceStore } from '../src/token.ts'
import type { DeviceScope } from '../src/device-auth.ts'
import { authenticateTestSocket, createTestIdentity, registerTestIdentity, type TestIdentity } from './auth-fixture.ts'

// ---------- fakes ----------

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
  identity: TestIdentity
  authenticate: (overrides?: { deviceName?: string; appVersion?: string; resumeCursor?: number; signature?: string; clientRole?: 'widget' }) => void
}

async function makeConnection(opts: {
  proxyOverrides?: Partial<ApiProxyLike>
  scopes?: DeviceScope[]
  onAuthenticationSettled?: (ok: boolean, reason: 'success' | 'invalid-proof' | 'timeout' | 'closed') => void
  onPushEnrollKey?: (enrollKey: string) => Promise<void> | void
} = {}): Promise<Harness> {
  const bridge = new HostBridge(makeProxy(opts.proxyOverrides), 100)
  // Each harness gets its own registry file so tests never share state.
  const dir = await mkdtemp(join(tmpdir(), 'pbb-conn-'))
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  const identity = createTestIdentity()
  registerTestIdentity(store, identity)
  if (opts.scopes) store.setScopes(identity.deviceId, opts.scopes)
  const ws = new FakeWebSocket()
  const logs: string[] = []
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve })
  const connection = new BridgeConnection(ws as never, {
    bridge,
    devices: store,
    serverVersion: 'test',
    audience: 'deeppilot:test-audience',
    log: (m) => logs.push(m),
    ...(opts.onAuthenticationSettled ? { onAuthenticationSettled: opts.onAuthenticationSettled } : {}),
    ...(opts.onPushEnrollKey ? { onPushEnrollKey: opts.onPushEnrollKey } : {}),
    onClosed: () => {
      void (async () => {
        await store.drain()
        await rm(dir, { recursive: true, force: true })
      })().catch(() => {}).finally(resolveClosed)
    },
  })
  return {
    ws, connection, bridge, store, logs, closed, identity,
    authenticate: (overrides) => authenticateTestSocket(ws, identity, overrides),
  }
}

const lastFrame = (ws: FakeWebSocket) => ws.sent[ws.sent.length - 1]

test('widget connection reads snapshots without changing device name, replaying or suppressing alerts', async () => {
  const { ws, connection, store, bridge, authenticate, identity, closed } = await makeConnection()
  authenticate({ clientRole: 'widget', deviceName: 'DeepPilot Widget', resumeCursor: 0 })
  assert.equal(connection.suppressesAlertPush, false)
  assert.equal(connection.connectedDeviceId, identity.deviceId, 'revocation can still locate widget sockets')
  assert.equal(store.authorized(identity.deviceId)?.deviceName, 'iPhone')
  assert.equal(lastFrame(ws).payload.capabilities.widgetPush, true)
  assert.equal(lastFrame(ws).payload.resumed, false)
  ws.receive({ v: 2, type: 'c2s.sessions.list', id: 'sessions', payload: {} })
  assert.equal(lastFrame(ws).type, 's2c.sessions.snapshot')
  ws.receive({ v: 2, type: 'c2s.pending.list', id: 'pending', payload: {} })
  assert.equal(lastFrame(ws).type, 's2c.pending.snapshot')
  const count = ws.sent.length
  await bridge.refreshSummaries()
  assert.equal(ws.sent.length, count, 'short-lived widget sockets do not subscribe to broadcasts')
  for (const type of ['c2s.session.sendPrompt', 'c2s.approval.respond', 'c2s.resume', 'c2s.push.register']) {
    ws.receive({ v: 2, type, id: type, payload: {} })
    assert.equal(lastFrame(ws).payload.code, 'E_FORBIDDEN')
  }
  ws.close()
  await closed
})

test('widget registration uses separate storage and rechecks revocation after enrollment', async () => {
  let release!: () => void
  const h = await makeConnection({ onPushEnrollKey: () => new Promise<void>(resolve => { release = resolve }) })
  h.authenticate({ clientRole: 'widget' })
  h.store.setPushToken(h.identity.deviceId, 'a'.repeat(64), 'development', undefined, Date.now())
  h.ws.receive({ v: 2, type: 'c2s.widget.push.register', id: 'register', payload: {
    deviceToken: 'b'.repeat(64), environment: 'production',
  } })
  assert.equal(h.store.authorized(h.identity.deviceId)?.widgetApns?.token, 'b'.repeat(64))
  assert.equal(h.store.authorized(h.identity.deviceId)?.apns?.token, 'a'.repeat(64))
  assert.equal(lastFrame(h.ws).payload.code, 'E_UNSUPPORTED', 'registration persists while push is unconfigured')
  h.ws.receive({ v: 2, type: 'c2s.widget.push.register', id: 'revoked', payload: {
    deviceToken: 'c'.repeat(64), enrollKey: 'test-enroll-key',
  } })
  h.store.revoke(h.identity.deviceId, Date.now())
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lastFrame(h.ws).payload.code, 'E_FORBIDDEN')
  assert.equal(h.store.list()[0]?.widgetApns, undefined)
  h.ws.close()
  await h.closed
})

test('widget registration requires registration and both overview content scopes', async () => {
  for (const scopes of [['sessions.read'], ['notifications.register', 'sessions.read']] as DeviceScope[][]) {
    const h = await makeConnection({ scopes })
    h.authenticate({ clientRole: 'widget' })
    h.ws.receive({ v: 2, type: 'c2s.widget.push.register', payload: { deviceToken: 'b'.repeat(64) } })
    assert.equal(lastFrame(h.ws).payload.code, 'E_FORBIDDEN')
    assert.equal(h.store.authorized(h.identity.deviceId)?.widgetApns, undefined)
    h.ws.close()
    await h.closed
  }
})

// ---------- pre-auth behaviour ----------

test('unauthenticated ping is answered; other frames demand authentication first', async () => {
  const { ws } = await makeConnection()

  ws.receive({ v: 2, type: 'c2s.ping', id: 'p1' })
  assert.equal(lastFrame(ws).type, 's2c.pong')
  assert.equal(lastFrame(ws).id, 'p1')

  ws.receive({ v: 2, type: 'c2s.sessions.list', id: 'l1' })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')

  assert.deepEqual(ws.closes, [], 'no socket close before the auth deadline')
})

test('invalid device proof fails closed without registering another identity', async () => {
  const { ws, store, authenticate } = await makeConnection()

  authenticate({ signature: Buffer.alloc(70).toString('base64url') })

  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_AUTH')
  assert.deepEqual(ws.closes, [{ code: 4401, reason: 'invalid device proof' }])
  assert.equal(store.list().length, 1, 'failed proof must not register another device')
})

test('authentication settlement fires once for a failed proof and synchronous close', async () => {
  const settled: Array<{ ok: boolean; reason: string }> = []
  const { authenticate } = await makeConnection({
    onAuthenticationSettled: (ok, reason) => settled.push({ ok, reason }),
  })

  authenticate({ signature: Buffer.alloc(70).toString('base64url') })

  assert.deepEqual(settled, [{ ok: false, reason: 'invalid-proof' }])
})

// ---------- proof / device identity ----------

test('valid device proof refreshes identity and sends welcome with capabilities', async () => {
  const { ws, store, identity, authenticate } = await makeConnection()

  authenticate({ deviceName: 'iPhone', appVersion: '0.1.0' })

  assert.equal(lastFrame(ws).type, 's2c.welcome')
  assert.equal(lastFrame(ws).payload.protocolVersion, 2)
  assert.equal(typeof lastFrame(ws).payload.cursor, 'number')
  assert.ok(lastFrame(ws).payload.capabilities.replay === true)
  assert.ok(lastFrame(ws).payload.capabilities.pendingSnapshot === true)
  assert.ok(lastFrame(ws).payload.capabilities.notifyAllCategories === true)

  const rows = store.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].deviceId, identity.deviceId)
})

test('oversized or control-bearing device fields are clamped and stripped', async () => {
  const { store, logs, authenticate } = await makeConnection()

  authenticate({
    deviceName: '[deeppilot] pwned\n' + 'n'.repeat(300),
    appVersion: 'v'.repeat(200),
  })

  const rows = store.list()
  assert.equal(rows.length, 1, 'one logical device despite oversized fields')
  const row = rows[0]
  assert.equal(row.deviceId.length, 43, 'device id is a key fingerprint')
  assert.ok(row.deviceName.length <= 64 && !row.deviceName.includes('\n'), 'name clamped, no newline')
  assert.ok(row.appVersion.length <= 32, 'version clamped')
  for (const line of logs) {
    assert.equal(line.includes('\n'), false, 'log lines stay single-line')
  }
})

test('auth timeout drops an unauthenticated socket at the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ws } = await makeConnection()

  t.mock.timers.tick(AUTH_TIMEOUT_MS)
  assert.deepEqual(ws.closes.map((c) => c.code), [4402])

  // A second tick after closure must not stack another close record.
  t.mock.timers.tick(AUTH_TIMEOUT_MS)
  assert.equal(ws.closes.length, 1)
})

test('a successful proof cancels the auth deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { ws, authenticate } = await makeConnection()

  authenticate()
  assert.equal(lastFrame(ws).type, 's2c.welcome')

  t.mock.timers.tick(AUTH_TIMEOUT_MS * 10)
  assert.deepEqual(ws.closes, [], 'authenticated connection survives past the deadline')
})

// ---------- authenticated frames ----------

test('revoked devices cannot authenticate even with a valid signature', async () => {
  const { ws, store, identity, authenticate } = await makeConnection()
  assert.equal(store.revoke(identity.deviceId, Date.now()), true)
  authenticate()
  assert.equal(lastFrame(ws).payload.code, 'E_AUTH')
  assert.deepEqual(ws.closes, [{ code: 4401, reason: 'invalid device proof' }])
})

test('device scopes reject unauthorized operations without closing the socket', async () => {
  const { ws, authenticate } = await makeConnection({ scopes: ['sessions.read'] })
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
    type: 'c2s.session.sendPrompt',
    id: 'send-1',
    payload: { sessionId: 's1', text: 'hello' },
  })

  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_FORBIDDEN')
  assert.deepEqual(ws.closes, [])
})

test('pending.list returns the complete answerable approval and question snapshot', async () => {
  const { ws, bridge, authenticate } = await makeConnection()
  authenticate()
  ;(bridge as any).onMuxFrame({
    type: 'approval/requested', rpcId: 'rpc-a', sessionId: 's1',
    approvalId: 'apr-1', toolName: 'bash', reason: 'install dependency',
  })
  ;(bridge as any).onMuxFrame({
    type: 'question/requested', rpcId: 'rpc-q', sessionId: 's1',
    questions: [{ id: 'mode', question: 'A or B?', options: [{ label: 'A' }] }],
  })
  ws.sent.length = 0

  ws.receive({ v: 2, type: 'c2s.pending.list', id: 'pending-1', payload: {} })

  const frame = lastFrame(ws)
  assert.equal(frame.type, 's2c.pending.snapshot')
  assert.equal(frame.id, 'pending-1')
  assert.equal(frame.payload.approvals[0].requestId, 'apr-1')
  assert.equal(frame.payload.questions[0].requestId, 'q-rpc-q')
  assert.equal(frame.payload.questions[0].questions[0].question, 'A or B?')
})

test('answering an unknown question still reads "question not pending"', async () => {
  const { ws, authenticate } = await makeConnection()
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
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
  const { ws, bridge, authenticate } = await makeConnection({
    proxyOverrides: {
      respond: async () => ({ accepted: accept, ...(accept ? {} : { reason: 'bad-response' }) }),
    },
  })
  authenticate()
  ;(bridge as any).onMuxFrame({
    type: 'question/requested', rpcId: 'rpc-rej', sessionId: 's1',
    questions: [{ id: 'mode', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))
  ws.sent.length = 0

  ws.receive({
    v: 2,
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
    v: 2,
    type: 'c2s.question.respond',
    id: 'q-ok',
    payload: { requestId: 'q-rpc-rej', answers: [{ id: 'mode', selected: ['A'] }] },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(lastFrame(ws).type, 's2c.ack')
  assert.equal(lastFrame(ws).id, 'q-ok')
})

test('prompt text beyond the cap is rejected before reaching the host', async () => {
  const { ws, authenticate } = await makeConnection()
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
    type: 'c2s.session.sendPrompt',
    id: 'm1',
    payload: { sessionId: 's1', text: 'x'.repeat(256 * 1024 + 1) },
  })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.equal(lastFrame(ws).id, 'm1')
})

test('an ordinary prompt passes validation and is acknowledged', async () => {
  const { ws, authenticate } = await makeConnection()
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
    type: 'c2s.session.sendPrompt',
    id: 'm2',
    payload: { sessionId: 's1', text: '帮我看看这段代码' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(lastFrame(ws).type, 's2c.ack')
  assert.equal(lastFrame(ws).id, 'm2')
})

test('document prompts are bounded, sanitized, and accepted with ordinary text', async () => {
  let promptPayload: any
  const { ws, authenticate } = await makeConnection({
    proxyOverrides: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
        prompt: async (request: any) => {
          promptPayload = request.payload
          return { result: { ok: true, value: { accepted: true } } }
        },
        create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      },
    },
  })
  authenticate()
  ws.sent.length = 0
  ws.receive({
    v: 2,
    type: 'c2s.session.sendPrompt',
    id: 'doc-1',
    payload: {
      sessionId: 's1',
      text: '总结它',
      documents: [{ name: 'notes\n.md', mediaType: 'text/markdown', text: '# Notes' }],
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastFrame(ws).type, 's2c.ack')
  assert.match(promptPayload.content[1].text, /Attached document: notes \.md/)

  ws.receive({
    v: 2,
    type: 'c2s.session.sendPrompt',
    id: 'doc-bad',
    payload: { sessionId: 's1', text: '', documents: [{ name: 'bad.bin', mediaType: 'application/octet-stream', text: '' }] },
  })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
})

test('history page echoes the request id so the client can settle its timeout', async () => {
  const { ws, authenticate } = await makeConnection()
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
    type: 'c2s.session.history',
    id: 'history-1',
    payload: { sessionId: 's1', beforeSeq: 442, limit: 100 },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(lastFrame(ws).type, 's2c.history.page')
  assert.equal(lastFrame(ws).id, 'history-1')
  assert.deepEqual(lastFrame(ws).payload, { sessionId: 's1', messages: [], hasMore: false })
})

test('attachment read-back validates the payload and relays host image data', async () => {
  const { ws, authenticate } = await makeConnection()
  authenticate()
  ws.sent.length = 0

  ws.receive({ v: 2, type: 'c2s.session.attachment', id: 'a1', payload: {} })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.equal(lastFrame(ws).id, 'a1')

  ws.receive({
    v: 2,
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

// ---------- frame shape hardening (R1/P1) ----------

test('a JSON null frame is rejected as malformed instead of crashing the host', async () => {
  const { ws } = await makeConnection()
  // JSON.parse('null') returns null; the old `as Envelope` cast let `env.v`
  // throw outside any try/catch and take the process down with it.
  ws.receive(null)
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.deepEqual(ws.closes, [], 'a malformed frame must not close the socket either')
  // The connection must stay usable afterwards.
  ws.receive({ v: 2, type: 'c2s.ping', id: 'after' })
  assert.equal(lastFrame(ws).type, 's2c.pong')
})

test('array and primitive frames are rejected as malformed envelopes', async () => {
  const { ws } = await makeConnection()
  for (const frame of [[1, 2, 3], 42, true, 'hello']) {
    ws.receive(frame)
    assert.equal(lastFrame(ws).type, 's2c.error', String(frame))
    assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL', String(frame))
  }
  assert.deepEqual(ws.closes, [])
})

test('mistyped envelope fields are rejected before they reach dispatch', async () => {
  const { ws } = await makeConnection()
  // v must be a number; type must be a non-empty string; id/ts/seq must have
  // their declared types when present.
  ws.receive({ v: '2', type: 'c2s.ping' })
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  ws.receive({ v: 2, type: '' })
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  ws.receive({ v: 2, type: 'c2s.ping', id: 7 })
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  ws.receive({ v: 2, type: 'c2s.ping', ts: 'now' })
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  ws.receive({ v: 2, type: 'c2s.ping', seq: 'later' })
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.deepEqual(ws.closes, [])
})

test('authenticated frames with a missing or non-string type are rejected, not crashed', async () => {
  const { ws, authenticate } = await makeConnection()
  authenticate()
  ws.sent.length = 0

  // Missing type: used to reach requiredScope(undefined) and throw on
  // `undefined.startsWith`.
  ws.receive({ v: 2, payload: {} })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  // Non-string type: same unsafe string operation in requiredScope.
  ws.receive({ v: 2, type: 42, payload: {} })
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL')
  assert.deepEqual(ws.closes, [], 'the connection survives shape errors')
})

test('an unexpected host-callback error is contained to the offending connection', async () => {
  // The outermost .catch on the message handler must stop a thrown host
  // callback from escaping into the process: only this socket is dropped.
  const { ws, closed, authenticate } = await makeConnection({
    // The relay round-trip inside c2s.push.register is a host-provided
    // callback that may throw; nothing downstream should see the rejection.
    onPushEnrollKey: async () => { throw new Error('relay unreachable') },
  })
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
    type: 'c2s.push.register',
    id: 'pr-1',
    payload: { deviceToken: 'a'.repeat(64), environment: 'development', enrollKey: 's'.repeat(20) },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(ws.terminated, true, 'the socket must be hard-dropped')
  assert.equal(ws.sent.length, 0, 'the failed handler must not emit a partial response')
  await closed
})

test('prompt failures surface the host error kind, not a blanket E_BUSY', async () => {
  const { ws, authenticate } = await makeConnection({
    proxyOverrides: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
        prompt: async () => ({ result: { ok: false, error: { code: 'session-not-found', message: 'no such session' } } }),
        create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      },
    },
  })
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
    type: 'c2s.session.sendPrompt',
    id: 'm1',
    payload: { sessionId: 'missing', text: '在吗' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastFrame(ws).type, 's2c.error')
  assert.equal(lastFrame(ws).payload.code, 'E_NOT_FOUND', 'a missing session must not read as busy')
})

test('a failed session.open rolls back its viewer registration', async () => {
  const { ws, bridge, authenticate } = await makeConnection({
    proxyOverrides: {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => ({ result: { ok: false, error: { code: 'session-not-found' } } }),
        prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
        create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      },
    },
  })
  authenticate()
  ws.sent.length = 0

  ws.receive({ v: 2, type: 'c2s.session.open', id: 'o1', payload: { sessionId: 'missing-session' } })
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
  const { ws, bridge, authenticate } = await makeConnection({
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
  authenticate()
  ws.sent.length = 0

  ws.receive({ v: 2, type: 'c2s.session.open', id: 'o1', payload: { sessionId: 's1' } })
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
  const { ws, authenticate } = await makeConnection({
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
  authenticate()
  ws.sent.length = 0

  ws.receive({
    v: 2,
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
  const { ws, connection } = await makeConnection()
  connection.closeIdle()
  assert.deepEqual(ws.closes, [{ code: 1001, reason: 'idle timeout' }])
  assert.equal(ws.terminated, false)
})

test('server shutdown announces E_INTERNAL before closing with 1001', async () => {
  const { ws, connection } = await makeConnection()
  connection.closeForServerStop()
  assert.equal(lastFrame(ws)?.type, 's2c.error')
  assert.equal(lastFrame(ws)?.payload.code, 'E_INTERNAL')
  assert.equal(lastFrame(ws)?.payload.message, 'server stopping')
  assert.deepEqual(ws.closes, [{ code: 1001, reason: 'server stopping' }])
})

test('a persistently backpressured client is shed before buffering more data', async () => {
  const { ws, closed, authenticate } = await makeConnection()
  authenticate()
  ws.bufferedAmount = MAX_OUTBOUND_BUFFER_BYTES + 1
  ws.receive({ v: 2, type: 'c2s.ping', id: 'p1' })
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
  const { ws, authenticate } = await makeConnection()
  authenticate()
  ws.sent.length = 0
  ws.receive({
    v: 2,
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

// ---------- S→C permission gating (R1/P2) ----------

test('a device with no scopes receives no session content or replay during resume', async () => {
  const { ws, bridge, authenticate } = await makeConnection({ scopes: [] })
  const sessionId = 'perm-empty'
  ;(bridge as any).onMuxFrame({
    type: 'session/event', rpcId: 'rpc-ev', sessionId,
    event: { type: 'assistant/message', seq: 5, data: { text: '会话内容' } },
  })
  ;(bridge as any).onMuxFrame({
    type: 'session/projection', sessionId, key: 'title', value: '标题',
  })
  await new Promise((r) => setTimeout(r, 10))

  authenticate({ resumeCursor: 0 })
  const welcome = ws.sent.find(f => f.type === 's2c.welcome')!
  assert.equal(welcome.payload.resumed, true)
  assert.deepEqual(welcome.payload.scopes, [])
  await new Promise((r) => setTimeout(r, 10))

  const afterWelcome = ws.sent.filter((f) => f.type !== 's2c.welcome' && f.type !== 's2c.auth.challenge')
  assert.deepEqual(
    afterWelcome.map((f) => f.type),
    ['s2c.resume.done'],
    'no replayed session events, deltas or resync to a device without sessions.read',
  )

  // Live broadcasts must not arrive either.
  ;(bridge as any).onMuxFrame({
    type: 'session/event', rpcId: 'rpc-ev2', sessionId,
    event: { type: 'assistant/message', seq: 6, data: { text: '更多内容' } },
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(
    ws.sent.filter((f) => f.type === 's2c.session.event').length,
    0,
    'no live session events to a device without sessions.read',
  )
  assert.deepEqual(ws.sent.filter((f) => f.type === 's2c.sessions.delta').length, 0)
})

test('a notifications-only device receives no content', async () => {
  const { ws, bridge, authenticate } = await makeConnection({ scopes: ['notifications.register'] })
  const sessionId = 'perm-notify'
  authenticate()
  ws.sent.length = 0

  ;(bridge as any).onMuxFrame({
    type: 'session/event', rpcId: 'rpc-ev', sessionId,
    event: { type: 'turn/end', seq: 5, data: { reason: { kind: 'completed' } } },
  })
  ;(bridge as any).onMuxFrame({
    type: 'approval/requested', rpcId: 'rpc-apr', approvalId: 'apr-1',
    sessionId, toolName: 'bash', reason: 'run tests',
  })
  await new Promise((r) => setTimeout(r, 10))

  const types = ws.sent.map((f) => f.type)
  assert.ok(!types.includes('s2c.session.event'), 'no session content without sessions.read')
  assert.ok(!types.includes('s2c.pending.approval'), 'no approval state without interactions.respond')
  assert.ok(!types.includes('s2c.notify'), 'registration alone grants no content access')
})

test('zero-scope devices never receive assistant content through notifications or unknown frames', async () => {
  const { ws, bridge, authenticate } = await makeConnection({ scopes: [] })
  authenticate()
  ws.sent.length = 0
  ;(bridge as any).onMuxFrame({type: 'session/event', sessionId: 'secret',
    event: {type: 'assistant/message', seq: 1, data: {text: 'CONFIDENTIAL'}}})
  ;(bridge as any).onMuxFrame({type: 'session/event', sessionId: 'secret',
    event: {type: 'turn/end', seq: 2, data: {reason: {kind: 'completed'}}}})
  ;(bridge as any).record('s2c.future.private', {text: 'CONFIDENTIAL'})
  assert.equal(ws.sent.length, 0)
  bridge.resumeFrom(0, (bridge as any).sinks.values().next().value)
  assert.deepEqual(ws.sent.map(f => f.type), ['s2c.resume.done'])
})

test('responders recover pending requests by replay and snapshot; readers cannot fetch them', async () => {
  for (const scopes of [['interactions.respond'], ['sessions.read']] as DeviceScope[][]) {
    const { ws, bridge, authenticate } = await makeConnection({ scopes })
    ;(bridge as any).onMuxFrame({type: 'approval/requested', rpcId: 'r', approvalId: 'a',
      sessionId: 's', toolName: 'bash', reason: 'private'})
    authenticate({resumeCursor: 0})
    const responder = scopes.includes('interactions.respond')
    assert.equal(ws.sent.some(f => f.type === 's2c.pending.approval'), responder)
    ws.receive({v: 2, type: 'c2s.pending.list', id: 'pending', payload: {}})
    const response = lastFrame(ws)
    assert.equal(response.type, responder ? 's2c.pending.snapshot' : 's2c.error')
    if (responder) assert.equal(response.payload.approvals[0].requestId, 'a')
    else assert.equal(response.payload.code, 'E_FORBIDDEN')
  }
})

test('an interactions-only device gets approval frames but no session content', async () => {
  const { ws, bridge, authenticate } = await makeConnection({ scopes: ['interactions.respond'] })
  const sessionId = 'perm-approval'
  authenticate()
  ws.sent.length = 0

  ;(bridge as any).onMuxFrame({
    type: 'approval/requested', rpcId: 'rpc-apr', approvalId: 'apr-2',
    sessionId, toolName: 'bash', reason: 'approve me',
  })
  ;(bridge as any).onMuxFrame({
    type: 'session/event', rpcId: 'rpc-ev', sessionId,
    event: { type: 'assistant/message', seq: 5, data: { text: '隐私内容' } },
  })
  await new Promise((r) => setTimeout(r, 10))

  const types = ws.sent.map((f) => f.type)
  assert.ok(types.includes('s2c.pending.approval'), 'approval state reaches the responder')
  const reqId = ws.sent.find((f) => f.type === 's2c.pending.approval')!.payload.requestId
  assert.equal(reqId, 'apr-2')
  assert.ok(types.includes('s2c.notify'), 'approval.required notify accompanies the state')
  assert.equal(ws.sent.find((f) => f.type === 's2c.notify')!.payload.hostAudience, 'deeppilot:test-audience')
  assert.ok(!types.includes('s2c.session.event'), 'no session content without sessions.read')
})

test('a reader-without-interactions device gets session content but never approval state', async () => {
  const { ws, bridge, authenticate } = await makeConnection({ scopes: ['sessions.read'] })
  const sessionId = 'perm-reader'
  authenticate()
  ws.sent.length = 0

  ;(bridge as any).onMuxFrame({
    type: 'approval/requested', rpcId: 'rpc-apr', approvalId: 'apr-3',
    sessionId, toolName: 'bash', reason: 'approve me',
  })
  await new Promise((r) => setTimeout(r, 10))

  const types = ws.sent.map((f) => f.type)
  assert.ok(!types.includes('s2c.pending.approval'), 'no approval state without interactions.respond')
  assert.ok(!types.includes('s2c.notify'), 'approval.required notify is interaction-scoped and withheld')
  // The approval should not leave a dangling pending flag for this device.
  assert.deepEqual(ws.sent.filter((f) => f.type === 's2c.pending.cleared').length, 0)
})

test('invalid request fields are rejected before Host methods can run', async () => {
  const { ws, bridge, authenticate } = await makeConnection()
  authenticate()
  let calls = 0
  for (const name of ['createSession', 'cancelSession', 'selectSessionModel', 'sendPrompt', 'respondQuestion', 'historyPage']) {
    ;(bridge as any)[name] = async () => { calls++; throw new Error('invalid input reached Host') }
  }
  const cases: Array<[string, unknown]> = [
    ['c2s.session.create', { workspaceId: 42 }],
    ['c2s.session.cancel', { sessionId: {} }],
    ['c2s.session.selectModel', { sessionId: 's', provider: 7, model: 'm' }],
    ['c2s.session.sendPrompt', { sessionId: 's', text: 'hi', images: {} }],
    ['c2s.session.history', { sessionId: 's', beforeSeq: 10, limit: -1 }],
    ['c2s.session.open', { sessionId: 's', tailCount: 1.5 }],
    ['c2s.question.respond', { requestId: 'r', answers: [{ id: 'q', selected: [false] }] }],
    ['c2s.push.register', { deviceToken: 'a'.repeat(64), environment: 'typo' }],
  ]
  for (const [type, payload] of cases) {
    ws.receive({ v: 2, type, id: 'invalid', payload })
    await new Promise(r => setTimeout(r, 1))
    assert.equal(lastFrame(ws).payload.code, 'E_PROTOCOL', type)
  }
  assert.equal(calls, 0)
  ws.receive({ v: 2, type: 'c2s.ping', id: 'still-alive' })
  assert.equal(lastFrame(ws).type, 's2c.pong')
})

test('stable prompt ID deduplicates dispatch and receipt lookup uses prompt scope', async () => {
  const { randomUUID } = await import('node:crypto')
  const { ws, bridge, authenticate } = await makeConnection({ scopes: ['prompt.send'] })
  authenticate()
  let calls = 0
  ;(bridge as any).sendPrompt = async () => { calls++; return { ok: true, value: 99 } }
  const clientSendId = `${Date.now()}-${randomUUID()}`
  const payload = { sessionId: 's', text: 'hello', clientSendId }
  ws.receive({ v: 2, type: 'c2s.session.sendPrompt', id: 'first', payload })
  ws.receive({ v: 2, type: 'c2s.session.sendPrompt', id: 'retry', payload })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls, 1)
  assert.equal(lastFrame(ws).payload.status, 'accepted')
  ws.receive({ v: 2, type: 'c2s.session.delivery', id: 'lookup', payload: { sessionId: 's', clientSendId } })
  assert.equal(lastFrame(ws).payload.status, 'accepted')
  assert.equal(lastFrame(ws).payload.clientSendId, clientSendId)
  const reader = await makeConnection({ scopes: ['sessions.read'] })
  reader.authenticate()
  reader.ws.receive({ v: 2, type: 'c2s.session.delivery', id: 'denied', payload: { sessionId: 's', clientSendId } })
  assert.equal(lastFrame(reader.ws).payload.code, 'E_FORBIDDEN')
})
