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
  /** 启动实例：异步部分（监听、拉起 helper）；抛错即走错误分支（若该行有）。 */
  begin(instance: TInstance): Promise<void>
  /** 拆掉一个实例。 */
  /** 拆除实例；`undefined` 表示没有可拆的（首轮或已拆）。 */
  stop(instance: TInstance | undefined): Promise<void>
  /** 目标未启用且 skipWhenDisabled 时的状态。 */
  disabledStatus(target: TransportTarget): TStatus
  /** 启动过程中的状态。 */
  startingStatus(target: TransportTarget): TStatus
  /** 启动失败时的状态；缺省表示该行没有错误分支，错误原样上抛。 */
  errorStatus?(error: unknown, target: TransportTarget): TStatus
  /** 状态查询：实例在场时问它，否则给一个缺省值。 */
  statusOf(instance: TInstance | undefined): TStatus
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
      this.log('transport disabled')
      return
    }

    this.currentStatus = this.spec.startingStatus(target)
    try {
      const instance = this.spec.construct(target)
      this.instance = instance
      if (this.spec.applyKey === 'after-construct') {
        this.appliedKey = nextKey
      }
      await this.spec.begin(instance)
      if (this.disposed) {
        await this.spec.stop(instance).catch(() => {})
        return
      }
      this.currentStatus = this.spec.statusOf(instance) ?? this.currentStatus
    } catch (error) {
      if (this.spec.errorStatus === undefined) throw error
      // 有错误分支的行（LAN 式）：半成品实例要拆掉并清空，否则 status() 会
      // 继续问它要状态，把 error 覆盖成 online。Funnel 式没有错误分支，
      // 实例的自身状态机会把 phase 落到 error，因此保留。
      const partial = this.instance
      this.instance = undefined
      if (partial !== undefined) await this.spec.stop(partial).catch(() => {})
      this.currentStatus = this.spec.errorStatus(error, target)
      this.log('transport failed: ' + String(error))
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
