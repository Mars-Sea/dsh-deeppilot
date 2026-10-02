/**
 * 连接门（ConnectionGate）——「一个匿名 socket 被允许做什么」的唯一属主。
 *
 * 迁移前，这些规则散在五个地方：connection.ts 的 onMessage（长度上限、信封
 * 卫生、pre-auth 白名单、scope/widget 门）、connection.ts 的 prove()（认证）、
 * index.ts 的 handleUpgrade（连接数、名额、失败记账、6 个手工 release 点）、
 * auth-rate-limit.ts（策略）、token.ts（注册表语义）。理解一次 4401 关闭要跨
 * 400 行来回跳。
 *
 * 现在：门拥有 ①认证状态机的全部迁移 ②认证名额的获取与释放（单一释放点）
 * ③「此刻这一帧是否被允许进入」的判定。连接只剩传输、welcome 发射、sink 台账
 * 与连接自有缓冲；注册表行仍住在 wire-registry 及其特性 module 里，门只负责
 * 在正确的时机调用它们。
 *
 * 名额的生命周期分两段，各有保证：
 * - 接入段：门在 handleUpgrade 里构造（admit 发生于此）。若 upgrade 回调根本
 *   不执行（upgrade 期间 socket 被销毁），5 秒兜底会释放名额并判门死刑；
 * - 认证段：attach 之后由 35 秒 hello 计时器兜底，任何一条落定路径
 *   （成功/证明无效/超时/关闭）都经 settleAuthentication 的 exactly-once
 *   守卫释放一次。
 */

import { PROTOCOL_VERSION } from './protocol.ts'
import type { AuthProofPayload, Envelope } from './protocol.ts'
import type { HostBridge } from './host-bridge.ts'
import type { DeviceStore } from './token.ts'
import {
  createAuthChallenge,
  verifyAuthProof,
  type AuthChallenge,
  type DeviceScope,
} from './device-auth.ts'
import {
  AUTH_TIMEOUT_MS,
  MAX_APP_VERSION_CHARS,
  MAX_DEVICE_ID_CHARS,
  MAX_DEVICE_NAME_CHARS,
  PRE_AUTH_FRAME_BYTES,
  sanitizeDeviceField,
  isEnvelope,
} from './connection-policy.ts'
import { AuthRateLimiter } from './auth-rate-limit.ts'
import {
  capabilityRejection,
  dispatchFrame,
  registryRowFor,
  scopeRejection,
  validatePayload,
  widgetPolicyOf,
  type FrameContext,
  type OpenEventBuffer,
  type S2CType,
} from './wire-registry.ts'
import type { WireErrorCode } from './wire-errors.ts'

/** 认证落定的四种结局；与迁移前 index.ts 收到的 reason 一致。 */
export type SettleReason = 'success' | 'invalid-proof' | 'timeout' | 'closed'

/** 认证成功的产物：连接据它发 welcome、注册 sink、决定重放。 */
export interface AuthenticatedIdentity {
  deviceId: string
  scopes: ReadonlySet<DeviceScope>
  widgetClient: boolean
  resumeCursor: number | undefined
  deviceName: string
  appVersion: string
}

/**
 * 门看到的宿主，由连接实现：传输、sink 转发、连接自有缓冲，以及认证成功与
 * 审计两个通知。行（wire-registry）看到的 FrameContext 是它的一个按帧投影。
 */
