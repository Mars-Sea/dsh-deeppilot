/**
 * `apply()` 的行为测试底座：假 Cordis Context + 假 DSH 控制器。
 *
 * 为什么需要它：`apply()` 在整套测试里从未被真实启动过（现有测试只测子系统），
 * 而候选 4 要把 push 与两套 transport reconcile 从 `apply()` 的闭包里抽成
 * module。没有这个底座，「提取前后行为一致」只能靠读代码；有了它，才能在改动
 * 之前固化一份可断言的快照（tests/apply-baseline.test.ts）。
 *
 * 三条硬约束由底座自己保证，测试因此可以安全断言：
 *  1. 不碰网络。`apply()` 构造的 UpdateChecker 没有注入点（构造参数只有 log /
 *     currentVersion），启动 2 秒后必打一次真实的 api.github.com；本底座在导入
 *     src/index.ts 之前把 node:https 的 request 与全局 fetch 换成立即失败的离线
 *     桩，dispose() 还原。真实主机离线时 UpdateChecker 同样把失败收敛成一行日志、
 *     available 保持 false，所以桩不改变被测行为。NETWORK 计数器供测试断言"桩
 *     真的挡下过一次"，而不是靠"没报错"反推。
 *  2. 不绑固定端口。LAN 场景的端口由 reserveEphemeralPort() 向内核要（绑
 *     127.0.0.1:0 → 取号 → 关掉），两次运行不会撞上同一台机器上的既有监听；
 *     Funnel origin 本来就是 127.0.0.1:0。
 *  3. 不 spawn 进程。Funnel 场景把 remote.helperPath 指向一个必然不存在的路径，
 *     RemoteSupervisor 的 candidates 只有一项、access() 直接失败，phase 停在
 *     unavailable，helper 二进制永远走不到 spawn。
 *
 * ctx 只实现 apply() 及其被调者真正会碰的那一小片表面：`on` / `inject` /
 * `effect` / `reflect.provide`；子上下文另加 `get` 与 `typert` 属性直读。service
 * 实例（DeepPilotReportService）由 Service 基类经 reflect.provide 自注册，
 * 底座据此拿到 report remote。
 */

import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Config, plainConfig } from '../src/config.ts'
import { bridgeDataDir } from '../src/token.ts'

/** 默认启动项：master switch 打开，两条传输都关闭，推送 provider=none。 */
export const DEFAULT_BOOT_OPTIONS: Record<string, unknown> = {
  enabled: true,
  local: { enabled: false },
  remote: { enabled: false },
  push: { provider: 'none' },
}

// ---------- 配置解析与合并 ----------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 过一遍导出的 Config schema：生产宿主就是这样补默认值的（remote.provider、
 * local.port、push.* 全都有默认值），而 `apply()` 自己的 normalizeOptions 只做
 * plainConfig 展开、不跑 schema——两者不是一回事，混用会让测试看到一份与真实
 * 运行不一致的配置。schema 对 volatile 字段返回 `{ get }` 引用对象，所以结果再
 * 过一遍 plainConfig 还原成纯数据，之后的深合并与断言都只面对纯 JSON 形状。
 */
function parseConfig(raw: unknown): Record<string, unknown> {
  const parsed = (Config as unknown as (data: unknown) => unknown)(raw) as Record<string, unknown> | undefined
  const plain = plainConfig(parsed ?? raw)
  if (!isPlainObject(plain)) throw new TypeError('apply harness: Config 解析结果不是纯对象')
  return plain
}

/** 递归深合并：对象逐层合，其余（含数组）整体替换。 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    out[key] = isPlainObject(value) && isPlainObject(current)
      ? deepMerge(current, value)
      : structuredClone(value)
  }
  return out
}

/**
 * bridgeDataDir() 派生的三个 schema 默认值（devicesPath / remote.statePath /
 * push.keyPath）在 src/config.ts 首次求值时就被模块缓存冻住，而本底座要在
 * import 它之后才把 DSH_HOME 指到本次的临时目录；同一进程里第二次 boot 会因此
 * 拿到第一次的临时目录。这里按本次 boot 的 dataDir 重算，调用方显式给了值的
 * 除外——口径与 apply() 自己 `?? join(bridgeDataDir(), ...)` 的回退一致。
 */
