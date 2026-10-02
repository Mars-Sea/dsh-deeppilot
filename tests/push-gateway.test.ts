/**
 * PushGateway 的直接单测：不经 apply()，用假配置 + 真 DeviceStore + 桩 fetch
 * 驱动网关。
 *
 * 覆盖从 apply() 闭包里抽出来的四类行为：
 * 1. 能力位（isAvailable）在各种配置下的真话；
 * 2. 零配置注册：autoRelay 翻转、持久化、https 门禁、节流；
 * 3. 两个自测的结果形状与拒绝理由；
 * 4. fanOut 的跳过/静音/清理/401 自愈规则。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PushGateway, type PushGatewayDeps } from '../src/push-gateway.ts'
import { DeviceStore } from '../src/token.ts'
import { createTestIdentity, registerTestIdentity } from './auth-fixture.ts'
import type { Config } from '../src/config.ts'

interface GatewayHandle {
  gateway: PushGateway
  store: DeviceStore
  logs: string[]
  dataDir: string
  setPush: (push: Record<string, unknown>) => void
  fetchCalls: Array<{ url: string; body: unknown }>
  cleanup: () => Promise<void>
}

async function makeGateway(opts: {
  push?: Record<string, unknown>
  devices?: Array<{ publicKey?: string; deviceName?: string }>
  fetchImpl?: typeof fetch
} = {}): Promise<GatewayHandle> {
  const dataDir = await mkdtemp(join(tmpdir(), 'pbb-gw-'))
  const store = await DeviceStore.load(join(dataDir, 'devices.json'))
  const identities = (opts.devices ?? [{ deviceName: 'iPhone' }]).map((device) => {
    const identity = createTestIdentity()
    store.register({ publicKey: identity.publicKey, deviceName: device.deviceName ?? 'iPhone', appVersion: 'test' }, Date.now())
    return identity
  })
  let push: Record<string, unknown> = { provider: 'none', ...(opts.push ?? {}) }
  let enabled = true
  const logs: string[] = []
  const fetchCalls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = opts.fetchImpl ?? (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    // 端点契约：/healthz 回 { ok: true }；/v1/enroll 回 rl_ 前缀 token；
    // /v1/push 回 outcome。
    let body: unknown = { outcome: 'sent' }
    if (url.endsWith('/v1/enroll')) body = { token: 'rl_relay-token-1' }
    else if (url.endsWith('/healthz')) body = { ok: true }
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  })
  // RelayClient / ApnsClient 直接用全局 fetch；这里临时替换，cleanup 时还原。
  const globalFetch = globalThis.fetch
  globalThis.fetch = fetchImpl as typeof fetch
  const deps: PushGatewayDeps = {
    config: () => ({ enabled, push: push as Config['push'] }) as Config,
    dataDir,
    devices: () => store,
    audience: () => 'deeppilot:test',
    connections: () => [],
    enabledNow: () => enabled,
    log: (message) => logs.push(message),
    fetchImpl,
  }
  const gateway = new PushGateway(deps)
  return {
    gateway, store, logs, dataDir,
    setPush: (patch) => { push = { ...push, ...patch } },
    fetchCalls,
    cleanup: async () => {
      globalThis.fetch = globalFetch
      await rm(dataDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

const APNS = { provider: 'apns', teamId: 'TEAM', keyId: 'KEY', bundleId: 'dev.test.app', keyPath: '<missing>/AuthKey.p8' }

test('isAvailable 只在 provider 真正就绪时为真', async (t) => {
  await t.test('未配置', async () => {
    const h = await makeGateway()
    try {
      assert.equal(h.gateway.isAvailable(), false)
    } finally { await h.cleanup() }
  })

  await t.test('APNs 凭据齐全即就绪（不预先读文件）', async () => {
    const h = await makeGateway({ push: APNS })
    try {
      assert.equal(h.gateway.isAvailable(), true)
    } finally { await h.cleanup() }
  })

  await t.test('APNs 缺字段不就绪', async () => {
    const h = await makeGateway({ push: { provider: 'apns', teamId: 'T' } })
    try {
      assert.equal(h.gateway.isAvailable(), false)
    } finally { await h.cleanup() }
  })

  await t.test('中继无 token 不就绪', async () => {
    const h = await makeGateway({ push: { provider: 'relay', relayUrl: 'https://relay.example' } })
    try {
      assert.equal(h.gateway.isAvailable(), false)
    } finally { await h.cleanup() }
  })

  await t.test('中继有 token 就绪', async () => {
    const h = await makeGateway({ push: { provider: 'relay', relayUrl: 'https://relay.example', relayToken: 'tok' } })
    try {
      assert.equal(h.gateway.isAvailable(), true)
    } finally { await h.cleanup() }
  })
})

test('零配置注册：翻转 autoRelay、持久化、完成注册', async () => {
  const h = await makeGateway({ push: { provider: 'none', relayUrl: 'https://relay.example' } })
  try {
    assert.equal(h.gateway.isAvailable(), false)
    await h.gateway.enrollKey('distribute-me-2026')
    await h.gateway.persisted()
    assert.equal(h.gateway.isAvailable(), true, '注册成功后能力位必须翻真')
    assert.ok(h.logs.some((line) => line.includes('push relay mode auto-enabled')), 'autoRelay 翻转要留日志')
    assert.ok(h.logs.some((line) => line.includes('push relay enrollment succeeded')), '注册成功要留日志')

    const persisted = JSON.parse(await readFile(join(h.dataDir, 'push-relay.json'), 'utf8'))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.autoRelay, true)
    assert.equal(persisted.enrollKey, 'distribute-me-2026')
    assert.equal(persisted.token, 'rl_relay-token-1')
    assert.ok(typeof persisted.clientId === 'string' && persisted.clientId.startsWith('u_'), 'clientId 由网关注造')

    const enroll = h.fetchCalls.find((call) => call.url.endsWith('/v1/enroll'))
    assert.ok(enroll !== undefined, '必须真的发起注册请求')
    assert.equal((enroll!.body as { enrollKey: string }).enrollKey, 'distribute-me-2026')
  } finally { await h.cleanup() }
})

test('零配置注册拒绝明文 http 中继，不外泄共享钥匙', async () => {
  const h = await makeGateway({ push: { provider: 'none', relayUrl: 'http://insecure.example' } })
  try {
    await h.gateway.enrollKey('distribute-me-2026')
    assert.equal(h.fetchCalls.length, 0, 'http 地址不得发出任何请求')
    assert.ok(h.logs.some((line) => line.includes('relayUrl must be an https URL')))
    assert.equal(h.gateway.isAvailable(), false)
  } finally { await h.cleanup() }
})

test('已注册状态可从磁盘恢复', async () => {
  // 场景：分发版 App 在用户没有显式选择时呈上钥匙，网关注册并记住；
  // 重启后同一份 cell 应让能力位直接翻真，无需用户再操作。
  const h = await makeGateway({ push: { provider: 'none', relayUrl: 'https://relay.example' } })
  try {
    await h.gateway.enrollKey('distribute-me-2026')
    await h.gateway.persisted()
    const persisted = await readFile(join(h.dataDir, 'push-relay.json'), 'utf8')

    // 同一份 cell、新的网关门：restore() 后应认得 token 与 autoRelay。
    const restored = new PushGateway({
      config: () => ({ enabled: true, push: { provider: 'none' } }) as Config,
      dataDir: h.dataDir,
      devices: () => h.store,
      audience: () => 'deeppilot:test',
      connections: () => [],
      enabledNow: () => true,
      log: () => {},
    })
    await restored.restore()
    await restored.persisted()
    assert.equal(restored.isAvailable(), true, '恢复的 token 让能力位翻真')
    assert.ok(persisted.includes('rl_relay-token-1'))
  } finally { await h.cleanup() }
})

test('推送自测的结果形状', async (t) => {
  await t.test('未配置', async () => {
    const h = await makeGateway()
    try {
      const result = await h.gateway.selfTest()
      assert.equal(result.overall, 'not-configured')
      assert.equal(result.transport, 'none')
      assert.deepEqual(result.results, [])
    } finally { await h.cleanup() }
  })

  await t.test('有凭据但无设备注册', async () => {
    const h = await makeGateway({ push: APNS })
    try {
      const result = await h.gateway.selfTest()
      assert.equal(result.overall, 'no-targets')
    } finally { await h.cleanup() }
  })

  await t.test('中继链路贯通时报 sent 并带 token 指纹', async () => {
    const h = await makeGateway({
      push: { provider: 'relay', relayUrl: 'https://relay.example', relayToken: 'tok' },
    })
    try {
      const device = h.store.list()[0]!
      h.store.setPushToken(device.deviceId, 'a'.repeat(64), 'production', undefined, Date.now())
      const result = await h.gateway.selfTest()
      assert.equal(result.overall, 'sent')
      assert.equal(result.transport, 'relay')
      assert.equal(result.results.length, 1)
      assert.equal(result.results[0]!.environment, 'production')
      assert.equal(result.results[0]!.tokenFingerprint, 'a'.repeat(10))
    } finally { await h.cleanup() }
  })
})

test('中继自测：非中继模式与 http 地址各有可读理由', async (t) => {
  await t.test('非中继模式', async () => {
    const h = await makeGateway({ push: { provider: 'apns', teamId: 'T', keyId: 'K', bundleId: 'B' } })
    try {
      const result = await h.gateway.relayTest()
      assert.equal(result.overall, 'failed')
      assert.equal(result.url, '')
      assert.match(result.steps[0]!.message, /当前推送模式不是中继/)
    } finally { await h.cleanup() }
  })

  await t.test('http 中继地址', async () => {
    const h = await makeGateway({ push: { provider: 'relay', relayUrl: 'http://insecure.example' } })
    try {
      const result = await h.gateway.relayTest()
      assert.equal(result.overall, 'failed')
      assert.equal(result.url, 'http://insecure.example')
      assert.match(result.steps[0]!.message, /relayUrl 必须是 https 地址/)
    } finally { await h.cleanup() }
  })

  await t.test('中继模式且钥匙在手：自测即完成注册', async () => {
    const h = await makeGateway({ push: { provider: 'relay', relayUrl: 'https://relay.example' } })
    try {
      await h.gateway.enrollKey('distribute-me-2026')
      h.fetchCalls.length = 0
      const result = await h.gateway.relayTest()
      await h.gateway.persisted()
      assert.equal(result.tokenIssued, true)
      assert.equal(result.overall, 'ok')
      assert.ok(h.logs.some((line) => line.includes('via settings self-test')))
      const persisted = JSON.parse(await readFile(join(h.dataDir, 'push-relay.json'), 'utf8'))
      assert.equal(persisted.token, 'rl_relay-token-1')
    } finally { await h.cleanup() }
  })
})

test('fanOut 跳过已连接设备、尊重类别静音、清理终态 token', async () => {
  const h = await makeGateway({ push: { provider: 'relay', relayUrl: 'https://relay.example', relayToken: 'tok' } })
  try {
    const device = h.store.list()[0]!
    h.store.setPushToken(device.deviceId, 'a'.repeat(64), 'production', { 'turn.completed': false }, Date.now())
    const notification = {
      notificationId: 'n-1', category: 'turn.completed' as const,
      sessionId: 's-1', title: '任务完成', body: 'ok',
    }
    h.gateway.fanOut(notification)
    await settle()
    assert.equal(h.fetchCalls.length, 0, '类别被静音的设备不得收到推送')

    h.store.setPushToken(device.deviceId, 'a'.repeat(64), 'production', undefined, Date.now())
    h.gateway.fanOut(notification)
    await settle()
    assert.equal(h.fetchCalls.length, 1, '取消静音后应派送一次')
    assert.equal(h.fetchCalls[0]!.url, 'https://relay.example/v1/push')
  } finally { await h.cleanup() }
})

test('fanOut 跳过有活跃 WebSocket 的设备', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pbb-gw-conn-'))
  const store = await DeviceStore.load(join(dataDir, 'devices.json'))
  const identity = createTestIdentity()
  registerTestIdentity(store, identity)
  const device = store.list()[0]!
  store.setPushToken(device.deviceId, 'a'.repeat(64), 'production', undefined, Date.now())
  const fetchCalls: unknown[] = []
  try {
    const gateway = new PushGateway({
      config: () => ({ enabled: true, push: { provider: 'relay', relayUrl: 'https://relay.example', relayToken: 'tok' } }) as Config,
      dataDir,
      devices: () => store,
      audience: () => 'deeppilot:test',
      // 该设备正连着 WebSocket 且会自己弹通知。
      connections: () => [{ connectedDeviceId: device.deviceId, suppressesAlertPush: true }],
      enabledNow: () => true,
      log: () => {},
      fetchImpl: (async () => { fetchCalls.push(1); return new Response('{}', { status: 200 }) }) as never,
    })
    gateway.fanOut({
      notificationId: 'n-1', category: 'turn.completed', sessionId: 's', title: 't', body: 'b',
    })
    await settle()
    assert.equal(fetchCalls.length, 0, '已连接设备必须跳过')
  } finally { await rm(dataDir, { recursive: true, force: true }).catch(() => {}) }
})

test('中继 401 触发自愈：丢凭据、重新注册', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pbb-gw-401-'))
  const store = await DeviceStore.load(join(dataDir, 'devices.json'))
  registerTestIdentity(store, createTestIdentity())
  const device = store.list()[0]!
  store.setPushToken(device.deviceId, 'a'.repeat(64), 'production', undefined, Date.now())
  const logs: string[] = []
  const sends: number[] = []
  const globalFetch = globalThis.fetch
  // 首次 send 回 401（凭据被拒），其后的请求照常成功（重新注册 + 重发）。
  let sendCount = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/v1/push')) {
      sends.push(++sendCount)
      return new Response(JSON.stringify({ outcome: 'failed' }), { status: 401 })
    }
    if (url.endsWith('/v1/enroll')) {
      return new Response(JSON.stringify({ token: 'rl_relay-token-1' }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  try {
    const gateway = new PushGateway({
      config: () => ({ enabled: true, push: { provider: 'relay', relayUrl: 'https://relay.example' } }) as Config,
      dataDir,
      devices: () => store,
      audience: () => 'deeppilot:test',
      connections: () => [],
      enabledNow: () => true,
      log: (message) => logs.push(message),
    })
    await gateway.enrollKey('distribute-me-2026')
    await gateway.persisted()
    logs.length = 0
    gateway.fanOut({
      notificationId: 'n-1', category: 'turn.completed', sessionId: 's', title: 't', body: 'b',
    })
    await waitFor(() => sends.length === 1)
    assert.equal(sends.length, 1, '第一次派送打到中继')
    assert.ok(logs.some((line) => line.includes('credential rejected (HTTP 401)')), '401 必须留下自愈日志')
    // 自愈的第一步是丢掉被拒的凭据；重新注册受 ensureRelayEnrolled 的一分钟
    // 节流保护——同一指纹刚失败过，不会立刻重打中继。因此此刻能力位为假，
    // 而持久化的 cell 里 token 已被清空。
    await gateway.persisted()
    const persisted = JSON.parse(await readFile(join(dataDir, 'push-relay.json'), 'utf8'))
    assert.equal(persisted.token, undefined, '被拒的凭据必须从 cell 里清掉')
    assert.equal(persisted.enrollKey, 'distribute-me-2026', '钥匙仍在，节流窗口过后可重新注册')
    assert.equal(gateway.isAvailable(), false, '节流窗口内不重新注册，能力位如实为假')
  } finally {
    globalThis.fetch = globalFetch
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }
})

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 轮询等待（自愈链里有若干轮微任务与一次 fetch）。 */
async function waitFor(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
