import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApnsClient, apnsPayload, classifyApnsReason, collapseIdFor, es256Jwt, p8ToDer } from '../src/apns.ts'
import { shouldPrunePushToken, shouldReEnrollRelayToken } from '../src/index.ts'
import type { PushNotification } from '../src/protocol.ts'
import { BridgeConnection } from '../src/connection.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike, MuxFrameLike, PushOutlet } from '../src/host-bridge.ts'
import { DeviceStore } from '../src/token.ts'

// ---------- shared fakes ----------

const TOKEN = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'

class FakeWebSocket {
  static OPEN = 1
  OPEN = 1
  readyState = 1
  sent: any[] = []
  closes: Array<{ code: number | undefined; reason: string }> = []
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
    this.readyState = 3
    this.handlers.get('close')?.()
  }

  receive(payload: unknown): void {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(payload)))
  }
}

function makeProxy(): ApiProxyLike {
  return {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
      prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
      create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
    },
    respond: async () => ({ accepted: true }),
    events: {
      mux: async function* () { await new Promise(() => {}) },
      host: async function* () { await new Promise(() => {}) },
    },
  } as ApiProxyLike
}

/** Proxy whose mux stream is fed manually (mirrors host-bridge.test.ts). */
function makeFeedableProxy() {
  let feed: ((frame: MuxFrameLike) => void) | undefined
  const proxy = makeProxy() as ApiProxyLike & { __feed?: unknown }
  proxy.events.mux = async function* (req, signal) {
    const queue: MuxFrameLike[] = []
    feed = (frame) => queue.push(frame)
    while (!signal.aborted) {
      if (queue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        continue
      }
      yield queue.shift()!
    }
  }
  return { proxy, getFeed: () => feed! }
}

const lastFrame = (ws: FakeWebSocket) => ws.sent[ws.sent.length - 1]
/** Latest frame of the given type (bridge.start() races async deltas into the same socket). */
const frameOfType = (ws: FakeWebSocket, type: string) =>
  [...ws.sent].reverse().find((frame) => frame.type === type)

const DEVICE_TOKEN_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'

async function makeHarness(opts: { withOutlet?: boolean; flipOnEnroll?: boolean } = {}) {
  const enrollKeys: string[] = []
  // Simulates the zero-touch bootstrap: the bridge only becomes push-ready
  // while processing the app's enrollKey (relay round-trip happens there).
  let outletReady = opts.withOutlet !== false && opts.flipOnEnroll !== true
  const dir = await mkdtemp(join(tmpdir(), 'pbb-push-'))
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  const { proxy, getFeed } = makeFeedableProxy()
  const bridge = new HostBridge(proxy, 100)
  const fanOutCalls: PushNotification[] = []
  const outlet: PushOutlet = {
    fanOut: (notification) => fanOutCalls.push(notification),
    isAvailable: () => outletReady,
  }
  if (opts.withOutlet !== false) bridge.setPushOutlet(outlet)
  bridge.start()
  const ws = new FakeWebSocket()
  const logs: string[] = []
  const connection = new BridgeConnection(ws as never, {
    bridge,
    devices: store,
    serverVersion: 'test',
    expectedToken: TOKEN,
    log: (m) => logs.push(m),
    onPushEnrollKey: async (key) => {
      enrollKeys.push(key)
      if (opts.flipOnEnroll === true) {
        await new Promise((resolve) => setTimeout(resolve, 5)) // relay round-trip
        outletReady = true
      }
    },
    onClosed: () => { void rm(dir, { recursive: true, force: true }) },
  })
  ws.receive({
    v: 1,
    type: 'c2s.hello.auth',
    id: 'h1',
    payload: { token: TOKEN, deviceId: 'device-1', deviceName: 'iPhone', appVersion: '0.1.0' },
  })
  // hello dispatches asynchronously, so snapshot the welcome frame (and any
  // early deltas) before wiping the buffer for per-test assertions.
  const welcomeFrame = [...ws.sent].reverse().find((frame) => frame.type === 's2c.welcome')
  const capabilitiesAtHello = bridge.capabilities
  ws.sent.length = 0
  const cleanup = () => {
    bridge.dispose()
    void rm(dir, { recursive: true, force: true })
  }
  return { dir, store, bridge, connection, ws, logs, fanOutCalls, getFeed, welcomeFrame, capabilitiesAtHello, enrollKeys, cleanup }
}