function pinPerBootPaths(
  options: Record<string, unknown>,
  override: Record<string, unknown>,
  dataDir: string,
): void {
  if (override.devicesPath === undefined) options.devicesPath = join(dataDir, 'devices-v2.json')
  const remoteOverride = isPlainObject(override.remote) ? override.remote : {}
  const remoteOptions = options.remote
  if (!isPlainObject(remoteOptions)) throw new TypeError('apply harness: 解析后的 remote 段缺失')
  if (remoteOverride.statePath === undefined) remoteOptions.statePath = join(dataDir, 'tailscale')
  const pushOverride = isPlainObject(override.push) ? override.push : {}
  const pushOptions = options.push
  if (!isPlainObject(pushOptions)) throw new TypeError('apply harness: 解析后的 push 段缺失')
  if (pushOverride.keyPath === undefined) pushOptions.keyPath = join(dataDir, 'apns', 'AuthKey.p8')
}

// ---------- 假控制器 ----------

/** 假控制器被调用的可观测事实；快照据此证明"数据平面真的起来了"。 */
export interface ControllerRecorder {
  sessionListCalls: number
  workspaceFollowOpened: boolean
  sharedFetchHandlerCreated: boolean
  wireStreamOpened: boolean
  wireStreamReadyYielded: boolean
  typertContributions: unknown[]
  typertUnregisterCalls: number
}

