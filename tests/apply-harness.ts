/**
 * `apply()` 的行为测试底座：假 Cordis Context + 假 DSH 控制器。
 *
 * 为什么需要它：`apply()` 在整套测试里从未被真实启动过（现有测试只测子系统），
 * 而后续重构要把若干子系统从 `apply()` 的闭包里拆出去。没有这个底座，「提取前后
 * 行为一致」只能靠读代码；有了它，才能在改动之前固化一份可断言的快照。
 *
 * 这里不改任何 src/ 代码，只提供 apply() 及其被调者真正会碰的那一小片 ctx 表面：
 *  - `ctx.on('loader/volatile-update', listener)`：配置易变字段提交后重放；
 *  - `ctx.effect(setup, name)`：三段进程资源（独立传输、陈旧连接清扫、进程
 *    资源），setup 立即执行，返回的 cleanup 由宿主在插件卸载时调用；
 *  - `ctx.inject(deps, fn)`：apply() 对 ['sessionController','connection',
 *    'typertGateway'] 建数据平面，report-remote.ts 对 ['typert'] 建 report
 *    Remote。子上下文 `fn(sub)` 还需要：
 *      · `sub.get(name)`（DshApiProxy 取各控制器与 sessionProjections）、
 *      · `sub.effect(setup, name)`（host 流与 report Remote 的清理）、
 *      · `sub.reflect.provide(name, instance, check)`——cordis 的 Service 基类
 *        把自己注册到 ctx 的入口，DeepPilotReportService 就是这样被捕获的、
 *      · `sub.typert`（属性直读）：Typert 贡献注册表。
 *
 * 副作用边界（实测结论，见 tests/apply-baseline.test.ts 的记录）：
 *  - LAN 监听默认关闭，Funnel origin 只绑 127.0.0.1:0，RemoteSupervisor 在
 *    remote.enabled=false 时直接返回、不 spawn helper；
 *  - 唯一不可避免的真实外连是 UpdateChecker 启动 2 秒后的 GitHub 检查——它没有
 *    注入点（构造参数只有 log / currentVersion）。本底座在导入 src/index.ts
 *    之前把 node:https 的 request 换成立即失败的离线桩，与离线主机行为一致
 *    （UpdateChecker 自己把失败收敛成一行日志、available 保持 false），保证测试
 *    不碰网络、快照不依赖网络，dispose() 时还原。
 */

import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { bridgeDataDir } from '../src/token.ts'

/** 默认启动项：master switch 打开，两条传输都关闭，推送 provider=none。 */
export const DEFAULT_BOOT_OPTIONS: Record<string, unknown> = {
  enabled: true,
  local: { enabled: false },
  remote: { enabled: false },
  push: { provider: 'none' },
}

// ---------- 假控制器 ----------

/** 假控制器被调用的可观测事实；快照据此证明"数据平面真的起来了"。 */
export interface ControllerRecorder {
  sessionListCalls: number
  sessionInspectCalls: number
  sessionPromptCalls: number
  sessionModelCatalogCalls: number
  sessionProjectionsCalls: number
  directoryListCalls: number
  directoryPickCalls: number
  scheduleCalls: number
  workspaceFollowOpened: boolean
  workspaceBaselineYielded: boolean
  sharedFetchHandlerCreated: boolean
  wireStreamOpened: boolean
  wireStreamReadyYielded: boolean
  typertContributions: unknown[]
  typertUnregisterCalls: number
}

