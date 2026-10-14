import assert from 'node:assert/strict'
import { sign } from 'node:crypto'
import test from 'node:test'
import { BridgeConnection } from '../src/connection.ts'
import { AuthRateLimiter, DEFAULT_AUTH_RATE_POLICY } from '../src/auth-rate-limit.ts'
import { canonicalAuthChallenge, type AuthProofFields } from '../src/device-auth.ts'
import { createTestIdentity, type TestIdentity } from './auth-fixture.ts'
import { FakeWebSocket, makeConnection, type Harness } from './connection-gate-scenarios.ts'

// Adversarial coverage for the anonymous authentication path (PROTOCOL.md,
// auth.challenge / auth.prove). The happy path and the individual rejection
// rules live in connection.test.ts and connection-gate.test.ts; this file
// attacks the seams: proofs captured from one socket and replayed on another,
// stale challenges, hostile field types, and floods of garbage.

const lastFrame = (ws: FakeWebSocket) => ws.sent[ws.sent.length - 1]
const challengeOf = (ws: FakeWebSocket) => ws.sent.find((frame) => frame.type === 's2c.auth.challenge').payload as {
  nonce: string; audience: string; issuedAt: number; expiresAt: number
}

/** A second socket against the same Host registry, as a reconnecting or hostile client would open. */
function openSibling(host: Harness): FakeWebSocket {
  const ws = new FakeWebSocket()
  new BridgeConnection(ws as never, {
    bridge: host.bridge,
    devices: host.store,
    serverVersion: 'test',
    audience: 'deeppilot:test-audience',
    log: () => {},
  })
  return ws
}

function proofFields(identity: TestIdentity, challenge: ReturnType<typeof challengeOf>, extra: Partial<AuthProofFields> = {}): AuthProofFields {
  return {
    deviceId: identity.deviceId,
    deviceName: 'iPhone',
    appVersion: 'test',
    nonce: challenge.nonce,
    audience: challenge.audience,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    ...extra,
  }
}

function proveFrame(identity: TestIdentity, fields: AuthProofFields, signature?: unknown): unknown {
  const signed = sign('sha256', canonicalAuthChallenge(fields), identity.privateKey).toString('base64url')
  return { v: 2, type: 'c2s.auth.prove', id: 'auth-x', payload: { ...fields, signature: signature ?? signed } }
}

function assertRejected(ws: FakeWebSocket, host: Harness, label: string): void {
  assert.equal(ws.sent.some((frame) => frame.type === 's2c.welcome'), false, `${label}: must not welcome`)
  assert.ok(ws.closes.length > 0 || ws.terminated, `${label}: socket must be closed or terminated`)
  assert.equal(host.store.list().length, 1, `${label}: no device may be registered or duplicated`)
}

test('a proof captured from one socket is useless on another socket', async () => {
  const host = await makeConnection()
  try {
    const challengeA = challengeOf(host.ws)
    const captured = proveFrame(host.identity, proofFields(host.identity, challengeA))

    // The attacker never sees the private key, only the frame bytes on the wire.
    const replay = openSibling(host)
    assert.notEqual(challengeOf(replay).nonce, challengeA.nonce, 'every socket draws its own nonce')
    replay.receive(captured)
    assert.equal(lastFrame(replay).type, 's2c.error')
    assert.equal(lastFrame(replay).payload.code, 'E_AUTH')
    assert.deepEqual(replay.closes.map((entry) => entry.code), [4401])

    // The original socket is unaffected and still authenticates with the same bytes.
    host.ws.receive(captured)
    assert.equal(lastFrame(host.ws).type, 's2c.welcome')
  } finally {
    await host.cleanup()
  }
})

// FINDING (2026-10-12), behaviour not changed here: c2s.auth.prove is accepted
// again on an already-authenticated socket, so replaying the same frame inside
// the 30 s challenge window re-sends s2c.welcome and re-runs resume replay.
// It is not an escalation (the sink set is idempotent and a different identity
// would still need that device's key), but it lets a connected peer force
// repeated replays. Desired: the gate answers E_PROTOCOL and does nothing.
// Remove `todo` once the gate rejects a second prove.
test('a proof replayed after success does not re-authenticate or welcome twice', {
  todo: 'authenticated sockets still accept a second c2s.auth.prove',
}, async () => {
  const host = await makeConnection()
  try {
    const frame = proveFrame(host.identity, proofFields(host.identity, challengeOf(host.ws)))
    host.ws.receive(frame)
    const welcomes = () => host.ws.sent.filter((entry) => entry.type === 's2c.welcome').length
    assert.equal(welcomes(), 1)

    host.ws.receive(frame)
    host.ws.receive(frame)

    assert.equal(welcomes(), 1, 'replay on the authenticated socket must not produce another welcome')
    assert.equal(host.settleEvents.length, 1, 'authentication settles exactly once')
    assert.equal(host.store.list().length, 1)
  } finally {
    await host.cleanup()
  }
})

