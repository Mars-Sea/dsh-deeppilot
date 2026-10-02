/**
 * 传输协调器（TransportReconciler）——独立传输接入的公共协议，只写一次。
 *
 * 迁移前 LAN 与 Funnel 各有一份 40 行的 reconcile 闭包，做同一件事：算目标值 →
 * 与 appliedKey 比对 → 拆除前一个 → 起新的 → 更新状态，外加一条串行 tail 防
 * 并发。两份拷贝之间还飘着三处**刻意保留的差异**（见 TransportSpec）——本轮
 * 的目标是给 `apply()` 造出接口，不是统一传输的并发语义，因此差异原样保留并
 * 在此声明，而不是悄悄抹平。
 *
 * 每个传输一行声明（见 index.ts 的 createLocalTransport / createRemoteTransport），
 * 协调器只拥有差分、串行、拆除与状态发布。
 */

import type { Config } from './config.ts'
import type { DeepPilotReport } from './report-wire.ts'

/** 状态的最小面：phase 必填，其余字段由各传输自己定义。 */
export interface TransportStatus {
  phase: string
  updatedAt: number
}

/** 目标值：参与差分的稳定对象。 */
export type TransportTarget = Record<string, unknown>

export interface TransportSpec<TInstance, TStatus extends TransportStatus> {
  /** 从当前配置算出的目标值；其 JSON 即差分键。 */
  keyOf(config: Config): TransportTarget
  /**
   * `true`：目标未启用时提前返回并直接置 disabled 状态（LAN 式）。
   * `false`：仍构造实例，由实例内部的 no-op 路径把状态置为 disabled（Funnel 式）。
   */
  skipWhenDisabled: boolean
  /**
   * appliedKey 的写入时机。LAN 在拆除旧 listener 之前写，Funnel 在 supervisor
   * 构造之后、异步 start 之前写——两者在「reconcile 等待期间又来一次
   * volatile-update」时行为不同。差异保留，见文件头说明。
   */
  applyKey: 'before-teardown' | 'after-construct'
  /** 构造实例：同步、即刻取得权威性（Funnel 的 appliedKey 在此之后写入）。 */
  construct(target: TransportTarget): TInstance
  /**
   * 启动实例：异步部分（TLS 加载、监听、拉起 helper）。可返回一个新实例来
   * 替换——LAN 的 listener 要等 TLS 身份就绪后才存在。抛错即走错误分支。
   */
  begin(instance: TInstance, guard: BeginGuard<TInstance>): Promise<TInstance | void>
  /** 拆掉一个实例。 */
  /** 拆除实例；`undefined` 表示没有可拆的（首轮或已拆）。 */
  stop(instance: TInstance | undefined): Promise<void>
  /** 目标未启用且 skipWhenDisabled 时的状态。 */
  disabledStatus(target: TransportTarget): TStatus
  /** 启动过程中的状态。 */
  startingStatus(target: TransportTarget): TStatus
  /** 启动失败时的状态；缺省表示该行没有错误分支，错误原样上抛。 */
  errorStatus?(error: unknown, target: TransportTarget): TStatus
  /** 状态查询：实例在场时问它；返回 undefined 表示「仍是我刚设的过渡态」。 */
  statusOf(instance: TInstance | undefined): TStatus | undefined
  /** 目标未启用时记的日志；缺省不记。 */
  disabledMessage?: string
  /** 启动失败时记的日志；缺省由协调器给一句通用的。 */
  failureMessage?: (error: unknown) => string
}

/**
 * begin 期间的守卫：让行在不复制协调器内部状态的前提下表达「我已被取代」。
 * LAN 原先在 TLS 加载后与 listen 后各查一次（appliedLocalKey / localServer），
 * 这两个检查对应 isCurrent() 与 owns()。
 */
export interface BeginGuard<TInstance> {
  /** 这次触发是否仍是当前配置（差分键未被后续触发改写）。 */
  isCurrent(): boolean
  /** 传入的实例是否仍是协调器持有的那个（未被后续触发替换）。 */
  owns(instance: TInstance): boolean
  /** 进程是否正在销毁。 */
  isDisposed(): boolean
}