function createRecorder(): ControllerRecorder {
  return {
    sessionListCalls: 0,
    sessionInspectCalls: 0,
    sessionPromptCalls: 0,
    sessionModelCatalogCalls: 0,
    sessionProjectionsCalls: 0,
    directoryListCalls: 0,
    directoryPickCalls: 0,
    scheduleCalls: 0,
    workspaceFollowOpened: false,
    workspaceBaselineYielded: false,
    sharedFetchHandlerCreated: false,
    wireStreamOpened: false,
    wireStreamReadyYielded: false,
    typertContributions: [],
    typertUnregisterCalls: 0,
  }
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
 */
export function createFakeControllers(): {
  services: Map<string, unknown>
  recorder: ControllerRecorder
} {
  const rec = createRecorder()

  const sessionController = {
    list: async () => { rec.sessionListCalls += 1; return { items: [] } },
    inspect: async () => { rec.sessionInspectCalls += 1; return { events: [] } },
    create: async () => ({ sessionId: 'fake-session', agentPreset: 'standard' }),
    fork: async () => ({ sessionId: 'fake-fork' }),
    modelCatalog: async () => {
      rec.sessionModelCatalogCalls += 1
      return { default: { provider: 'fake-provider', model: 'fake-model' }, groups: [], failures: [] }
    },
    selectModel: async () => ({ selected: { provider: 'fake-provider', model: 'fake-model' } }),
    rename: async () => ({ title: 'fake-title', seq: 1 }),
    prompt: async () => { rec.sessionPromptCalls += 1; return { accepted: true as const } },
    attachment: async () => ({ attachment: { mediaType: 'text/plain' }, data: '' }),
    // 接口是同步方法（DshApiProxy 调用处不 await），假件保持同步。
    cancel: () => ({ accepted: true as const }),
    projections: async () => { rec.sessionProjectionsCalls += 1; return null },
  }

  const workspaceController = {
    create: async (request: { path: string }) => ({
      workspace: { workspaceId: 'fake-workspace', title: 'fake', path: request.path, sessionIds: [] },
      created: true,
    }),
    archiveSession: async (request: { sessionId: string }) => ({ archivedSessionIds: [request.sessionId] }),
    unarchiveSession: async (request: { sessionId: string }) => ({ archivedSessionIds: [request.sessionId] }),
    follow: (signal: AbortSignal) => (async function* followWorkspace() {
      rec.workspaceFollowOpened = true
      yield { type: 'baseline', value: { items: [], archivedSessionIds: [] } }
      rec.workspaceBaselineYielded = true
      await abortLatch(signal)
    })(),
  }

  const directoryPickerController = {
    list: async (path: string | undefined) => {
      rec.directoryListCalls += 1
      return { path: path ?? '', entries: [] }
    },
    pick: async () => { rec.directoryPickCalls += 1; return null },
  }

  const schedule = {
    list: async () => { rec.scheduleCalls += 1; return [] },
    history: async () => {
      rec.scheduleCalls += 1
      return { records: [], earlierRecordsUnavailable: false, retention: { days: 0, records: 0 } }
    },
    create: async () => { rec.scheduleCalls += 1; return { id: 'fake-task', kind: 'at', title: '', prompt: '', scheduledAt: '', state: 'scheduled' } },
    update: async () => { rec.scheduleCalls += 1; return { id: 'fake-task', updated: true } },
    delete: async () => { rec.scheduleCalls += 1; return { id: 'fake-task', deleted: true } },
  }

  /**
   * Typert Gateway 假件。真实宿主里 `typertGateway`（Gateway，提供 wireStream）
   * 与 `typert`（Typert 注册表，提供 register）是两个服务；本底座把两者合成一个
   * 假件同时挂上去，于是 report-remote.ts 的 `remoteCtx.typert.register(...)`
   * 和 DshApiProxy 的 `ctx.get('typertGateway')` 各取所需。register 记录贡献并
   * 返回注销函数（真实注册表同样返回 disposer）。
   */
  const typertGateway = {
    wireStream: {
      open: async (
        _endpoint: string,
        _payload: unknown,
        _uplink: unknown,
        _peer: unknown,
        signal: AbortSignal,
      ): Promise<AsyncIterable<unknown>> => {
        rec.wireStreamOpened = true
        return (async function* remoteEvents() {
          // 与 tests/dsh-api-proxy.test.ts 的 RemoteEventHarness 同形：官方
          // Gateway Client 需要一帧 ready 才认为 Remote Events 世代已建立。
          yield { type: 'ready', clientId: 'deeppilot-harness', host: { home: 'harness' } }
          rec.wireStreamReadyYielded = true
          await abortLatch(signal)
        })()
      },
    },
    register: (contribution: unknown): (() => void) => {
      rec.typertContributions.push(contribution)
      return () => { rec.typertUnregisterCalls += 1 }
    },
  }

  const connection = {
    createSharedFetchHandler: (_channel: string) => {
      rec.sharedFetchHandlerCreated = true
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

  return { services, recorder: rec }
}

// ---------- 假 Cordis Context ----------

interface EffectRecord { name?: string; cleanup: unknown }

/** Service 基类只调用 `ctx.reflect.provide(name, this, check)` 完成自注册。 */
class FakeReflect {
  readonly provided: Array<{ name: string; value: unknown; check?: unknown }> = []
  provide(name: string, value: unknown, check?: unknown): void {
    this.provided.push({ name, value, check })
  }
}

/** `ctx.inject(deps, fn)` 交给业务代码的子上下文。 */
class FakeSubContext {
  readonly reflect = new FakeReflect()
  readonly effects: EffectRecord[] = []
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  /** report-remote.ts 直接属性读 remoteCtx.typert。 */
  readonly typert: unknown

  constructor(private readonly services: ReadonlyMap<string, unknown>) {
    this.typert = services.get('typert')
  }

  get(name: string): unknown { return this.services.get(name) }

  on(event: string, listener: (...args: unknown[]) => void, _options?: unknown): () => void {
    const current = this.listeners.get(event) ?? []
    current.push(listener)
    this.listeners.set(event, current)
    return () => {
      const list = this.listeners.get(event) ?? []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    }
  }

  effect(setup: () => unknown, name?: string): unknown {
    const cleanup = setup()
    this.effects.push({ name, cleanup })
    return cleanup
  }
}

/** 传给 apply() 的宿主上下文；只实现 apply() 真正调用的三个方法。 */
export class FakeContext {
  readonly volatileListeners: Array<() => void> = []
  readonly effects: EffectRecord[] = []
  readonly subContexts: FakeSubContext[] = []
  readonly reflect = new FakeReflect()

  constructor(private readonly services: ReadonlyMap<string, unknown>) {}

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

  inject(deps: string[], fn: (sub: unknown) => void): void {
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

let httpsPatchDepth = 0
let restoreHttps: (() => void) | undefined

/**
 * apply() 构造的 UpdateChecker 会在启动 2 秒后打一次真实的 api.github.com，且没有
 * 注入点。测试既不许有真实网络，也不能让"GitHub 是否可达、是否有新版本"变成快照
 * 变量，于是在导入 src/index.ts 之前把 node:https 的 request 换成立即失败的离线
 * 桩：UpdateChecker 自己把失败收敛成一行日志并保持 available=false，与离线主机
 * 行为一致。只替换 request，createServer 等其余导出保持原样；引用计数保证并发
 * 多个 harness 时不会被提前还原。
 */
function blockOutboundHttps(): void {
  if (httpsPatchDepth === 0) {
    const require_ = createRequire(import.meta.url)
    const https = require_('node:https') as { request: unknown }
    const original = https.request
    https.request = (() => {
      const fake = {
        setTimeout: () => fake,
        on: (event: string, listener: (arg: unknown) => void) => {
          if (event === 'error') {
            queueMicrotask(() => listener(Object.assign(
              new Error('offline: outbound https blocked by tests/apply-harness.ts'),
              { code: 'ENETUNREACH' },
            )))
          }
          return fake
        },
        end: () => {},
      }
      return fake
    }) as unknown as typeof https.request
    restoreHttps = () => { https.request = original }
  }
  httpsPatchDepth += 1
}

function unblockOutboundHttps(): void {
  httpsPatchDepth = Math.max(0, httpsPatchDepth - 1)
  if (httpsPatchDepth === 0) {
    restoreHttps?.()
    restoreHttps = undefined
  }
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

// ---------- harness ----------

/**
 * 进程级约束：DSH_HOME 是进程全局变量，而 report() 的 identityPath、lanAddresses
 * 之外的若干字段都在调用时才读 bridgeDataDir()。两个 harness 同时存活时，后一个
 * boot 会把它指向的临时目录暴露成前一个的 dataDir——这是宿主设计的真实约束，不是
 * 底座能绕开的，因此这里显式拒绝并发：用完后先 dispose 再 boot 下一个。
 */
let liveHarnesses = 0

function assertNoLiveHarness(): void {
  if (liveHarnesses > 0) {
    throw new Error('another apply harness is still live: dispose() it before booting a new one (DSH_HOME is process-global)')
  }
}

export interface ApplyHarness {
  /** 调用被捕获的 DeepPilotReportService.report()。 */
  report: () => Promise<unknown>
  /** applyReportRemote 注入时创建、由 Service 基类注册的 report 服务实例。 */
  reportService: any
  beginPairing: () => Promise<unknown>
  testRelay: () => Promise<unknown>
  testPush: () => Promise<unknown>
  /** 深合并补丁进当前 options，并重放 loader/volatile-update。 */
  setConfig: (patch: Record<string, unknown>) => void
  /** 不改配置，只重放 loader/volatile-update（验证 reconcile 幂等收敛）。 */
  volatileUpdate: () => void
  dataDir: string
  logs: string[]
  /** 让出事件循环若干轮，等 ready 链与首次 reconcile 落定。 */
  settle: (ms?: number) => Promise<void>
  /** 轮询 report() 直到 local 段满足条件（LAN 监听就绪判定）。 */
  waitForLocal: (predicate: (phase: string) => boolean, timeoutMs?: number) => Promise<void>
  ctx: FakeContext
  recorder: ControllerRecorder
  dispose: () => Promise<void>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 递归深合并：对象逐层合，其余（含数组）整体替换。 */
function mergeInto(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const current = target[key]
    if (isPlainObject(value) && isPlainObject(current)) mergeInto(current, value)
    else target[key] = structuredClone(value)
  }
}

/** 预留一个临时端口：先绑 127.0.0.1:0 拿走内核分配的号，再交给 LAN 监听。 */
export async function reserveEphemeralPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/**
 * 用假 Context 启动一次 apply()。调用方负责 dispose()（node:test 的 t.after）。
 * boot 之前把 DSH_HOME 指到新建临时目录——bridgeDataDir() 在调用时求值，因此
 * apply() 整个生命周期的数据目录（设备表、push-relay.json、LAN TLS 身份、各
 * mutation journal）都落在该临时目录内。
 */
export async function bootApply(options: Record<string, unknown> = DEFAULT_BOOT_OPTIONS): Promise<ApplyHarness> {
  assertNoLiveHarness()
  const root = await mkdtemp(join(tmpdir(), 'deeppilot-apply-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  liveHarnesses += 1
  blockOutboundHttps()
  const logs: string[] = []
  const restoreConsole = capturePluginLogs(logs)

  let harness: ApplyHarness | undefined
  let disposed = false
  try {
    // 动态导入：确保 src/index.ts（及其依赖）在 DSH_HOME 就位之后才求值——
    // src/config.ts 的 schema 默认值在模块期调用 bridgeDataDir()。
    const mod = await import('../src/index.ts')
    const dataDir = bridgeDataDir()
    const { services, recorder } = createFakeControllers()
    const ctx = new FakeContext(services)
    mod.apply(ctx as unknown as Context, options)

    // Service 基类经 reflect.provide 自注册；report remote 的名字固定为 deeppilotReport。
    const reportService = ctx.subContexts
      .flatMap((sub) => sub.reflect.provided)
      .find((entry) => entry.name === 'deeppilotReport')?.value

    const callReport = async (): Promise<unknown> => {
      if (reportService === undefined) throw new Error('report remote not registered')
      return await (reportService as { report(): Promise<unknown> }).report()
    }
    const callMethod = (method: string) => async (): Promise<unknown> => {
      if (reportService === undefined) throw new Error('report remote not registered')
      return await (reportService as Record<string, () => Promise<unknown>>)[method]()
    }

    harness = {
      report: callReport,
      reportService,
      beginPairing: callMethod('beginPairing'),
      testRelay: callMethod('testRelay'),
      testPush: callMethod('testPush'),
      setConfig: (patch) => { mergeInto(options, patch); ctx.emitVolatileUpdate() },
      volatileUpdate: () => { ctx.emitVolatileUpdate() },
      dataDir,
      logs,
      settle: async (ms = 0) => {
        for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, ms))
      },
      waitForLocal: async (predicate, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const snapshot = await callReport() as { local?: { phase?: string } }
          const phase = snapshot.local?.phase ?? ''
          if (predicate(phase)) return
          if (Date.now() > deadline) throw new Error(`local phase did not settle (last=${JSON.stringify(phase)})`)
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      },
      ctx,
      recorder,
      dispose: async () => {
        // 幂等：真实宿主可能重复调用 cleanup，测试里显式 dispose + finally 也会。
        // 二次调用只保证状态收敛，不重复跑 effect cleanup、不重复退引用计数。
        if (disposed) return
        disposed = true
        await ctx.disposeEffects()
        restoreConsole()
        unblockOutboundHttps()
        liveHarnesses = Math.max(0, liveHarnesses - 1)
        // 让常驻 Client / 流体的 finally（disposeInteractions 等）跑完再拆目录。
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        await rm(root, { recursive: true, force: true })
      },
    }
    return harness
  } catch (error) {
    // 只有 harness 尚未建成（apply() 自身抛错）时才需要在这里补齐清理；已建成
    // 的情况走上面的幂等 dispose，避免把引用计数退重。
    await harness?.dispose()
    if (!disposed) {
      restoreConsole()
      unblockOutboundHttps()
      liveHarnesses = Math.max(0, liveHarnesses - 1)
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
    throw error
  }
}