test('an expired challenge is refused even with a valid signature', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const host = await makeConnection()
  try {
    const challenge = challengeOf(host.ws)
    const frame = proveFrame(host.identity, proofFields(host.identity, challenge))
    t.mock.timers.tick(challenge.expiresAt - challenge.issuedAt + 1)
    host.ws.receive(frame)
    assert.equal(lastFrame(host.ws).payload.code, 'E_AUTH')
    assertRejected(host.ws, host, 'expired challenge')
  } finally {
    await host.cleanup()
  }
})

test('a challenge field altered by the client fails even when re-signed over the altered value', async () => {
  const host = await makeConnection()
  try {
    const alterations: Array<[
      keyof ReturnType<typeof challengeOf>,
      (challenge: ReturnType<typeof challengeOf>) => Partial<AuthProofFields>,
    ]> = [
      ['nonce', (challenge) => ({ nonce: `${challenge.nonce}-altered` })],
      ['audience', (challenge) => ({ audience: `${challenge.audience}:altered` })],
      ['issuedAt', (challenge) => ({ issuedAt: challenge.issuedAt + 1 })],
      ['expiresAt', (challenge) => ({ expiresAt: challenge.expiresAt + 60_000 })],
    ]
    for (const [label, alter] of alterations) {
      const ws = openSibling(host)
      const own = challengeOf(ws)
      // 每个连接独立签发挑战；沿用首个连接的时间加 1 毫秒，可能恰好等于
      // 后续连接的原始时间，导致所谓篡改输入实际上仍然合法。
      const change = alter(own)
      assert.notEqual(change[label], own[label], `${label}: 测试必须确实篡改当前连接的挑战`)
      // The signature is genuine for the altered tuple: only the server-side
      // comparison against the challenge it issued can reject this.
      ws.receive(proveFrame(host.identity, proofFields(host.identity, own, change)))
      assert.equal(lastFrame(ws).payload.code, 'E_AUTH', label)
      assertRejected(ws, host, label)
    }
  } finally {
    await host.cleanup()
  }
})

test('malformed signatures are rejected without throwing', async () => {
  const hostile: Array<[string, unknown]> = [
    ['missing', undefined],
    ['number', 12345],
    ['null', null],
    ['object', { r: 1, s: 2 }],
    ['empty string', ''],
    ['not base64url', '!!!!not-base64!!!!'],
    ['too short (63 bytes)', Buffer.alloc(63, 1).toString('base64url')],
    ['too long (81 bytes)', Buffer.alloc(81, 1).toString('base64url')],
    ['right length, garbage DER', Buffer.alloc(70, 0xff).toString('base64url')],
    ['all zero DER-length', Buffer.alloc(72).toString('base64url')],
  ]
  for (const [label, signature] of hostile) {
    const host = await makeConnection()
    try {
      const fields = proofFields(host.identity, challengeOf(host.ws))
      const payload: Record<string, unknown> = { ...fields }
      if (signature !== undefined) payload.signature = signature
      host.ws.receive({ v: 2, type: 'c2s.auth.prove', id: 'a', payload })
      assert.equal(lastFrame(host.ws).payload.code, 'E_AUTH', label)
      assertRejected(host.ws, host, label)
    } finally {
      await host.cleanup()
    }
  }
})

test('a valid signature from a different key never authenticates a registered deviceId', async () => {
  const host = await makeConnection()
  try {
    const stranger = createTestIdentity()
    const fields = proofFields(host.identity, challengeOf(host.ws)) // claims the registered device
    host.ws.receive(proveFrame(stranger, fields)) // but is signed by an unregistered key
    assert.equal(lastFrame(host.ws).payload.code, 'E_AUTH')
    assertRejected(host.ws, host, 'foreign key')
  } finally {
    await host.cleanup()
  }
})