export class TransportReconciler<TInstance, TStatus extends TransportStatus> {
  private instance: TInstance | undefined
  private appliedKey: string | undefined
  private disposed = false
  private tail: Promise<void> = Promise.resolve()
  private currentStatus: TStatus

  constructor(
    private readonly spec: TransportSpec<TInstance, TStatus>,
    private readonly config: () => Config,
    private readonly log: (message: string) => void,
    initialStatus: TStatus,
  ) {
    this.currentStatus = initialStatus
  }

  /**
   * 当前状态；report 快照直接读它。实例不在场时返回协调器自己维护的状态
   * （disabled / error / 初始），不被 `statusOf(undefined)` 的缺省值覆盖——
   * 否则一次启动失败会把状态翻转回 idle。
   */
  status(): TStatus {
    if (this.instance === undefined) return this.currentStatus
    return this.spec.statusOf(this.instance) ?? this.currentStatus
  }

  /** 由 loader/volatile-update 触发：串行执行，前一个没完就不抢。 */
  scheduleReconcile(): void {
    this.tail = this.tail
      .then(() => this.reconcile())
      .catch((error) => this.log('reconcile failed: ' + String(error)))
  }

  /** 等当前在途的那一次完成；供 teardown 使用。 */
  async settled(): Promise<void> {
    await this.tail
  }

  /** 一次协调：差分 → 拆除 → 启动 → 状态。 */
  async reconcile(): Promise<void> {
    if (this.disposed) return
    const target = this.spec.keyOf(this.config())
    const nextKey = JSON.stringify(target)
    if (nextKey === this.appliedKey) return

    if (this.spec.applyKey === 'before-teardown') {
      this.appliedKey = nextKey
    }

    const previous = this.instance
    this.instance = undefined
    // 没有可拆的就不调用 stop：LAN 的 closeServer(undefined) 虽是安全路径，
    // 但不该让每个 spec 都为「空实例」写防御分支。
    if (previous !== undefined) await this.spec.stop(previous).catch(() => {})
    if (this.disposed) return

    if (target.enabled !== true && this.spec.skipWhenDisabled) {
      this.currentStatus = this.spec.disabledStatus(target)
      if (this.spec.disabledMessage !== undefined) this.log(this.spec.disabledMessage)
      return
    }

    this.currentStatus = this.spec.startingStatus(target)
    try {
      const constructed = this.spec.construct(target)
      this.instance = constructed
      if (this.spec.applyKey === 'after-construct') {
        this.appliedKey = nextKey
      }
      const guard: BeginGuard<TInstance> = {
        isCurrent: () => this.appliedKey === nextKey,
        owns: (instance) => this.instance === instance,
        isDisposed: () => this.disposed,
      }
      const replacement = await this.spec.begin(constructed, guard)
      if (replacement !== undefined) this.instance = replacement
      if (this.disposed) {
        await this.spec.stop(this.instance).catch(() => {})
        return
      }
      this.currentStatus = this.spec.statusOf(this.instance) ?? this.currentStatus
    } catch (error) {
      if (this.spec.errorStatus === undefined) throw error
      // 有错误分支的行（LAN 式）：半成品实例要拆掉并清空，否则 status() 会
      // 继续问它要状态，把 error 覆盖成 online。Funnel 式没有错误分支，
      // 实例的自身状态机会把 phase 落到 error，因此保留。
      const partial = this.instance
      this.instance = undefined
      if (partial !== undefined) await this.spec.stop(partial).catch(() => {})
      this.currentStatus = this.spec.errorStatus(error, target)
      this.log(this.spec.failureMessage?.(error) ?? 'transport failed: ' + String(error))
    }
  }

  /** 进程收尾：标记销毁、拆掉实例、等在途的那一次完成。 */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = this.instance
    this.instance = undefined
    await this.spec.stop(active).catch(() => {})
    await this.tail
  }
}

// ---------- 两个传输行 ----------

