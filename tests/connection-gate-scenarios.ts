/**
 * 连接门对等测试共用的场景集与输出签名。
 *
 * 用真实 socket 驱动 BridgeConnection，覆盖全部关闭码（1001/1009/1013/4401/
 * 4402/4403/4500）、四种认证结局、scope/widget/未知类型三类拒绝、撤销语义与
 * 若干时序约束。输出签名只保留与本次迁移相关的部分：帧类型、错误码、关键
 * payload 字段、关闭码与 terminated 标志（ts 与 bridge 的 seq 是时间/游标
 * 派生量，刻意忽略）。
 *
 * 迁移到 ConnectionGate 后，同一组场景必须产出同一份签名。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeConnection } from '../src/connection.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike } from '../src/host-bridge.ts'
import { DeviceStore } from '../src/token.ts'
import type { DeviceScope } from '../src/device-auth.ts'
import { authenticateTestSocket, createTestIdentity, registerTestIdentity } from './auth-fixture.ts'

export interface ScenarioResult {
  frames: string[]
  closes: Array<number | undefined>
  terminated: boolean
}

export class FakeWebSocket {
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

  send(data: string): void { this.sent.push(JSON.parse(data)) }

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

  receive(payload: unknown): void {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(payload)))
  }

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
      projections: async () => ({ result: { ok: true, value: null } }),
    },
    respond: async () => ({ accepted: true }),
    events: {
      mux: async function* () { await new Promise(() => {}) },
      host: async function* () { await new Promise(() => {}) },
    },
    ...overrides,
  } as ApiProxyLike
}

export interface Harness {
  ws: FakeWebSocket
  connection: BridgeConnection
  bridge: HostBridge
  store: DeviceStore
  identity: ReturnType<typeof createTestIdentity>
  authenticate: (overrides?: { resumeCursor?: number; clientRole?: 'widget'; signature?: string }) => void
  settleEvents: Array<{ ok: boolean; reason: string }>
  cleanup: () => Promise<void>
}

export async function makeConnection(opts: {
  scopes?: DeviceScope[]
  historyFails?: boolean
  onDeviceRevoke?: (deviceId: string, except: BridgeConnection) => Promise<unknown> | unknown
} = {}): Promise<Harness> {
  const bridge = new HostBridge(makeProxy(opts.historyFails === true ? {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async () => ({ result: { ok: false, error: { code: 'session-not-found' } } }),
      prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
      create: async () => ({ result: { ok: true, value: { sessionId: 's-new' } } }),
      projections: async () => ({ result: { ok: true, value: null } }),
    },
  } as unknown as Partial<ApiProxyLike> : {}), 100)
  const dir = await mkdtemp(join(tmpdir(), 'pbb-gate-'))
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  const identity = createTestIdentity()
  registerTestIdentity(store, identity)
  if (opts.scopes) store.setScopes(identity.deviceId, opts.scopes)
  const ws = new FakeWebSocket()
  const settleEvents: Array<{ ok: boolean; reason: string }> = []
  const connection = new BridgeConnection(ws as never, {
    bridge,
    devices: store,
    serverVersion: 'test',
    audience: 'deeppilot:test-audience',
    log: () => {},
    onAuthenticationSettled: (ok, reason) => { settleEvents.push({ ok, reason }) },
    ...(opts.onDeviceRevoke ? { onDeviceRevoke: opts.onDeviceRevoke } : {}),
    onClosed: () => {
      void (async () => {
        await store.drain()
      })().catch(() => {})
    },
  })
  return {
    ws, connection, bridge, store, identity, settleEvents,
    authenticate: (overrides) => authenticateTestSocket(ws, identity, overrides ?? {}),
    cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) },
  }
}

/** 比对口径：帧类型 + 错误码/关键字段 + 关闭码。 */
export function signature(ws: FakeWebSocket): ScenarioResult {
  return {
    frames: ws.sent.map((frame) => {
      const payload = frame.payload ?? {}
      const bits: string[] = [frame.type]
      if (payload.code !== undefined) bits.push(String(payload.code))
      if (payload.enabled !== undefined) bits.push('enabled=' + String(payload.enabled))
      if (payload.revoked !== undefined) bits.push('revoked=' + String(payload.revoked))
      if (payload.sessionId !== undefined) bits.push('sessionId')
      if (payload.userSeq !== undefined) bits.push('userSeq')
      if (payload.reason !== undefined) bits.push('reason=' + String(payload.reason))
      if (payload.path !== undefined) bits.push('path')
      if (frame.type === 's2c.welcome') {
        bits.push('deviceId=' + String(payload.deviceId === '' ? '' : 'set'))
        bits.push('scopes=' + [...(payload.scopes ?? [])].sort().join(','))
        bits.push('resumed=' + String(payload.resumed))
        bits.push('widgetPush=' + String(payload.capabilities?.widgetPush))
      }
      return bits.join(' ')
    }),
    closes: ws.closes.map((close) => close.code),
    terminated: ws.terminated,
  }
}