/** 信号量：await 到 abort 为止，不轮询、不留定时器。 */
function abortLatch(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/**
 * 假 DSH 控制器组。方法形状照 src/dsh-api-proxy.ts 的 SessionControllerLike /
 * WorkspaceControllerLike / ScheduleControllerLike / DirectoryPickerControllerLike
 * 逐条对齐；返回体取最小形状——HostBridge 只读其中少量字段，读不到的走默认值。
 *
 * 真实宿主里 `typertGateway`（Gateway，提供 wireStream）与 `typert`（Typert
 * 注册表，提供 register）是两个服务；本底座合成一个假件同时挂上去，于是
 * report-remote.ts 的 `remoteCtx.typert.register(...)` 和 DshApiProxy 的
 * `ctx.get('typertGateway')` 各取所需。
 */
export function createFakeControllers(): {
  services: Map<string, unknown>
  recorder: ControllerRecorder
} {
  const recorder: ControllerRecorder = {
    sessionListCalls: 0,
    workspaceFollowOpened: false,
    sharedFetchHandlerCreated: false,
    wireStreamOpened: false,
    wireStreamReadyYielded: false,
    typertContributions: [],
    typertUnregisterCalls: 0,
  }

  const sessionController = {
    list: async () => { recorder.sessionListCalls += 1; return { items: [] } },
    inspect: async () => ({ events: [] }),
    create: async () => ({ sessionId: 'fake-session', agentPreset: 'standard' }),
    fork: async () => ({ sessionId: 'fake-fork' }),
    modelCatalog: async () => ({ default: { provider: 'fake-provider', model: 'fake-model' }, groups: [], failures: [] }),
    selectModel: async () => ({ selected: { provider: 'fake-provider', model: 'fake-model' } }),
    rename: async () => ({ title: 'fake-title', seq: 1 }),
    prompt: async () => ({ accepted: true as const }),
    attachment: async () => ({ attachment: { mediaType: 'text/plain' }, data: '' }),
    // 接口是同步方法（DshApiProxy 调用处不 await），假件保持同步。
    cancel: () => ({ accepted: true as const }),
    projections: async () => null,
  }

  const workspaceController = {
    create: async (request: { path: string }) => ({
      workspace: { workspaceId: 'fake-workspace', title: 'fake', path: request.path, sessionIds: [] },
      created: true,
    }),
    archiveSession: async (request: { sessionId: string }) => ({ archivedSessionIds: [request.sessionId] }),
    unarchiveSession: async (request: { sessionId: string }) => ({ archivedSessionIds: [request.sessionId] }),
    follow: (signal: AbortSignal) => (async function* followWorkspace() {
      recorder.workspaceFollowOpened = true
      yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
      await abortLatch(signal)
    })(),
  }

  const directoryPickerController = {
    list: async (path: string | undefined) => ({ path: path ?? '', entries: [] }),
    pick: async () => null,
  }

  const schedule = {
    list: async () => [],
    history: async () => ({ records: [], earlierRecordsUnavailable: false, retention: { days: 0, records: 0 } }),
    create: async () => ({ id: 'fake-task', kind: 'at', title: '', prompt: '', scheduledAt: '', state: 'scheduled' }),
    update: async () => ({ id: 'fake-task', updated: true }),
    delete: async () => ({ id: 'fake-task', deleted: true }),
  }

  const typertGateway = {
    wireStream: {
      open: async (
        _endpoint: string,
        _payload: unknown,
        _uplink: unknown,
        _peer: unknown,
        signal: AbortSignal,
      ): Promise<AsyncIterable<unknown>> => {
        recorder.wireStreamOpened = true
        return (async function* remoteEvents() {
          // 与 tests/dsh-api-proxy.test.ts 的 RemoteEventHarness 同形：官方
          // Gateway Client 需要一帧 ready 才认为 Remote Events 世代已建立。
          yield { type: 'ready', clientId: 'deeppilot-harness', host: { home: 'harness' } }
          recorder.wireStreamReadyYielded = true
          await abortLatch(signal)
        })()
      },
    },
    register: (contribution: unknown): (() => void) => {
      recorder.typertContributions.push(contribution)
      return () => { recorder.typertUnregisterCalls += 1 }
    },
  }

  const connection = {
    createSharedFetchHandler: (_channel: string) => {
      recorder.sharedFetchHandlerCreated = true
      return {
        fetch: async (request: Request): Promise<Response> => {
          const body = await request.json().catch(() => ({})) as { rpcId?: string }
          return Response.json({ type: 'server-response', rpcId: body.rpcId ?? '', result: { ok: true } })
        },
      }
    },
  }

  const services = new Map<string, unknown>([
    ['sessionController', sessionController],
    ['connection', connection],
    ['typertGateway', typertGateway],
    ['typert', typertGateway],
    ['workspaceController', workspaceController],
    ['directoryPickerController', directoryPickerController],
    ['schedule', schedule],
  ])

  return { services, recorder }
}

// ---------- 假 Cordis Context ----------

interface EffectRecord { name?: string; cleanup: unknown }

/** cordis Service 基类只调用 `ctx.reflect.provide(name, this, check)` 自注册。 */
class FakeReflect {
  readonly provided: Array<{ name: string; value: unknown; check?: unknown }> = []

  constructor(private readonly services: Map<string, unknown>) {}

  provide(name: string, value: unknown, check?: unknown): void {
    this.provided.push({ name, value, check })
    // 宿主里 reflect.provide 就是把实例注册进 ctx；镜像回服务表，测试可以像拿
    // 普通服务一样 services.get('deeppilotReport')。
    this.services.set(name, value)
  }
}

/** `ctx.inject(deps, fn)` 交给业务代码的子上下文。 */
class FakeSubContext {
  readonly reflect: FakeReflect
  readonly effects: EffectRecord[] = []
  /** report-remote.ts 直接属性读 remoteCtx.typert。 */
  readonly typert: unknown

  constructor(private readonly services: Map<string, unknown>) {
    this.reflect = new FakeReflect(services)
    this.typert = services.get('typert')
  }

  get(name: string): unknown { return this.services.get(name) }

  /** apply() 只在顶层 ctx 上监听；子 ctx 保留它是为了被调者万一注册时不炸。 */
  on(_event: string, _listener: (...args: unknown[]) => void): () => void {
    return () => {}
  }

  effect(setup: () => unknown, name?: string): unknown {
    const cleanup = setup()
    this.effects.push({ name, cleanup })
    return cleanup
  }
}

/** 传给 apply() 的宿主上下文；只实现 apply() 真正调用的那几个方法。 */
export class FakeContext {
  readonly volatileListeners: Array<() => void> = []
  readonly effects: EffectRecord[] = []
  readonly subContexts: FakeSubContext[] = []
  readonly reflect: FakeReflect

  constructor(private readonly services: Map<string, unknown>) {
    this.reflect = new FakeReflect(services)
  }

  on(name: string, listener: () => void): () => void {
    if (name === 'loader/volatile-update') {
      this.volatileListeners.push(listener)
      return () => {
        const index = this.volatileListeners.indexOf(listener)
        if (index >= 0) this.volatileListeners.splice(index, 1)
      }
    }
    return () => {}
  }

  /** 重放 rc.2 的 loader/volatile-update：宿主把易变字段提交进活引用之后。 */
  emitVolatileUpdate(): void {
    for (const listener of [...this.volatileListeners]) listener()
  }

  effect(setup: () => unknown, name?: string): unknown {
    const cleanup = setup()
    this.effects.push({ name, cleanup })
    return cleanup
  }

  inject(_deps: string[], fn: (sub: unknown) => void): void {
    const sub = new FakeSubContext(this.services)
    this.subContexts.push(sub)
    fn(sub)
  }

  /** 按注册逆序执行全部 effect cleanup（真实宿主随 fiber 卸载时调用）。 */
  async disposeEffects(): Promise<number> {
    const records: EffectRecord[] = [
      ...this.subContexts.flatMap((sub) => sub.effects),
      ...this.effects,
    ].reverse()
    for (const record of records) {
      if (typeof record.cleanup === 'function') await (record.cleanup as () => unknown)()
    }
    return records.length
  }
}

// ---------- 离线闸门（UpdateChecker 的后台 GitHub 检查） ----------

/** 进程级计数：桩一共挡下过多少次真实外连尝试。 */
const NETWORK = { blockedHttpsRequests: 0, blockedFetchCalls: 0 }

let httpsDepth = 0
let restoreHttps: (() => void) | undefined
let fetchDepth = 0
let restoreFetch: (() => void) | undefined

const OFFLINE_MESSAGE = 'offline: outbound request blocked by tests/apply-harness.ts'

/**
 * apply() 构造的 UpdateChecker 会在启动 2 秒后打一次真实的 api.github.com，且没有
 * 注入点。测试既不许有真实网络，也不能让"GitHub 是否可达、是否有新版本"变成快照
 * 变量，于是在导入 src/index.ts 之前把 node:https 的 request 换成立即失败的离线
 * 桩：UpdateChecker 自己把失败收敛成一行日志并保持 available=false，与离线主机
 * 行为一致。只替换 request，createServer 等其余导出保持原样（phone-server 的
 * LAN TLS 监听用的就是 createServer）；引用计数保证多个 harness 嵌套时不会被
 * 提前还原。
 *
 * 必须在任何 ESM 代码 import 'node:https' 之前打补丁才有意义：node 内置模块的
 * ESM 命名导出在命名空间首次物化时快照，之后再改 CJS 侧就来不及了——所以底座是
 * 「先设 DSH_HOME → 装闸门 → 动态 import src/index.ts」这个顺序。
 */
function blockOutboundHttps(): void {
  if (httpsDepth === 0) {
    const require_ = createRequire(import.meta.url)
    const https = require_('node:https') as { request: unknown }
    const original = https.request
    https.request = (() => {
      NETWORK.blockedHttpsRequests += 1
      const fake = {
        setTimeout: () => fake,
        on: (event: string, listener: (arg: unknown) => void) => {
          if (event === 'error') {
            queueMicrotask(() => listener(Object.assign(new Error(OFFLINE_MESSAGE), { code: 'ENETUNREACH' })))
          }
          return fake
        },
        end: () => {},
      }
      return fake
    }) as unknown as typeof https.request
    restoreHttps = () => { https.request = original }
  }
  httpsDepth += 1
}

function unblockOutboundHttps(): void {
  httpsDepth = Math.max(0, httpsDepth - 1)
  if (httpsDepth === 0) {
    restoreHttps?.()
    restoreHttps = undefined
  }
}

/**
 * 全局 fetch 的离线闸门。src/relay-test.ts 的 runRelayProbe 用
 * `options.fetchImpl ?? fetch`，没有注入点时回落到全局 fetch；基线只跑 http://
 * 中继这种"发请求前就被 https 门拒掉"的路径，本闸门是第二道保险——将来若有人误加
 * 一条会真发请求的路径，它会立刻炸，而不是静默打网络。
 */
function blockGlobalFetch(): void {
  if (fetchDepth === 0) {
    const original = (globalThis as { fetch: unknown }).fetch
    ;(globalThis as { fetch: unknown }).fetch = async () => {
      NETWORK.blockedFetchCalls += 1
      throw Object.assign(new Error(OFFLINE_MESSAGE), { code: 'ENETUNREACH' })
    }
    restoreFetch = () => { (globalThis as { fetch: unknown }).fetch = original }
  }
  fetchDepth += 1
}

function unblockGlobalFetch(): void {
  fetchDepth = Math.max(0, fetchDepth - 1)
  if (fetchDepth === 0) {
    restoreFetch?.()
    restoreFetch = undefined
  }
}

/** 闸门当前是否装着（dispose 之后应当为 false）。 */
export function isNetworkGateInstalled(): boolean {
  return httpsDepth > 0 || fetchDepth > 0
}

// ---------- 日志捕获 ----------

/** 捕获插件自身的 console 行（前缀 [deeppilot]），其余原样透传。 */
function capturePluginLogs(sink: string[]): () => void {
  const originalLog = console.log
  const originalWarn = console.warn
  const collect = (write: (...args: unknown[]) => void) => (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')
    if (line.startsWith('[deeppilot]')) sink.push(line)
    write(...args)
  }
  console.log = collect(originalLog) as unknown as typeof console.log
  console.warn = collect(originalWarn) as unknown as typeof console.warn
  return () => {
    console.log = originalLog
    console.warn = originalWarn
  }
}

// ---------- 临时端口 ----------

/**
 * 预留一个临时端口：先绑 127.0.0.1:0 拿走内核分配的号，再关掉交给 LAN 监听。
 * 写死的端口会让两次运行撞上同一台机器上的既有监听，也会在 CI 上和别人的监听
 * 相撞；向内核要号则不会。
 */
export async function reserveEphemeralPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  if (port <= 0) throw new Error('apply harness: 临时端口预留失败')
  return port
}