import type { Server } from 'node:http'
import { join } from 'node:path'
import {
  closeServer,
  createPhoneServer,
  listen,
  type PhoneServerHandlers,
} from './phone-server.ts'
import {
  localListenError,
  normalizeLocalPort,
} from './local-policy.ts'
import {
  RemoteSupervisor,
  normalizeRemoteHostname,
  type RemoteStatus,
} from './remote-supervisor.ts'
import { normalizeFunnelConnectionLimit } from './funnel-policy.ts'

/** LAN 行的状态即 report 的 `local` 段。 */
export type LocalStatus = DeepPilotReport['local']

/** LAN 实例：一个（可能还在起步的）TLS listener。 */
interface LocalInstance {
  /** TLS 就绪后才填上；在此之前协调器仍持有这个占位实例。 */
  server: Server | undefined
  tlsFingerprint: string | undefined
  port: number
}

/** LAN 需要的外部能力：窄 handler 面、TLS 身份加载器、当前配置。 */
export interface LocalTransportDeps {
  handlers: PhoneServerHandlers
  config: () => Config
  /** 加载（必要时创建）LAN TLS 身份；由 apply() 持有，reconciler 不懂 TLS。 */
  tls: () => Promise<{ key: string; cert: string; fingerprint: string }>
  log: (message: string) => void
}

/**
 * LAN 传输：TLS-only，绑定 0.0.0.0 的稳定端口。
 *
 * 三处刻意保留的差异：`skipWhenDisabled: true`（未启用即提前返回并置
 * disabled）、`applyKey: 'before-teardown'`（拆除旧 listener 之前写键）、
 * 有错误分支（监听失败落到 `phase: 'error'`）。另有两处 supersede 检查原样
 * 保留：TLS 加载后查 `isCurrent()`，listen 后查 `owns()`。
 */
export function createLocalTransport(deps: LocalTransportDeps): TransportReconciler<LocalInstance, LocalStatus> {
  const spec: TransportSpec<LocalInstance, LocalStatus> = {
    keyOf: (config) => ({
      enabled: config.enabled === true && config.local?.enabled !== false,
      port: normalizeLocalPort(config.local?.port),
    }),
    skipWhenDisabled: true,
    applyKey: 'before-teardown',
    // 只占位：listener 要等 TLS 身份就绪后才存在。
    construct: (target) => ({ server: undefined, tlsFingerprint: undefined, port: normalizeLocalPort(target.port) }),
    begin: async (instance, guard) => {
      const tls = await deps.tls()
      // 被更新的触发取代：不建 listener，状态停在 starting（与迁移前一致）。
      if (!guard.isCurrent() || guard.isDisposed()) return
      const port = instance.port
      const server = createPhoneServer(deps.handlers, { key: tls.key, cert: tls.cert })
      instance.server = server
      instance.tlsFingerprint = tls.fingerprint
      await listen(server, port, '0.0.0.0')
      // listen 期间被取代：拆掉这个半成品，不要让它在端口上继续听着。
      if (!guard.owns(instance) || guard.isDisposed()) {
        instance.server = undefined
        await closeServer(server)
        return
      }
      deps.log(`local transport listening on https://0.0.0.0:${port} (tls fingerprint ${tls.fingerprint})`)
    },
    stop: async (instance) => {
      if (instance?.server === undefined) return
      const server = instance.server
      instance.server = undefined
      await closeServer(server)
    },
    disabledStatus: (target) => ({
      phase: 'disabled', port: normalizeLocalPort(target.port), endpoints: [], updatedAt: Date.now(),
    }),
    startingStatus: (target) => ({
      phase: 'starting', port: normalizeLocalPort(target.port), endpoints: [], updatedAt: Date.now(),
    }),
    errorStatus: (error, target) => ({
      phase: 'error',
      port: normalizeLocalPort(target.port),
      endpoints: [],
      message: localListenError(error, normalizeLocalPort(target.port)),
      updatedAt: Date.now(),
    }),
    disabledMessage: 'local transport disabled',
    failureMessage: (error) => 'local transport failed: ' + localListenError(error, 0),
    statusOf: (instance) => {
      if (instance === undefined || instance.server === undefined) return undefined
      return {
        phase: 'online',
        port: instance.port,
        endpoints: [],
        tlsFingerprint: instance.tlsFingerprint,
        updatedAt: Date.now(),
      }
    },
  }
  return new TransportReconciler<LocalInstance, LocalStatus>(spec, deps.config, deps.log, {
    phase: deps.config().enabled === true && deps.config().local?.enabled !== false ? 'starting' : 'disabled',
    port: normalizeLocalPort(deps.config().local?.port),
    endpoints: [],
    updatedAt: Date.now(),
  })
}

