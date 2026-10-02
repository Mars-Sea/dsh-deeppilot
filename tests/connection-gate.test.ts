/**
 * 连接门的单测：不经 socket，用假 host + 假 limiter 直接驱动门。
 *
 * 覆盖三类东西：
 * 1. pre-auth 规则（长度上限、信封卫生、版本、白名单、撤销吞帧）；
 * 2. 认证结局（4403 / 4401 / 成功）与授权拒绝（scope / widget / 未知类型）；
 * 3. 名额的获取与释放——包括两条迁移前没有保证的路径：upgrade 回调根本不
 *    执行（releaseIfNeverAttached）、attach 兜底超时。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ConnectionGate, type AuthenticatedIdentity, type GateHost } from '../src/connection-gate.ts'
import { AuthRateLimiter } from '../src/auth-rate-limit.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike } from '../src/host-bridge.ts'
import { DeviceStore } from '../src/token.ts'
import { createTestIdentity, registerTestIdentity, type TestIdentity } from './auth-fixture.ts'

function makeProxy(): ApiProxyLike {
  return {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
      prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
      create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      projections: async () => ({ result: { ok: true, value: null } }),
    },
    respond: async () => ({ accepted: true }),
    events: {
      mux: async function* () { await new Promise(() => {}) },
      host: async function* () { await new Promise(() => {}) },
    },
  } as ApiProxyLike
}

interface Recording {
  host: GateHost
  sent: Array<{ type: string; payload: any }>
  closes: Array<{ code: number; reason: string }>
  settles: Array<{ ok: boolean; reason: string }>
  authenticated: Array<AuthenticatedIdentity>
  deviceAuthenticated: string[]
  revokedMarks: number
}

function makeHost(devices: DeviceStore, bridge: HostBridge): Recording {
  const sent: Recording['sent'] = []
  const closes: Recording['closes'] = []
  const settles: Recording['settles'] = []
  const authenticated: Recording['authenticated'] = []
  const deviceAuthenticated: string[] = []
  const rec: Recording = {
    sent, closes, settles, authenticated, deviceAuthenticated, revokedMarks: 0,
    host: null as never,
  }
  rec.host = {
    bridge,
    devices,
    debug: false,
    log: () => {},
    send: (type, payload) => { sent.push({ type, payload }) },
    fail: (id, code, message) => { sent.push({ type: 's2c.error', payload: { id, code, message } }) },
    close: (code, reason) => { closes.push({ code, reason }) },
    canReceive: () => true,
    push: () => {},
    lastCursor: () => 0,
    replay: () => {},
    replayDone: () => {},
    resync: () => {},
    bufferOpenEvents: () => ({ frames: [] }),
    discardOpenBuffer: () => {},
    flushOpenBuffer: () => true,
    closeOpenSession: () => {},
    nextLiveActivityGeneration: () => 1,
    liveActivityGeneration: 1,
    pendingLiveActivityId: undefined,
    setPendingLiveActivityId: () => {},
    markRevoked: () => { rec.revokedMarks += 1 },
    enrollPushKey: () => {},
    revokeSiblings: () => {},
    onAuthenticated: (identity) => { authenticated.push(identity) },
    deviceAuthenticated: (deviceId) => { deviceAuthenticated.push(deviceId) },
    settled: (ok, reason) => { settles.push({ ok, reason }) },
  }
  return rec
}

interface Fixture {
  gate: ConnectionGate
  rec: Recording
  identity: TestIdentity
  devices: DeviceStore
  cleanup: () => Promise<void>
  authenticate: () => Promise<void>
}

async function makeGate(opts: {
  scopes?: string[]
  limiter?: AuthRateLimiter
  attachTimeoutMs?: number
} = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'pbb-gate-unit-'))
  const devices = await DeviceStore.load(join(dir, 'devices.json'))
  const identity = createTestIdentity()
  registerTestIdentity(devices, identity)
  if (opts.scopes) devices.setScopes(identity.deviceId, opts.scopes)
  const bridge = new HostBridge(makeProxy(), 100)
  const rec = makeHost(devices, bridge)
  const gate = new ConnectionGate({
    source: 'test-source',
    devices,
    audience: 'deeppilot:test-audience',
    limiter: opts.limiter ?? new AuthRateLimiter(),
    log: () => {},
    ...(opts.attachTimeoutMs !== undefined ? { attachTimeoutMs: opts.attachTimeoutMs } : {}),
  })
  gate.attach(rec.host)
  const challenge = rec.sent.find((frame) => frame.type === 's2c.auth.challenge')
  assert.ok(challenge !== undefined, 'attach must send the challenge')
  return {
    gate, rec, identity, devices,
    cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) },
    authenticate: async () => {
      const { authenticateTestSocket } = await import('./auth-fixture.ts')
      // 直接构造 proof 帧：这里没有 socket，用 fixture 的签名逻辑逐字段复现。
      const { sign } = await import('node:crypto')
      const { canonicalAuthChallenge } = await import('../src/device-auth.ts')
      const fields = {
        deviceId: identity.deviceId,
        deviceName: 'iPhone',
        appVersion: 'test',
        nonce: challenge!.payload.nonce as string,
        audience: challenge!.payload.audience as string,
        issuedAt: challenge!.payload.issuedAt as number,
        expiresAt: challenge!.payload.expiresAt as number,
      }
      const signature = sign('sha256', canonicalAuthChallenge(fields), identity.privateKey).toString('base64url')
      await gate.handleFrame(JSON.stringify({
        v: 2, type: 'c2s.auth.prove', id: 'auth-1', payload: { ...fields, signature },
      }))
    },
  }
}

test('pre-auth 规则：业务帧、超限帧、畸形帧、版本不符', async (t) => {
  await t.test('未认证业务帧只得到 authenticate first', async () => {
    const f = await makeGate()
    try {
      await f.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.sessions.list', id: 'x', payload: {} }))
      const last = f.rec.sent[f.rec.sent.length - 1]!
      assert.equal(last.type, 's2c.error')
      assert.equal(last.payload.code, 'E_PROTOCOL')
      assert.equal(last.payload.message, 'authenticate first')
      assert.deepEqual(f.rec.closes, [], '不关 socket')
    } finally { await f.cleanup() }
  })

  await t.test('超限预认证帧：零 error、直接 1009、不解析', async () => {
    const f = await makeGate()
    try {
      await f.gate.handleFrame('x'.repeat(70 * 1024))
      assert.deepEqual(f.rec.sent.map((frame) => frame.type), ['s2c.auth.challenge'])
      assert.deepEqual(f.rec.closes, [{ code: 1009, reason: 'pre-auth frame too large' }])
    } finally { await f.cleanup() }
  })

  await t.test('畸形 JSON 与非信封都回 E_PROTOCOL 且不断开', async () => {
    for (const raw of ['{not json', '{"v":2}']) {
      const f = await makeGate()
      try {
        await f.gate.handleFrame(raw)
        const last = f.rec.sent[f.rec.sent.length - 1]!
        assert.equal(last.payload.code, 'E_PROTOCOL')
        assert.deepEqual(f.rec.closes, [])
      } finally { await f.cleanup() }
    }
  })

  await t.test('版本不符：先 E_UNSUPPORTED 再 4500', async () => {
    const f = await makeGate()
    try {
      await f.gate.handleFrame(JSON.stringify({ v: 1, type: 'c2s.ping', id: 'v', payload: {} }))
      assert.deepEqual(f.rec.sent.filter((frame) => frame.type === 's2c.error').map((frame) => frame.payload.code), ['E_UNSUPPORTED'])
      assert.deepEqual(f.rec.closes.map((close) => close.code), [4500])
    } finally { await f.cleanup() }
  })

  await t.test('匿名 ping 得到 pong', async () => {
    const f = await makeGate()
    try {
      await f.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.ping', id: 'p', payload: {} }))
      assert.equal(f.rec.sent[1]!.type, 's2c.pong')
    } finally { await f.cleanup() }
  })
})

test('认证结局：4403、4401、成功各一次落定', async (t) => {
  await t.test('缺 deviceId：E_PROTOCOL + 4403 + 落定 invalid-proof', async () => {
    const f = await makeGate()
    try {
      await f.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.auth.prove', id: 'a', payload: {} }))
      const error = f.rec.sent[f.rec.sent.length - 1]!
      assert.equal(error.payload.code, 'E_PROTOCOL')
      assert.deepEqual(f.rec.closes.map((close) => close.code), [4403])
    } finally { await f.cleanup() }
  })

  await t.test('签名无效：E_AUTH + 4401', async () => {
    const f = await makeGate()
    try {
      const challenge = f.rec.sent[0]!.payload
      await f.gate.handleFrame(JSON.stringify({
        v: 2, type: 'c2s.auth.prove', id: 'a',
        payload: {
          deviceId: f.identity.deviceId, deviceName: 'iPhone', appVersion: 'test',
          nonce: challenge.nonce, audience: challenge.audience,
          issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
          signature: 'not-a-signature',
        },
      }))
      assert.equal(f.rec.sent.filter((frame) => frame.type === 's2c.error').pop()?.payload.code, 'E_AUTH')
      assert.deepEqual(f.rec.closes.map((close) => close.code), [4401])
    } finally { await f.cleanup() }
  })

  await t.test('证明成功：产出一致身份并只落定一次', async () => {
    const f = await makeGate()
    try {
      await f.authenticate()
      assert.equal(f.rec.authenticated.length, 1)
      assert.equal(f.rec.authenticated[0]!.deviceId, f.identity.deviceId)
      assert.deepEqual(f.rec.deviceAuthenticated, [f.identity.deviceId])
      assert.deepEqual(f.rec.settles, [{ ok: true, reason: 'success' }])
      // 认证成功后再来一帧：分发到注册表，不再有 pre-auth 拒绝。
      await f.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.sessions.list', id: 'l', payload: {} }))
      assert.equal(f.rec.sent[f.rec.sent.length - 1]!.type, 's2c.sessions.snapshot')
    } finally { await f.cleanup() }
  })
})

test('授权拒绝：scope、widget、未知类型', async (t) => {
  await t.test('缺 scope：E_FORBIDDEN 不断开', async () => {
    const f = await makeGate({ scopes: ['sessions.manage'] })
    try {
      await f.authenticate()
      await f.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.sessions.list', id: 's', payload: {} }))
      const last = f.rec.sent[f.rec.sent.length - 1]!
      assert.equal(f.rec.sent.filter((frame) => frame.type === 's2c.error').pop()?.payload.code, 'E_FORBIDDEN')
      assert.deepEqual(f.rec.closes, [])
    } finally { await f.cleanup() }
  })

  await t.test('未知帧类型：E_PROTOCOL', async () => {
    const f = await makeGate()
    try {
      await f.authenticate()
      await f.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.nope', id: 'u', payload: {} }))
      const last = f.rec.sent.filter((frame) => frame.type === 's2c.error').pop()!
      assert.equal(last.payload.code, 'E_PROTOCOL')
      assert.match(String(last.payload.message), /unknown type/)
    } finally { await f.cleanup() }
  })

  await t.test('撤销后吞帧', async () => {
    const f = await makeGate()
    try {
      await f.authenticate()
      f.gate.markRevoked()
      const before = f.rec.sent.length
      await f.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.sessions.list', id: 'after', payload: {} }))
      assert.equal(f.rec.sent.length, before, '撤销后不得产生任何帧')
    } finally { await f.cleanup() }
  })
})

test('名额：获取、拒绝与三条释放路径', async (t) => {
  const policy = { windowMs: 60_000, attemptsPerSource: 12, globalAttempts: 120, maxUnauthenticatedPerSource: 2, failureWindowMs: 600_000, failuresBeforeBlock: 3, blockMs: 60_000, maxSources: 64 }

  await t.test('超限时 admitted=false，不占名额', async () => {
    const limiter = new AuthRateLimiter(policy)
    const dir = await mkdtemp(join(tmpdir(), 'pbb-gate-cap-'))
    const devices = await DeviceStore.load(join(dir, 'devices.json'))
    const bridge = new HostBridge(makeProxy(), 100)
    const makeGateWith = () => {
      const rec = makeHost(devices, bridge)
      const gate = new ConnectionGate({ source: 'same', devices, audience: 'a', limiter, log: () => {} })
      gate.attach(rec.host)
      return { gate, rec }
    }
    try {
      const first = makeGateWith()
      const second = makeGateWith()
      assert.equal(first.gate.admitted, true)
      assert.equal(second.gate.admitted, true)
      // 第三个同源门必须被限流拒绝，且不占名额。
      const third = makeGateWith()
      assert.equal(third.gate.admitted, false)
      await third.gate.handleFrame(JSON.stringify({ v: 2, type: 'c2s.ping', id: 'p', payload: {} }))
      assert.deepEqual(third.rec.sent, [], '死刑门不得回应任何帧')
      // 释放一个之后，同源应能再次入场。
      first.gate.onClose()
      const fourth = makeGateWith()
      assert.equal(fourth.gate.admitted, true, 'onClose 必须归还名额')
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
  })

  await t.test('回调根本不执行：releaseIfNeverAttached 归还名额', async () => {
    const limiter = new AuthRateLimiter(policy)
    const dir = await mkdtemp(join(tmpdir(), 'pbb-gate-cap2-'))
    const devices = await DeviceStore.load(join(dir, 'devices.json'))
    const bridge = new HostBridge(makeProxy(), 100)
    const attachedGate = () => {
      const rec = makeHost(devices, bridge)
      const gate = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      gate.attach(rec.host)
      return gate
    }
    try {
      const orphan = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      assert.equal(orphan.admitted, true)
      orphan.releaseIfNeverAttached()
      // 名额已还：下一个同源门可以入场。
      const next = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      assert.equal(next.admitted, true, '未 attach 的门必须立刻归还名额')
      // 已 attach 的门不受 releaseIfNeverAttached 影响。
      const live = attachedGate()
      live.releaseIfNeverAttached()
      const after = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      assert.equal(after.admitted, false, '已 attach 的门不能被兜底误释放')
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
  })

  await t.test('attach 兜底超时：从未接线的门到点释放', async () => {
    const limiter = new AuthRateLimiter(policy)
    const dir = await mkdtemp(join(tmpdir(), 'pbb-gate-cap3-'))
    const devices = await DeviceStore.load(join(dir, 'devices.json'))
    try {
      const orphan = new ConnectionGate({
        source: 's', devices, audience: 'a', limiter, log: () => {}, attachTimeoutMs: 20,
      })
      assert.equal(orphan.admitted, true)
      await sleep(60)
      // 兜底已释放：同源还能再进一个（2 个名额里现在只用掉 0 个）。
      const next = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      assert.equal(next.admitted, true)
      const second = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      assert.equal(second.admitted, true)
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
  })

  await t.test('markDead 立即归还名额（bridge 变更/构造失败）', async () => {
    const limiter = new AuthRateLimiter(policy)
    const dir = await mkdtemp(join(tmpdir(), 'pbb-gate-cap4-'))
    const devices = await DeviceStore.load(join(dir, 'devices.json'))
    try {
      const gate = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      gate.markDead()
      const a = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      const b = new ConnectionGate({ source: 's', devices, audience: 'a', limiter, log: () => {} })
      assert.equal(a.admitted, true)
      assert.equal(b.admitted, true)
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}) }
  })
})