// ---------- harness ----------

export interface BootOptions {
  /** 传给 apply() 第二参数的配置覆盖（先与 DEFAULT_BOOT_OPTIONS 顶层合并）。 */
  options?: Record<string, unknown>
  /** 追加 / 覆盖假服务表里的条目。 */
  services?: Record<string, unknown>
  /**
   * 中继探测的传输实现。`apply()` 至今没有把它接到任何地方：src/relay-test.ts
   * 的 runRelayProbe 与已提取的 src/push-gateway.ts 都已支持 fetchImpl 入参，
   * 但 src/index.ts 仍然不传递，所以 PushGateway 内部用的是全局 fetch。底座
   * 今天只持有并暴露在 harness.fetchImpl 上；接线那一步（apply() → PushGateway）
   * 落地后，把这里持有的实现交出去即可，调用方不用改。
   *
   * 刻意不走 services 表：那是 ctx 的服务注册通道，把一个测试专用参数塞进去
   * 会让它变成一个插件可见的服务名。需要自定义传输的用例直接调 runRelayProbe
   * 即可（tests/relay-probe.test.ts 已覆盖，含一个必抛的 fetchImpl）。
   */
  fetchImpl?: typeof fetch
}

export interface ApplyHarness {
  /** 调用被捕获的 DeepPilotReportService.report()。 */
  report: () => Promise<unknown>
  /** applyReportRemote 注入时创建、由 Service 基类注册的 report 服务实例。 */
  reportService: any
  beginPairing: () => Promise<unknown>
  testRelay: () => Promise<unknown>
  testPush: () => Promise<unknown>
  /**
   * 深合并补丁进当前 options（过 Config schema 补默认值），再重放
   * loader/volatile-update。浅合并会整段替换嵌套段、丢掉 sibling 字段。
   */
  setConfig: (patch: Record<string, unknown>) => void
  /** 不改配置，只重放 loader/volatile-update（验证 reconcile 幂等收敛）。 */
  volatileUpdate: () => void
  /** 当前生效配置；等价于 apply() 里 normalizeOptions(options) 的结果（纯数据）。 */
  currentConfig: () => Config
  /** 活服务表：假控制器 + reflect.provide 注册进来的实例。 */
  services: Map<string, unknown>
  /** 捕获到的 [deeppilot] 前缀日志行。 */
  logs: string[]
  /** 本次 boot 的数据目录（= bridgeDataDir()，DSH_HOME 已指向它）。 */
  dataDir: string
  /** apply() 持有的 options 对象本身（setConfig 原地改写它）。 */
  options: Record<string, unknown>
  /** 底座持有、等待 PushGateway 提取后消费的传输实现（见 BootOptions.fetchImpl）。 */
  fetchImpl?: typeof fetch
  /** 离线闸门挡下过多少次真实外连（相对本次 boot 的净值）。 */
  network: { blockedHttpsRequests: number; blockedFetchCalls: number }
  /** 让出事件循环，等 ready 链与异步 reconcile 落定。 */
  settle: (ms?: number) => Promise<void>
  /** 轮询 report() 直到 local 段 phase 满足条件，超时抛错（不把偶发值录进快照）。 */
  waitForLocal: (predicate: (phase: string) => boolean, timeoutMs?: number) => Promise<void>
  /** 同上，看 remote 段。 */
  waitForRemote: (predicate: (phase: string) => boolean, timeoutMs?: number) => Promise<void>
  ctx: FakeContext
  recorder: ControllerRecorder
  /** 幂等：重复调用只收敛状态，不重复跑 effect cleanup、不退两次引用计数。 */
  dispose: () => Promise<void>
}