/** Funnel 需要的外部能力：窄 handler 面、loopback origin 地址、数据目录。 */
export interface RemoteTransportDeps {
  handlers: PhoneServerHandlers
  config: () => Config
  /** loopback origin 的地址；未就绪时该行不协调。 */
  originURL: () => string | undefined
  dataDir: string
  log: (message: string) => void
}

/**
 * Funnel 传输：loopback origin + Tailscale Funnel helper。
 *
 * 三处刻意保留的差异：`skipWhenDisabled: false`（未启用仍构造 supervisor，
 * 由其内部 no-op 把状态置 disabled）、`applyKey: 'after-construct'`
 * （supervisor 构造后、异步 start 之前写键）、没有错误分支（supervisor 自己
 * 的状态机负责 phase）。
 */
export function createRemoteTransport(deps: RemoteTransportDeps): TransportReconciler<RemoteSupervisor, RemoteStatus> {
  const fallbackStatus = (): RemoteStatus => ({
    provider: 'tailscale-funnel',
    phase: deps.config().remote?.enabled === true ? 'stopped' : 'disabled',
    updatedAt: Date.now(),
  })
  const spec: TransportSpec<RemoteSupervisor, RemoteStatus> = {
    keyOf: (config) => {
      const remoteConfig = config.remote ?? {}
      const remotePort: 443 | 8443 | 10000 = remoteConfig.funnelPort === 8443 || remoteConfig.funnelPort === 10000
        ? remoteConfig.funnelPort
        : 443
      return {
        enabled: config.enabled === true && remoteConfig.enabled === true && remoteConfig.provider === 'tailscale-funnel',
        hostname: normalizeRemoteHostname(remoteConfig.hostname),
        statePath: remoteConfig.statePath?.trim() || join(deps.dataDir, 'tailscale'),
        helperPath: remoteConfig.helperPath?.trim() || undefined,
        funnelPort: remotePort,
        maxConnectionsPerSource: normalizeFunnelConnectionLimit(remoteConfig.maxConnectionsPerSource),
      }
    },
    skipWhenDisabled: false,
    applyKey: 'after-construct',
    construct: (target) => new RemoteSupervisor({
      enabled: target.enabled === true,
      hostname: String(target.hostname),
      statePath: String(target.statePath),
      ...(target.helperPath !== undefined ? { helperPath: String(target.helperPath) } : {}),
      funnelPort: target.funnelPort as 443 | 8443 | 10000,
      maxConnectionsPerSource: Number(target.maxConnectionsPerSource),
      log: deps.log,
    }),
    begin: async (supervisor) => {
      const originURL = deps.originURL()
      // origin 尚未就绪：这一轮不启动（与迁移前 originURL === undefined 时
      // 直接返回一致；键已写入，origin 就绪后的那次触发会把它建起来）。
      if (originURL === undefined) return
      await supervisor.start(originURL)
    },
    stop: async (supervisor) => {
      if (supervisor === undefined) return
      await supervisor.dispose()
    },
    disabledStatus: () => ({ provider: 'tailscale-funnel', phase: 'disabled', updatedAt: Date.now() }),
    startingStatus: () => ({ provider: 'tailscale-funnel', phase: 'stopped', updatedAt: Date.now() }),
    statusOf: (supervisor) => supervisor?.status() ?? fallbackStatus(),
  }
  return new TransportReconciler<RemoteSupervisor, RemoteStatus>(spec, deps.config, deps.log, fallbackStatus())
}