export interface GateHost {
  readonly bridge: HostBridge
  readonly devices: DeviceStore
  readonly debug: boolean
  log(message: string): void
  send(type: S2CType, payload: unknown, id?: string): void
  fail(id: string | undefined, code: WireErrorCode, message: string): void
  close(code: number, reason: string): void
  // ---------- BridgeSink 转发（openSession 等行需要把上下文当作 sink） ----------
  canReceive(scope: DeviceScope): boolean
  push(type: string, payload: unknown, seq?: number): void
  lastCursor(): number
  replay(entries: Array<{ seq: number; type: string; payload: unknown }>): void
  replayDone(): void
  resync(): void
  // ---------- 连接自有状态 ----------
  bufferOpenEvents(sessionId: string): OpenEventBuffer
  discardOpenBuffer(sessionId: string, buffer: OpenEventBuffer): void
  flushOpenBuffer(sessionId: string, buffer: OpenEventBuffer): boolean
  closeOpenSession(sessionId: string): void
  nextLiveActivityGeneration(): number
  readonly liveActivityGeneration: number
  readonly pendingLiveActivityId: string | undefined
  setPendingLiveActivityId(activityId: string | undefined): void
  markRevoked(): void
  enrollPushKey(enrollKey: string): Promise<void> | void
  revokeSiblings(deviceId: string): Promise<unknown> | unknown
  // ---------- 通知 ----------
  /** 认证成功：由连接发 welcome、注册 sink、决定重放/重同步。 */
  onAuthenticated(identity: AuthenticatedIdentity): void
  /** 隐私 preserving 审计事件（有效 hello 之后）。 */
  deviceAuthenticated(deviceId: string): void
}

export interface ConnectionGateOptions {
  /** 客户端身份，用于限流（IP 或回环标识）。 */
  source: string
  devices: DeviceStore
  /** 稳定 Host 身份，写入每次挑战。 */
  audience: string
  limiter: AuthRateLimiter
  host: GateHost
  log: (message: string) => void
  /** 审计标签函数：把敏感标识变成短哈希，供日志使用。 */
  auditLabel?: (value: string) => string
  /** 未 attach 的兜底时限：upgrade 回调根本不执行时释放名额。 */
  attachTimeoutMs?: number
}

/** upgrade 正常是毫秒级；5 秒已极宽，只为「回调根本不执行」兜底。 */
const DEFAULT_ATTACH_TIMEOUT_MS = 5_000

export class ConnectionGate {
  private authenticated = false
  private settled = false
  private revoked = false
  private deviceId: string | undefined
  private scopes = new Set<DeviceScope>()
  private widgetClient = false
  private readonly challenge: AuthChallenge
  private helloTimer: NodeJS.Timeout | undefined
  private attachTimer: NodeJS.Timeout | undefined
  private attached = false
  private admission: { release: () => void } | undefined
  private dead = false

  constructor(private readonly options: ConnectionGateOptions) {
    this.challenge = createAuthChallenge(options.audience)
    // 名额在此获取：早于 upgrade 回调，因此「回调不执行」也有释放保证。
    const admission = options.limiter.admit(options.source)
    this.admission = admission.ok ? admission : undefined
    if (!admission.ok) {
      this.dead = true
      return
    }
    this.attachTimer = setTimeout(() => {
      this.attachTimer = undefined
      // 从未 attach：回调没跑，socket 不会再来。释放名额，门作废。
      if (!this.attached && !this.settled) {
        this.dead = true
        this.releaseAdmission()
      }
    }, options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS)
    this.attachTimer.unref()
  }

  /** 名额是否拿到；false 时 handleUpgrade 应直接拒掉这个源。 */
  get admitted(): boolean {
    return !this.dead
  }

  /**
   * ws 就绪：下发挑战并启动 hello 计时器。只应被调用一次。
   */
  attach(): void {
    if (this.dead || this.attached) return
    this.attached = true
    if (this.attachTimer !== undefined) {
      clearTimeout(this.attachTimer)
      this.attachTimer = undefined
    }
    this.options.host.send('s2c.auth.challenge', this.challenge)
    this.helloTimer = setTimeout(() => {
      this.helloTimer = undefined
      if (this.authenticated) return
      this.settle(false, 'timeout')
      this.options.host.close(4402, 'auth timeout')
    }, AUTH_TIMEOUT_MS)
    this.helloTimer.unref()
  }

  /** socket 关闭：未落定则按 closed 收尾（并释放名额）。 */
  onClose(): void {
    if (!this.settled) this.settle(false, 'closed')
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    if (this.attachTimer !== undefined) clearTimeout(this.attachTimer)
  }