/** BootOptions 的三个键与原始配置的键名不相交，判别无歧义。 */
const BOOT_SHAPE_KEYS: readonly string[] = ['options', 'services', 'fetchImpl']

function splitBootInput(input: Record<string, unknown>): {
  override: Record<string, unknown>
  services: Record<string, unknown>
  fetchImpl?: typeof fetch
} {
  const keys = Object.keys(input)
  if (keys.length === 0) return { override: {}, services: {} }
  if (keys.some((key) => BOOT_SHAPE_KEYS.includes(key))) {
    const shape = input as unknown as BootOptions
    return { override: shape.options ?? {}, services: shape.services ?? {}, fetchImpl: shape.fetchImpl }
  }
  // 直接给一份原始配置（bootApply({ local: { enabled: true } })）也认。
  return { override: input, services: {} }
}

async function waitForPhase(
  section: 'local' | 'remote',
  predicate: (phase: string) => boolean,
  timeoutMs: number,
  callReport: () => Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  for (;;) {
    const snapshot = (await callReport()) as Record<string, { phase?: string } | undefined>
    last = snapshot[section]?.phase ?? ''
    if (predicate(last)) return
    if (Date.now() > deadline) {
      throw new Error(`apply harness: ${section} phase 未在 ${timeoutMs}ms 内满足条件（last=${JSON.stringify(last)}）`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/**
 * 用假 Context 启动一次 apply()。调用方负责 dispose()（node:test 的 t.after）。
 *
 * 时序很重要：DSH_HOME 必须先指到新建临时目录，再装离线闸门，最后才动态 import
 * src/index.ts——config.ts 的 schema 默认值在模块期调用 bridgeDataDir()，而
 * update-check.ts 的 `import { request } from 'node:https'` 只在此时物化命名空间。
 *
 * 也接受两种入参形状：`bootApply({ local: { enabled: true } })`（一份原始配置）
 * 与 `bootApply({ options, services, fetchImpl })`（BootOptions）；两组键名不相交，
 * 判别无歧义。
 */
export async function bootApply(input: Record<string, unknown> = {}): Promise<ApplyHarness> {
  const { override, services: extraServices, fetchImpl } = splitBootInput(input)
  const root = await mkdtemp(join(tmpdir(), 'deeppilot-apply-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  const httpsBaseline = NETWORK.blockedHttpsRequests
  const fetchBaseline = NETWORK.blockedFetchCalls
  blockOutboundHttps()
  blockGlobalFetch()
  const logs: string[] = []
  const restoreConsole = capturePluginLogs(logs)

  let harness: ApplyHarness | undefined
  let disposed = false
  try {
    const mod = await import('../src/index.ts')
    const dataDir = bridgeDataDir()
    const { services, recorder } = createFakeControllers()
    for (const [name, value] of Object.entries(extraServices)) services.set(name, value)

    const options = parseConfig({ ...DEFAULT_BOOT_OPTIONS, ...override })
    pinPerBootPaths(options, override, dataDir)

    const ctx = new FakeContext(services)
    mod.apply(ctx as unknown as Context, options)

    // Service 基类经 reflect.provide 自注册；report remote 的名字固定为 deeppilotReport。
    const reportService = ctx.subContexts
      .flatMap((sub) => sub.reflect.provided)
      .find((entry) => entry.name === 'deeppilotReport')?.value

    const callReport = async (): Promise<unknown> => {
      if (reportService === undefined) throw new Error('report remote not registered: applyReportRemote 未注入')
      return await (reportService as { report(): Promise<unknown> }).report()
    }
    const callMethod =
      (method: string) => async (): Promise<unknown> => {
        if (reportService === undefined) throw new Error(`report remote not registered: ${method} 不可用`)
        return await (reportService as Record<string, () => Promise<unknown>>)[method]()
      }

    harness = {
      report: callReport,
      reportService,
      beginPairing: callMethod('beginPairing'),
      testRelay: callMethod('testRelay'),
      testPush: callMethod('testPush'),
      setConfig: (patch) => {
        // 深合并 + 过 schema：浅 Object.assign 会整段换掉 remote/local 这些嵌套段，
        // sibling 字段（remote.provider 之类）被丢掉，Funnel 场景就静默失效。
        const merged = deepMerge(plainConfig(options) as Record<string, unknown>, patch)
        const parsed = parseConfig(merged)
        // 原地写回：apply() 闭包里持有的是同一个 options 引用。
        for (const key of Object.keys(options)) delete options[key]
        Object.assign(options, parsed)
        ctx.emitVolatileUpdate()
      },
      volatileUpdate: () => { ctx.emitVolatileUpdate() },
      currentConfig: () => plainConfig(options) as Config,
      services,
      logs,
      dataDir,
      options,
      fetchImpl,
      network: {
        get blockedHttpsRequests() { return NETWORK.blockedHttpsRequests - httpsBaseline },
        get blockedFetchCalls() { return NETWORK.blockedFetchCalls - fetchBaseline },
      },
      settle: async (ms = 0) => {
        // 先排空微任务 / Immediate（ready IIFE、reconcile 尾链都跑在这两队列），
        // 再给若干定时器节拍。
        for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
        for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, ms))
      },
      waitForLocal: async (predicate, timeoutMs = 15_000) => {
        await waitForPhase('local', predicate, timeoutMs, callReport)
      },
      waitForRemote: async (predicate, timeoutMs = 15_000) => {
        await waitForPhase('remote', predicate, timeoutMs, callReport)
      },
      ctx,
      recorder,
      dispose: async () => {
        if (disposed) return
        disposed = true
        await ctx.disposeEffects()
        restoreConsole()
        unblockOutboundHttps()
        unblockGlobalFetch()
        // 让常驻 Client / 流体的 finally（disposeInteractions 等）跑完再拆目录。
        await new Promise((resolve) => setTimeout(resolve, 50))
        // DSH_HOME 是进程全局量；多个 harness 嵌套时按 LIFO 还原，这是宿主的真实
        // 约束，底座只能保证自己的这一次不出错。
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        await rm(root, { recursive: true, force: true })
      },
    }
    return harness
  } catch (error) {
    // 只有 harness 尚未建成（apply() 自身抛错）时才需要在这里补齐清理；已建成的
    // 情况走上面的幂等 dispose，避免重复退引用计数。
    await harness?.dispose()
    if (!disposed) {
      restoreConsole()
      unblockOutboundHttps()
      unblockGlobalFetch()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
    throw error
  }
}