/** 等异步 handler 跑完（分发、关闭、注册表落盘都在微任务/宏任务里）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

type Scenario = (h: Harness) => Promise<ScenarioResult>

/** 场景要么是纯函数，要么带自己的建连参数。 */
type MakeOptions = Parameters<typeof makeConnection>[0]
type ScenarioEntry = Scenario | { run: Scenario; opts?: MakeOptions }
const SCENARIOS: Record<string, ScenarioEntry> = {
  '匿名非控制帧': async (h) => {
    h.ws.receive({ v: 2, type: 'c2s.sessions.list', id: 'x', payload: {} })
    await settle()
    return signature(h.ws)
  },
  '匿名超限预认证帧': async (h) => {
    h.ws.receiveRaw('x'.repeat(70 * 1024))
    await settle()
    return signature(h.ws)
  },
  '非法 JSON': async (h) => {
    h.ws.receiveRaw('{not json')
    await settle()
    return signature(h.ws)
  },
  '非信封 JSON': async (h) => {
    h.ws.receive({ v: 2 })
    await settle()
    return signature(h.ws)
  },
  '版本不符': async (h) => {
    h.ws.receive({ v: 1, type: 'c2s.ping', id: 'v', payload: {} })
    await settle()
    return signature(h.ws)
  },
  '匿名 ping': async (h) => {
    h.ws.receive({ v: 2, type: 'c2s.ping', id: 'p', payload: {} })
    await settle()
    return signature(h.ws)
  },
  '证明缺 deviceId': async (h) => {
    h.ws.receive({ v: 2, type: 'c2s.auth.prove', id: 'a', payload: { nonce: 'n' } })
    await settle()
    return signature(h.ws)
  },
  '证明 deviceId 全为控制字符': async (h) => {
    h.ws.receive({ v: 2, type: 'c2s.auth.prove', id: 'a', payload: { deviceId: '\u0000\u0000' } })
    await settle()
    return signature(h.ws)
  },
  '证明签名无效': async (h) => {
    h.authenticate({ signature: 'not-a-signature' })
    await settle()
    return signature(h.ws)
  },
  '证明成功': async (h) => {
    h.authenticate()
    await settle()
    return signature(h.ws)
  },
  '证明成功并续传（可续）': async (h) => {
    await h.bridge.refreshSummaries()
    h.authenticate({ resumeCursor: 0 })
    await settle()
    return signature(h.ws)
  },
  '续传游标超出本进程（重同步）': async (h) => {
    await h.bridge.refreshSummaries()
    h.authenticate({ resumeCursor: 2 })
    await settle()
    return signature(h.ws)
  },
  'scope 不足': async (h) => {
    h.store.setScopes(h.identity.deviceId, ['sessions.manage'])
    h.authenticate()
    h.ws.receive({ v: 2, type: 'c2s.sessions.list', id: 's', payload: {} })
    await settle()
    return signature(h.ws)
  },
  '未知帧类型': async (h) => {
    h.authenticate()
    h.ws.receive({ v: 2, type: 'c2s.does.not.exist', id: 'u', payload: {} })
    await settle()
    return signature(h.ws)
  },
  'widget 只读门与专用拒绝': async (h) => {
    h.authenticate({ clientRole: 'widget' })
    h.ws.receive({ v: 2, type: 'c2s.sessions.list', id: 'w1', payload: {} })
    h.ws.receive({ v: 2, type: 'c2s.session.sendPrompt', id: 'w2', payload: { sessionId: 's' } })
    h.ws.receive({ v: 2, type: 'c2s.device.revoke', id: 'w3', payload: {} })
    h.ws.receive({ v: 2, type: 'c2s.does.not.exist', id: 'w4', payload: {} })
    await settle()
    return signature(h.ws)
  },
  '自撤销：ack 先于 4401': async (h) => {
    h.authenticate()
    h.ws.receive({ v: 2, type: 'c2s.device.revoke', id: 'r', payload: {} })
    await settle()
    return signature(h.ws)
  },
  '撤销时 deviceId 不匹配': async (h) => {
    h.authenticate()
    h.ws.receive({ v: 2, type: 'c2s.device.revoke', id: 'r', payload: { deviceId: 'someone-else' } })
    await settle()
    return signature(h.ws)
  },
  '空闲关闭': async (h) => {
    h.connection.closeIdle()
    await settle()
    return signature(h.ws)
  },
  '服务器停止': async (h) => {
    h.connection.closeForServerStop()
    await settle()
    return signature(h.ws)
  },
  '会话打开失败回滚 viewer': { opts: { historyFails: true }, run: async (h) => {
    h.authenticate()
    h.ws.receive({ v: 2, type: 'c2s.session.open', id: 'o', payload: { sessionId: 'missing-session' } })
    await settle()
    return signature(h.ws)
  } },
  '推送注册被能力门拒': async (h) => {
    h.authenticate()
    h.ws.receive({
      v: 2, type: 'c2s.push.register', id: 'pr',
      payload: { deviceToken: 'a'.repeat(64), environment: 'development' },
    })
    await settle()
    return signature(h.ws)
  },
  'live activity 注册缺 scope': async (h) => {
    h.store.setScopes(h.identity.deviceId, ['notifications.register'])
    h.authenticate()
    h.ws.receive({
      v: 2, type: 'c2s.liveActivity.register', id: 'la',
      payload: { activityId: 'a', sessionId: 's', deviceToken: 'a'.repeat(64), environment: 'development' },
    })
    await settle()
    return signature(h.ws)
  },
}

/** 逐个场景运行；每个场景独立建连，互不影响。 */
export async function runAllScenarios(): Promise<Record<string, ScenarioResult>> {
  const results: Record<string, ScenarioResult> = {}
  for (const [name, entry] of Object.entries(SCENARIOS)) {
    const run = typeof entry === 'function' ? entry : entry.run
    const opts = typeof entry === 'function' ? {} : entry.opts ?? {}
    const h = await makeConnection(opts ?? {})
    try {
      results[name] = await run(h)
    } finally {
      await h.cleanup()
    }
  }
  return results
}