test('a resume cursor that is not a non-negative integer cannot authenticate', async () => {
  // The server drops such a cursor before building the canonical string, so a
  // client that signed the raw value produces a different string and fails.
  const cursors: Array<[string, unknown]> = [
    ['negative', -1], ['fractional', 1.5], ['string', '42'], ['null', null], ['infinity as JSON null', Infinity],
  ]
  for (const [label, cursor] of cursors) {
    const host = await makeConnection()
    try {
      const fields = proofFields(host.identity, challengeOf(host.ws))
      const signed = sign('sha256', canonicalAuthChallenge({ ...fields, resumeCursor: cursor as number }), host.identity.privateKey).toString('base64url')
      host.ws.receive({ v: 2, type: 'c2s.auth.prove', id: 'a', payload: { ...fields, resumeCursor: cursor, signature: signed } })
      assert.equal(lastFrame(host.ws).payload.code, 'E_AUTH', label)
      assertRejected(host.ws, host, label)
    } finally {
      await host.cleanup()
    }
  }
})

test('hostile deviceId and payload shapes close cleanly instead of crashing the host', async () => {
  const payloads: Array<[string, unknown]> = [
    ['payload null', null],
    ['payload string', 'hello'],
    ['payload array', []],
    ['payload empty object', {}],
    ['deviceId number', { deviceId: 7 }],
    ['deviceId object', { deviceId: { a: 1 } }],
    ['deviceId with throwing toString', { deviceId: { toString: 'not callable' } }],
    ['deviceId array', { deviceId: ['a'] }],
    ['deviceId empty', { deviceId: '' }],
    ['deviceId only control chars', { deviceId: '\n\t\u0000' }],
    ['deviceId enormous', { deviceId: 'd'.repeat(20_000) }],
    ['deviceId unknown', { deviceId: 'no-such-device', signature: 'AAAA' }],
  ]
  for (const [label, payload] of payloads) {
    const host = await makeConnection()
    try {
      host.ws.receive({ v: 2, type: 'c2s.auth.prove', id: 'a', payload })
      await new Promise((resolve) => setImmediate(resolve)) // the gate handles frames asynchronously
      // Shape mistakes get an error frame; a value that makes the handler throw
      // (an object whose toString is not callable) must instead drop only this
      // socket - connection.ts terminates it rather than failing the host.
      assert.ok(lastFrame(host.ws).type === 's2c.error' || host.ws.terminated, label)
      assertRejected(host.ws, host, label)
    } finally {
      await host.cleanup()
    }
  }
})

test('a barrage of garbage frames never authenticates and never wedges the socket', async () => {
  const host = await makeConnection()
  try {
    // Deterministic xorshift so a failure reproduces.
    let state = 0x2545f491
    const next = () => {
      state ^= state << 13; state >>>= 0
      state ^= state >>> 17
      state ^= state << 5; state >>>= 0
      return state
    }
    const pick = <T>(items: T[]): T => items[next() % items.length]!
    const junkValues: unknown[] = [null, true, 0, -1, 1e308, '', 'x', '\u0000', [], {}, [[]], { a: { b: [1, 2, { c: null }] } }]
    const types = ['c2s.auth.prove', 'c2s.ping', 'c2s.sessions.list', 'c2s.prompt', '', 'S2C.WELCOME', 'c2s.__proto__', 'constructor', 'toString']
    const deepArray = '['.repeat(20_000) + ']'.repeat(20_000) // within the 64 KiB pre-auth cap, deep enough to stress JSON.parse

    for (let index = 0; index < 3_000; index += 1) {
      const kind = next() % 6
      if (kind === 0) {
        host.ws.receiveRaw(Buffer.from(Array.from({ length: next() % 200 }, () => next() & 0xff)).toString('latin1'))
      } else if (kind === 1) {
        host.ws.receiveRaw('{"v":2,"type":"c2s.sessions.list"'.slice(0, next() % 33)) // truncated JSON
      } else if (kind === 2) {
        host.ws.receiveRaw(deepArray)
      } else if (kind === 3) {
        host.ws.receive({ v: 2, type: pick(types), id: pick(junkValues), payload: pick(junkValues) })
      } else if (kind === 4) {
        host.ws.receive({ v: 2, type: pick(types), payload: { deviceId: pick(junkValues), signature: pick(junkValues), nonce: pick(junkValues) } })
      } else {
        host.ws.receive(pick(junkValues))
      }
      if (host.ws.closes.length > 0) break // a deliberate close (e.g. repeated bad proof) is an acceptable outcome
    }

    assert.equal(host.ws.sent.some((frame) => frame.type === 's2c.welcome'), false, 'garbage must never authenticate')
    assert.equal(host.ws.terminated, false)
    for (const frame of host.ws.sent) {
      if (frame.type === 's2c.error') assert.match(frame.payload.code, /^E_[A-Z]+$/)
    }

    if (host.ws.closes.length === 0) {
      // Still open: a genuine proof must still work after the abuse.
      host.ws.receive(proveFrame(host.identity, proofFields(host.identity, challengeOf(host.ws))))
      assert.equal(lastFrame(host.ws).type, 's2c.welcome', 'socket survived the barrage')
    }
  } finally {
    await host.cleanup()
  }
})