// ---------- ES256 provider token ----------

test('es256Jwt produces a verifiable JOSE compact token', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'KEY123' })).toString('base64url')
  const claims = Buffer.from(JSON.stringify({ iss: 'TEAMID', iat: 1756000000 })).toString('base64url')
  const signingInput = `${header}.${claims}`

  const jwt = es256Jwt(signingInput, privateKey)
  const parts = jwt.split('.')
  assert.equal(parts.length, 3)
  assert.equal(parts[0], header)
  assert.equal(parts[1], claims)

  // Raw r||s signature must verify under SHA-256 with the public key.
  const signature = Buffer.from(parts[2], 'base64url')
  assert.equal(signature.length, 64, 'ES256 signatures are exactly 64 raw bytes')
  assert.equal(
    cryptoVerify('sha256', Buffer.from(signingInput), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature),
    true,
  )
})

test('p8ToDer strips PEM armor and yields stable DER bytes', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pemSpki = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const derFromPem = p8ToDer(pemSpki)
  const expected = createHash('sha256')
    .update(privateKey.export({ type: 'pkcs8', format: 'der' }))
    .digest()
  assert.equal(derFromPem.length > 0, true)
  assert.equal(
    createHash('sha256').update(derFromPem).digest().equals(expected),
    true,
    'decoded DER matches the direct export',
  )
})

// ---------- payload projection ----------

test('apnsPayload projects notify facts and marks urgent categories time-sensitive', () => {
  const base: PushNotification = {
    notificationId: 'n-42',
    category: 'approval.required',
    sessionId: 'session-abc',
    title: '需要批准',
    body: 'bash: pnpm install',
  }
  const payload = apnsPayload(base) as {
    aps: { alert: { title: string; body: string }; category: string; 'thread-id': string; 'interruption-level'?: string }
    sessionId: string
    kind: string
  }
  assert.equal(payload.aps.alert.title, '需要批准')
  assert.equal(payload.aps.alert.body, 'bash: pnpm install')
  assert.equal(payload.aps.category, 'approval.required')
  assert.equal(payload.aps['thread-id'], 'session-abc')
  assert.equal(payload.aps['interruption-level'], 'time-sensitive')
  assert.equal(payload.sessionId, 'session-abc')
  assert.equal(payload.kind, 'approval.required')

  const calm = apnsPayload({ ...base, category: 'turn.completed' }) as { aps: Record<string, unknown> }
  assert.equal(calm.aps['interruption-level'], undefined, 'turn completion stays a quiet delivery')
})

test('apnsPayload truncates oversized text and collapse ids stay ASCII-bounded', () => {
  const long: PushNotification = {
    notificationId: 'n-1',
    category: 'turn.completed',
    sessionId: '会话/标识 with 空格 and ümlaut',
    title: '标'.repeat(300),
    body: 'b'.repeat(500),
  }
  const payload = apnsPayload(long) as { aps: { alert: { title: string; body: string } } }
  assert.ok(payload.aps.alert.title.length <= 120)
  assert.ok(payload.aps.alert.body.length <= 200)

  const id = collapseIdFor(long)
  assert.ok(Buffer.byteLength(id, 'utf8') <= 64)
  assert.equal(/^[-a-zA-Z0-9.:]*$/.test(id), true, 'collapse id carries only APNs-safe characters')
  assert.notEqual(
    collapseIdFor({ ...long, sessionId: '会话甲' }),
    collapseIdFor({ ...long, sessionId: '会话乙' }),
    'non-ASCII session ids must not collapse onto the same empty suffix',
  )
})

// ---------- device registry ----------