  /**
   * 处理一条原始帧。内部完成全部 pre-auth 规则（长度上限、信封卫生、版本、
   * pre-auth 白名单、撤销吞帧），再进入认证、授权与分发。
   */
  async handleFrame(raw: string): Promise<void> {
    if (this.dead) return
    // 撤销后的设备正在关闭：吞掉一切，不再回应一个已不存在的设备。
    if (this.revoked) return
    // 长度上限先行：预认证帧很小，超限即拒且不解析——不让匿名端用 64MiB
    // 载荷在认证窗口内消耗 CPU。
    if (!this.authenticated && raw.length > PRE_AUTH_FRAME_BYTES) {
      this.options.host.close(1009, 'pre-auth frame too large')
      return
    }
    let env: Envelope
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isEnvelope(parsed)) {
        this.options.host.fail(undefined, 'E_PROTOCOL', 'malformed frame')
        return
      }
      env = parsed
    } catch {
      this.options.host.fail(undefined, 'E_PROTOCOL', 'frame is not valid JSON')
      return
    }
    if (env.v !== PROTOCOL_VERSION) {
      this.options.host.fail(env.id, 'E_UNSUPPORTED', 'unsupported protocol version')
      this.options.host.close(4500, 'protocol version mismatch')
      return
    }

    if (!this.authenticated) {
      // 匿名端对每个非控制帧只得到一个答复：透露哪些名字已注册等于泄露帧清单。
      const control = registryRowFor(env.type)
      if (control === undefined || control.stage !== 'pre-auth') {
        this.options.host.fail(env.id, 'E_PROTOCOL', 'authenticate first')
        return
      }
      await dispatchFrame(control, this.context(env), {})
      return
    }

    const row = registryRowFor(env.type)
    // widget 只读门在前，且覆盖未知类型：短连接只准发白名册行，其余一律
    // 「只读」，不泄露帧清单。
    if (this.widgetClient && (row === undefined || widgetPolicyOf(row) === 'deny')) {
      return this.options.host.fail(env.id, 'E_FORBIDDEN', 'widget connection is read-only')
    }
    // 未知类型直接 E_PROTOCOL（G6）。先查 scope 会让没有 sessions.read 的
    // 设备听到关于一个不存在帧的「权限不足」。
    if (row === undefined) {
      this.options.host.fail(env.id, 'E_PROTOCOL', 'unknown type: ' + env.type)
      return
    }
    const scope = scopeRejection(row, this.scopes)
    if (scope !== undefined) return this.options.host.fail(env.id, scope.code, scope.message)
    // 校验先于能力门，与迁移前「载荷形状先于 handler 看能力」的次序一致。
    const validated = validatePayload(row, env.payload)
    if (!validated.ok) return this.options.host.fail(env.id, validated.code, validated.message)
    const capability = capabilityRejection(row, this.options.host.bridge.capabilities)
    if (capability !== undefined) return this.options.host.fail(env.id, capability.code, capability.message)

    await dispatchFrame(row, this.context(env), validated.value)
  }

  /** 门持有的撤销标记由 device.revoke 行置位。 */
  markRevoked(): void {
    this.revoked = true
  }

  // ---------- 认证 ----------

  /** c2s.auth.prove 的行 handler 调用这里：验签、载入 scope、记账、落定。 */
  async authenticate(env: Envelope): Promise<void> {
    // 刚自撤销的 socket 正在关闭，不能再认证（注册表墓碑本来也会拒）。
    if (this.revoked) return
    const p = (env.payload ?? {}) as Partial<AuthProofPayload>
    if (!p.deviceId) {
      this.options.host.fail(env.id, 'E_PROTOCOL', 'deviceId required')
      this.options.host.close(4403, 'deviceId required')
      return
    }
    const deviceId = sanitizeDeviceField(p.deviceId, MAX_DEVICE_ID_CHARS)
    if (!deviceId) {
      this.options.host.fail(env.id, 'E_PROTOCOL', 'deviceId required')
      this.options.host.close(4403, 'deviceId required')
      return
    }
    const deviceName = sanitizeDeviceField(p.deviceName, MAX_DEVICE_NAME_CHARS) || 'unknown'
    const appVersion = sanitizeDeviceField(p.appVersion, MAX_APP_VERSION_CHARS) || 'unknown'
    const record = this.options.devices.authorized(deviceId)
    const resumeCursor = typeof p.resumeCursor === 'number' && Number.isInteger(p.resumeCursor) && p.resumeCursor >= 0
      ? p.resumeCursor
      : undefined
    const challengeMatches = p.nonce === this.challenge.nonce &&
      p.audience === this.challenge.audience &&
      p.issuedAt === this.challenge.issuedAt &&
      p.expiresAt === this.challenge.expiresAt &&
      Date.now() <= this.challenge.expiresAt
    const proofValid = record?.publicKey !== undefined && typeof p.signature === 'string' && challengeMatches &&
      verifyAuthProof(record.publicKey, {
        deviceId,
        deviceName,
        appVersion,
        resumeCursor,
        ...this.challenge,
      }, p.signature)
    if (!proofValid || record === undefined) {
      this.options.host.fail(env.id, 'E_AUTH', 'device proof missing or invalid')
      this.settle(false, 'invalid-proof')
      this.options.host.close(4401, 'invalid device proof')
      return
    }
    this.settle(true, 'success')
    this.authenticated = true
    this.deviceId = deviceId
    this.widgetClient = p.clientRole === 'widget'
    this.scopes = new Set(record.scopes ?? [])
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    if (!this.widgetClient) {
      this.options.devices.markAuthenticated(deviceId, deviceName, appVersion, Date.now())
    }
    this.options.host.deviceAuthenticated(deviceId)
    // 欢迎帧与重放由连接负责：认证是安全判定，欢迎是数据面展示。
    this.options.host.onAuthenticated({
      deviceId,
      scopes: this.scopes,
      widgetClient: this.widgetClient,
      resumeCursor: this.widgetClient ? undefined : resumeCursor,
      deviceName,
      appVersion,
    })
  }

  /** 限流记账与名额释放只此一处；exactly-once 由 settled 守卫保证。 */
  private settle(ok: boolean, reason: SettleReason): void {
    if (this.settled) return
    this.settled = true
    this.releaseAdmission()
    if (ok) {
      this.options.limiter.recordSuccess(this.options.source)
      return
    }
    const failure = this.options.limiter.recordFailure(this.options.source)
    if (failure.newlyBlocked) {
      const label = this.options.auditLabel?.(this.options.source) ?? this.options.source
      this.options.log(`authentication source blocked source=${label}`)
    }
  }

  private releaseAdmission(): void {
    this.admission?.release()
    this.admission = undefined
  }

  /** 把宿主投影成行看到的每帧上下文：id 绑进 send/fail，身份来自门。 */
  private context(env: Envelope): FrameContext {
    const host = this.options.host
    return {
      frame: env,
      deviceId: this.deviceId,
      widgetClient: this.widgetClient,
      bridge: host.bridge,
      devices: host.devices,
      debug: host.debug,
      log: (message) => host.log(message),
      send: (type, payload) => host.send(type, payload, env.id),
      fail: (code, message) => host.fail(env.id, code, message),
      close: (code, reason) => host.close(code, reason),
      canReceive: (scope) => host.canReceive(scope),
      push: (type, payload, seq) => host.push(type, payload, seq),
      lastCursor: () => host.lastCursor(),
      replay: (entries) => host.replay(entries),
      replayDone: () => host.replayDone(),
      resync: () => host.resync(),
      bufferOpenEvents: (sessionId) => host.bufferOpenEvents(sessionId),
      discardOpenBuffer: (sessionId, buffer) => host.discardOpenBuffer(sessionId, buffer),
      flushOpenBuffer: (sessionId, buffer) => host.flushOpenBuffer(sessionId, buffer),
      closeOpenSession: (sessionId) => host.closeOpenSession(sessionId),
      nextLiveActivityGeneration: () => host.nextLiveActivityGeneration(),
      get liveActivityGeneration() {
        return host.liveActivityGeneration
      },
      get pendingLiveActivityId() {
        return host.pendingLiveActivityId
      },
      setPendingLiveActivityId: (activityId) => host.setPendingLiveActivityId(activityId),
      markRevoked: () => this.markRevoked(),
      prove: () => this.authenticate(env),
      enrollPushKey: (enrollKey) => host.enrollPushKey(enrollKey),
      revokeSiblings: (deviceId) => host.revokeSiblings(deviceId),
    }
  }
}