// ---------- admission control under churn and multi-source pressure ----------

test('connection churn from one source is capped, then recovers after the window', () => {
  const limiter = new AuthRateLimiter(DEFAULT_AUTH_RATE_POLICY)
  const { attemptsPerSource, windowMs } = DEFAULT_AUTH_RATE_POLICY
  let admitted = 0
  // A flapping client that connects and drops immediately, 10 times a second.
  for (let step = 0; step < attemptsPerSource * 3; step += 1) {
    const admission = limiter.admit('flapper', step * 100)
    if (admission.ok) {
      admitted += 1
      admission.release()
    }
  }
  assert.equal(admitted, attemptsPerSource, 'only attemptsPerSource connects fit in one window')
  assert.equal(limiter.admit('flapper', windowMs * 2).ok, true, 'capacity returns once the window rolls over')
})

test('a normally backing-off phone is never throttled', () => {
  // App reconnect policy: exponential 1s -> 30s with jitter (PRD M-7).
  const limiter = new AuthRateLimiter(DEFAULT_AUTH_RATE_POLICY)
  let now = 0
  let delay = 1_000
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const admission = limiter.admit('phone', now)
    assert.equal(admission.ok, true, `attempt ${attempt} at t=${now}ms`)
    admission.release()
    limiter.recordSuccess('phone', now)
    now += delay
    delay = Math.min(delay * 2, 30_000)
  }
})

test('one abusive source is blocked without affecting other sources', () => {
  const limiter = new AuthRateLimiter(DEFAULT_AUTH_RATE_POLICY)
  for (let index = 0; index < DEFAULT_AUTH_RATE_POLICY.failuresBeforeBlock; index += 1) {
    limiter.recordFailure('attacker', index)
  }
  assert.equal(limiter.admit('attacker', 10).ok, false)
  assert.equal(limiter.admit('bystander', 10).ok, true)
  // Blocking is by source, not by credential: even a legitimate device behind
  // the same address is refused until the block lapses. That is the intended
  // trade-off, pinned here so loosening it is a conscious change.
  assert.equal(limiter.admit('attacker', DEFAULT_AUTH_RATE_POLICY.blockMs - 1).ok, false)
  assert.equal(limiter.admit('attacker', DEFAULT_AUTH_RATE_POLICY.blockMs + 100).ok, true)
})

test('the source table stays bounded under a many-source flood and sheds only stale entries', () => {
  // The default policy cannot fill its table: the global budget admits 120
  // attempts a minute while entries age out after 15 minutes. A small table
  // makes the bound itself observable.
  const policy = { ...DEFAULT_AUTH_RATE_POLICY, maxSources: 50, globalAttempts: 10_000 }
  const limiter = new AuthRateLimiter(policy)
  let admitted = 0
  const live: Array<{ release: () => void }> = []
  for (let index = 0; index < 200; index += 1) {
    const admission = limiter.admit(`10.0.0.${index}`, index) // all within one minute: nothing is stale yet
    if (admission.ok) { admitted += 1; live.push(admission) }
  }
  assert.equal(admitted, policy.maxSources, 'table admits at most maxSources distinct sources')
  assert.equal(limiter.admit('overflow', 1_000).ok, false, 'a new source is refused while the table is full of live entries')
  assert.equal(limiter.admit('10.0.0.3', 1_000).ok, true, 'a source already in the table is still served')

  // Entries with open sockets are never evicted, however old.
  const later = Math.max(policy.failureWindowMs, policy.blockMs) + 10_000
  assert.equal(limiter.admit('still-full', later).ok, false, 'sources with active handshakes are not shed')

  // Once their sockets close and they age out, room returns.
  for (const admission of live) admission.release()
  assert.equal(limiter.admit('after-release', later).ok, true, 'idle, stale sources are shed to make room')
})

test('the global attempt budget caps a distributed flood and recovers', () => {
  const limiter = new AuthRateLimiter(DEFAULT_AUTH_RATE_POLICY)
  const { globalAttempts, windowMs } = DEFAULT_AUTH_RATE_POLICY
  let admitted = 0
  for (let index = 0; index < globalAttempts * 3; index += 1) {
    const admission = limiter.admit(`src-${index}`, index) // one new source per ms, all inside one window
    if (admission.ok) { admitted += 1; admission.release() }
  }
  assert.equal(admitted, globalAttempts)
  assert.equal(limiter.admit('late', windowMs * 3).ok, true)
})