test('push tokens persist per device, are idempotent, and can be pruned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pbb-push-store-'))
  try {
    const path = join(dir, 'devices.json')
    const store = await DeviceStore.load(path)
    const now = Date.now()
    store.touch({ deviceId: 'd1', deviceName: 'iPhone', appVersion: '0.1.0' }, now)

    store.setPushToken('d1', DEVICE_TOKEN_HEX.toUpperCase(), 'development', { 'turn.completed': false }, now)
    await store.drain()

    const reloaded = await DeviceStore.load(path)
    const [row] = reloaded.list()
    assert.equal(row.apns?.token, DEVICE_TOKEN_HEX, 'token normalized to lowercase hex and persisted')
    assert.equal(row.apns?.environment, 'development')
    assert.deepEqual(row.apns?.categories, { 'turn.completed': false })

    reloaded.setPushToken('d1', DEVICE_TOKEN_HEX, 'development', { 'turn.completed': false }, now + 5)
    await reloaded.drain()
    const after = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(after.devices[0].apns.updatedAt, now, 'unchanged registration does not rewrite updatedAt')

    reloaded.clearPushToken('d1')
    await reloaded.drain()
    const pruned = (await DeviceStore.load(path)).list()[0]
    assert.equal(pruned.apns, undefined, 'pruned registration disappears after reload')

    const junkStore = await DeviceStore.load(path)
    junkStore.setPushToken('d1', 'zzzz-not-hex', 'development', undefined, now + 10)
    assert.equal(junkStore.list()[0].apns, undefined, 'non-hex junk never enters the registry')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------- c2s.push.register over the wire ----------

test('push.register stores the token and answers ack', async () => {
  const h = await makeHarness()
  try {
    assert.equal(h.welcomeFrame?.type, 's2c.welcome', 'hello succeeded')
    assert.equal(h.welcomeFrame?.payload.capabilities.push, true, 'welcome advertises the push capability')
    assert.equal(h.capabilitiesAtHello.push, true)

    h.ws.receive({
      v: 1,
      type: 'c2s.push.register',
      id: 'pu1',
      payload: { deviceToken: DEVICE_TOKEN_HEX, environment: 'production', categories: { 'session.error': false } },
    })
    const ack = frameOfType(h.ws, 's2c.ack')
    assert.equal(ack?.id, 'pu1')

    await h.store.drain()
    const [row] = h.store.list()
    assert.equal(row.apns?.token, DEVICE_TOKEN_HEX)
    assert.equal(row.apns?.environment, 'production')
    assert.deepEqual(row.apns?.categories, { 'session.error': false })

    for (const line of h.logs) {
      assert.equal(line.includes(DEVICE_TOKEN_HEX), false, 'the raw token never reaches logs')
    }
  } finally {
    h.cleanup()
  }
})

test('push.register rejects malformed tokens and unsupported bridges', async () => {
  const withoutOutlet = await makeHarness({ withOutlet: false })
  try {
    assert.equal(withoutOutlet.welcomeFrame?.payload.capabilities.push, false, 'no outlet, no capability')
    withoutOutlet.ws.receive({
      v: 1,
      type: 'c2s.push.register',
      id: 'pu1',
      payload: { deviceToken: DEVICE_TOKEN_HEX, environment: 'development' },
    })
    assert.equal(frameOfType(withoutOutlet.ws, 's2c.error')?.payload.code, 'E_UNSUPPORTED')
    // Registration is stored pre-gate by design; flush before temp cleanup.
    await withoutOutlet.store.drain()

    withoutOutlet.ws.receive({
      v: 1,
      type: 'c2s.push.register',
      id: 'pu2',
      payload: { deviceToken: 'xyz', environment: 'development' },
    })
    const errors = withoutOutlet.ws.sent.filter((frame) => frame.type === 's2c.error' && frame.id === 'pu2')
    assert.equal(errors[0]?.payload.code, 'E_PROTOCOL')
  } finally {
    withoutOutlet.cleanup()
  }
})

// ---------- fan-out triggers ----------

test('turn end fans out one push per event with the same facts as s2c.notify', async () => {
  const h = await makeHarness()
  try {
    const collected: Array<{ type: string; payload: any }> = []
    h.bridge.addSink({
      push: (type, payload) => collected.push({ type, payload }),
      lastCursor: () => 0,
      replay: () => {},
      replayDone: () => {},
      resync: () => {},
    })
    h.getFeed()({
      type: 'session/event', rpcId: 'r1', sessionId: 'session-x',
      event: { type: 'assistant/message', seq: 10, data: { text: '修复完成，测试通过' } },
    })
    h.getFeed()({
      type: 'session/event', rpcId: 'r2', sessionId: 'session-x',
      event: { type: 'turn/end', seq: 11, data: { reason: { kind: 'completed' } } },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const notify = collected.find((f) => f.type === 's2c.notify')
    assert.ok(notify, 'ws data plane still receives the notify frame')
    const turnEndIndex = collected.findIndex((frame) =>
      frame.type === 's2c.session.event' && frame.payload.kind === 'turn.end')
    const notifyIndex = collected.findIndex((frame) => frame === notify)
    assert.ok(turnEndIndex >= 0 && turnEndIndex < notifyIndex,
      'turn state must precede its notification projection')
    assert.equal(h.fanOutCalls.length, 1, 'exactly one offline push mirrors the notify')
    const pushed = h.fanOutCalls[0]
    assert.equal(pushed.category, 'turn.completed')
    assert.equal(pushed.sessionId, 'session-x')
    assert.equal(pushed.title, '任务完成')
    assert.equal(pushed.body, '修复完成，测试通过')
    assert.equal(pushed.notificationId, notify.payload.notificationId, 'ids line up across channels')
  } finally {
    h.cleanup()
  }
})

test('approval and question requests fan out with banner-friendly bodies', async () => {
  const h = await makeHarness()
  try {
    h.getFeed()({
      type: 'approval/requested', rpcId: 'rpc-apr', approvalId: 'apr-9',
      sessionId: 'session-y', toolName: 'bash', reason: 'rm -rf /tmp/build',
    })
    h.getFeed()({
      type: 'question/requested', rpcId: 'rpc-q', sessionId: 'session-y',
      questions: [{ id: 'mode', question: '选择哪个方案？', options: [] }],
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(h.fanOutCalls.length, 2)
    const approval = h.fanOutCalls.find((n) => n.category === 'approval.required')
    assert.equal(approval?.title, '需要批准')
    assert.equal(approval?.body, 'bash: rm -rf /tmp/build')
    assert.equal(approval?.sessionId, 'session-y')

    const question = h.fanOutCalls.find((n) => n.category === 'question.asked')
    assert.equal(question?.title, '有问题需要回答')
    assert.equal(question?.body, '选择哪个方案？')
  } finally {
    h.cleanup()
  }
})

test('an app-presented enrollKey reaches the bridge before the capability gate', async () => {
  const withoutOutlet = await makeHarness({ withOutlet: false })
  try {
    // Fresh unconfigured bridge + distributed app carrying its built-in key:
    // the key must be surfaced to the host even though push is not enabled
    // yet — this is what flips relay mode on.
    assert.deepEqual(withoutOutlet.enrollKeys, [])
    withoutOutlet.ws.receive({
      v: 1,
      type: 'c2s.push.register',
      id: 'pu1',
      payload: { deviceToken: DEVICE_TOKEN_HEX, environment: 'development', enrollKey: 'distribute-me-2026' },
    })
    assert.deepEqual(withoutOutlet.enrollKeys, ['distribute-me-2026'])

    // Short junk keys are ignored rather than forwarded.
    withoutOutlet.ws.receive({
      v: 1,
      type: 'c2s.push.register',
      id: 'pu2',
      payload: { deviceToken: DEVICE_TOKEN_HEX, environment: 'development', enrollKey: 'short' },
    })
    assert.deepEqual(withoutOutlet.enrollKeys.length, 1)
    // The first register now stores its token pre-gate; let the registry
    // flush land before the harness removes the temp directory.
    await withoutOutlet.store.drain()
  } finally {
    withoutOutlet.cleanup()
  }
})

test('first register bootstraps relay mode: awaited enrollment yields ack(enabled) and stores token', async () => {
  const h = await makeHarness({ flipOnEnroll: true })
  try {
    assert.equal(h.welcomeFrame?.payload.capabilities.push, false, 'starts unconfigured')
    h.ws.receive({
      v: 1,
      type: 'c2s.push.register',
      id: 'pu1',
      payload: { deviceToken: DEVICE_TOKEN_HEX, environment: 'production', enrollKey: 'distribute-me-2026' },
    })
    // Enrollment round-trip inside onPushEnrollKey is awaited by the handler;
    // give the async chain time to settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await h.store.drain()

    const ack = frameOfType(h.ws, 's2c.ack')
    assert.equal(ack?.payload.enabled, true, 'ack reports post-enrollment readiness')
    const errors = h.ws.sent.filter((frame) => frame.type === 's2c.error' && frame.id === 'pu1')
    assert.equal(errors.length, 0, 'no E_UNSUPPORTED race on the very first register')

    const [row] = h.store.list()
    assert.equal(row.apns?.token, DEVICE_TOKEN_HEX, 'token stored on the bootstrap register')
    assert.equal(h.bridge.capabilities.push, true, 'capability flipped by enrollment')
  } finally {
    h.cleanup()
  }
})

// ---------- outcome handling ----------

test('APNs token classification preserves environment-mismatch evidence', () => {
  assert.equal(classifyApnsReason('Unregistered'), 'invalid-token')
  assert.equal(classifyApnsReason('ExpiredToken'), 'invalid-token')
  assert.equal(classifyApnsReason('BadDeviceToken'), 'failed')
  assert.equal(shouldPrunePushToken('invalid-token', 'Unregistered'), true)
  assert.equal(shouldPrunePushToken('invalid-token', 'BadDeviceToken'), false)
})

test('relay 401 self-heal applies only to the still-current zero-touch credential', () => {
  const zeroTouch = { usedCellToken: true, hasEnrollKey: true, tokenStillCurrent: true }
  assert.equal(shouldReEnrollRelayToken('relay', 'failed', 'HTTP 401', zeroTouch), true)
  // Registry rotation recovery only ever rides the exact credential-rejection
  // reason RelayClient produces; anything else must not drop the token.
  assert.equal(shouldReEnrollRelayToken('relay', 'failed', 'HTTP 500', zeroTouch), false)
  assert.equal(shouldReEnrollRelayToken('relay', 'failed', 'HTTP 429', zeroTouch), false)
  assert.equal(shouldReEnrollRelayToken('relay', 'sent', 'HTTP 401', zeroTouch), false)
  assert.equal(shouldReEnrollRelayToken('relay', 'invalid-token', 'Unregistered', zeroTouch), false)
  // Explicit relayToken configs are user settings, never rewritten silently.
  assert.equal(shouldReEnrollRelayToken('relay', 'failed', 'HTTP 401', { ...zeroTouch, usedCellToken: false }), false)
  // No enroll key means nothing to re-derive from.
  assert.equal(shouldReEnrollRelayToken('relay', 'failed', 'HTTP 401', { ...zeroTouch, hasEnrollKey: false }), false)
  // A slower request sent with the old token must not clear a credential that
  // an earlier 401 callback has already refreshed.
  assert.equal(shouldReEnrollRelayToken('relay', 'failed', 'HTTP 401', { ...zeroTouch, tokenStillCurrent: false }), false)
  // The local apns path has no relay credential to heal.
  assert.equal(shouldReEnrollRelayToken('apns', 'failed', 'HTTP 401', zeroTouch), false)
})

test('an unreadable APNs key degrades to a diagnostic failure', async () => {
  // The dispatcher in index.ts prunes on ApnsOutcome === 'invalid-token'.
  // This pins the client-side classification that drives that pruning.
  const client = new ApnsClient({
    teamId: 'T', keyId: 'K', keyPath: '/nonexistent/AuthKey.p8',
    bundleId: 'dev.hailab.deeppilot',
    log: () => {},
  })
  const result = await client.send({
    deviceToken: DEVICE_TOKEN_HEX,
    environment: 'development',
    notificationId: 'n-1',
    category: 'turn.completed',
    sessionId: 's',
    title: 't',
    body: 'b',
  })
  assert.equal(result.outcome, 'failed', 'an unreadable key degrades to failed instead of throwing')
  assert.ok(result.reason && result.reason.length > 0, 'failure carries a diagnostic reason')
})

// ---------- s2c.notify coverage for every category ----------

test('approval and question requests also emit s2c.notify frames (N1 protocol parity)', async () => {
  // Before N1 only turn.completed/session.error produced s2c.notify frames;
  // approval.required and question.asked only went to APNs. Online clients
  // subscribed to s2c.notify now miss approval/question banners; parity
  // with the protocol's four-category notify surface closes that gap.
  const h = await makeHarness()
  try {
    const collected: Array<{ type: string; payload: any; seq?: number }> = []
    h.bridge.addSink({
      push: (type, payload, seq) => collected.push({ type, payload, seq }),
      lastCursor: () => 0,
      replay: () => {},
      replayDone: () => {},
      resync: () => {},
    })
    h.getFeed()({
      type: 'approval/requested', rpcId: 'rpc-apr-n', approvalId: 'apr-n1',
      sessionId: 'session-n1', toolName: 'bash', reason: 'pnpm install',
    })
    h.getFeed()({
      type: 'question/requested', rpcId: 'rpc-q-n', sessionId: 'session-n1',
      questions: [{ id: 'mode', question: '选 A 还是 B？', options: [] }],
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const notifies = collected.filter((f) => f.type === 's2c.notify')
    assert.equal(notifies.length, 2, 'both approval and question must produce a notify frame')
    const approval = notifies.find((n) => n.payload.category === 'approval.required')
    const question = notifies.find((n) => n.payload.category === 'question.asked')
    assert.ok(approval, 'approval.required notify is present')
    assert.ok(question, 'question.asked notify is present')
    assert.equal(approval?.payload.title, '需要批准')
    assert.equal(approval?.payload.body, 'bash: pnpm install')
    assert.equal(approval?.payload.notificationId, 'apr-apr-n1', 'notificationId matches the APNs side')
    assert.equal(question?.payload.title, '有问题需要回答')
    assert.equal(question?.payload.body, '选 A 还是 B？')
    assert.equal(question?.payload.notificationId, 'q-rpc-q-n')

    const approvalPendingIndex = collected.findIndex((frame) =>
      frame.type === 's2c.pending.approval' && frame.payload.requestId === 'apr-n1')
    const approvalNotifyIndex = collected.findIndex((frame) => frame === approval)
    const questionPendingIndex = collected.findIndex((frame) =>
      frame.type === 's2c.pending.question' && frame.payload.requestId === 'q-rpc-q-n')
    const questionNotifyIndex = collected.findIndex((frame) => frame === question)
    assert.ok(approvalPendingIndex >= 0 && approvalPendingIndex < approvalNotifyIndex,
      'approval state must precede its notification projection')
    assert.ok(questionPendingIndex >= 0 && questionPendingIndex < questionNotifyIndex,
      'question state must precede its notification projection')

    // s2c.notify must carry a seq number so it joins the replay ring
    // (PROTOCOL §6 + §7). The seq lives at the envelope level; the BridgeSink
    // receives it as the third argument to push().
    assert.ok(typeof approval?.seq === 'number' && approval!.seq > 0)
    assert.ok(typeof question?.seq === 'number' && question!.seq > 0)
  } finally {
    h.cleanup()
  }
})

test('notify is suppressed for the device that is currently viewing the session', async () => {
  // F-9 rule: only devices that are not viewing the session get a notify.
  // The "viewer" sink must not see the approval notify for the same session.
  const h = await makeHarness()
  try {
    const viewerCollected: Array<{ type: string; payload: any }> = []
    const awayCollected: Array<{ type: string; payload: any }> = []
    const viewer = {
      push: (type: string, payload: any) => viewerCollected.push({ type, payload }),
      lastCursor: () => 0, replay: () => {}, replayDone: () => {}, resync: () => {},
    }
    const away = {
      push: (type: string, payload: any) => awayCollected.push({ type, payload }),
      lastCursor: () => 0, replay: () => {}, replayDone: () => {}, resync: () => {},
    }
    h.bridge.addSink(viewer)
    h.bridge.addSink(away)
    h.bridge.markSinkOpen(viewer, 'session-suppressed')

    h.getFeed()({
      type: 'approval/requested', rpcId: 'rpc-sup', approvalId: 'apr-sup',
      sessionId: 'session-suppressed', toolName: 'bash', reason: 'pnpm install',
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(
      viewerCollected.filter((f) => f.type === 's2c.notify').length, 0,
      'viewer must not receive the notify for the session it is on',
    )
    assert.equal(
      awayCollected.filter((f) => f.type === 's2c.notify').length, 1,
      'other devices still receive the notify',
    )
  } finally {
    h.cleanup()
  }
})
