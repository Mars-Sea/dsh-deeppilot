/**
 * wire 注册表（wire registry）——phone wire 缝的 host 侧属主。
 *
 * 一帧一行：`stage`（认证前/后）、`scopes`（全部满足）、`widgetPolicy`
 * （widget 短连接可读性）、`capability`（welcome 位门）、`validate`
 * （形状与资源上限）、`handle`（帧逻辑）。此前这些事实分散在四个模块里，
 * 各用一种风格枚举帧类型：connection.ts 的 switch、connection-policy 的
 * requiredScope if 链、request-validation 的 if 链、host-bridge 的
 * capabilities getter 与方法内 typeof 探测。
 *
 * 本 module 只提供表的形状、检查与 dispatch；handler 体按特性住在
 * wire-session / wire-schedule / wire-push / wire-device / wire-interaction，
 * 各自向这里登记自己的行（静态导入，无 import 副作用）。
 *
 * 帧的不变量由 tests/wire-registry.test.ts 逐行断言：每位被闸的帧都绑定一个
 * 已存在的 welcome 位、每个 scope 都是合法 DeviceScope、每个类型都有行、
 * 每行都指向 PROTOCOL.md 的一个小节。
 */

import type { Envelope } from './protocol.ts'
import type { BridgeSink, HostBridge } from './host-bridge.ts'
import type { WelcomeCapabilities } from './protocol.ts'
import type { DeviceStore } from './token.ts'
import type { DeviceScope } from './device-auth.ts'
import type { CapabilityGate } from './host-capabilities.ts'
import type { WireErrorCode } from './wire-errors.ts'

/** 出站帧字面量：与入站共用一份词汇，record() 随后只接受这个子集。 */
export type S2CType =
  | 's2c.ack'
  | 's2c.auth.challenge'
  | 's2c.directory.listing'
  | 's2c.directory.picked'
  | 's2c.error'
  | 's2c.history.page'
  | 's2c.notify'
  | 's2c.pending.approval'
  | 's2c.pending.cleared'
  | 's2c.pending.question'
  | 's2c.pending.snapshot'
  | 's2c.pong'
  | 's2c.resume.done'
  | 's2c.resync'
  | 's2c.schedule.changed'
  | 's2c.schedule.history'
  | 's2c.schedule.snapshot'
  | 's2c.schedule.updated'
  | 's2c.session.archived'
  | 's2c.session.event'
  | 's2c.session.forked'
  | 's2c.session.models'
  | 's2c.session.modelSelected'
  | 's2c.session.renamed'
  | 's2c.session.tail'
  | 's2c.session.unarchived'
  | 's2c.sessions.archived.snapshot'
  | 's2c.sessions.delta'
  | 's2c.sessions.snapshot'
  | 's2c.welcome'
  | 's2c.workspace.created'
  | 's2c.workspaces.snapshot'

/**
 * 入站帧字面量 = 本 Bridge 实现的全部客户端帧。
 *
 * 注意 `c2s.resume` 不在其中：PROTOCOL.md 把它与 c2s.ping 并列为控制帧，但
 * 续传由 `c2s.auth.prove` 的 `resumeCursor` 字段承载，没有独立的 resume 帧
 * （历史上 requiredScope 为它留过一个无人使用的条目，见 G7）。
 */
export type C2SType =
  | 'c2s.ping'
  | 'c2s.auth.prove'
  | 'c2s.sessions.list'
  | 'c2s.sessions.archived'
  | 'c2s.pending.list'
  | 'c2s.workspaces.list'
  | 'c2s.workspace.create'
  | 'c2s.directory.list'
  | 'c2s.directory.pick'
  | 'c2s.session.open'
  | 'c2s.session.close'
  | 'c2s.session.create'
  | 'c2s.session.fork'
  | 'c2s.session.rename'
  | 'c2s.session.archive'
  | 'c2s.session.unarchive'
  | 'c2s.session.cancel'
  | 'c2s.session.history'
  | 'c2s.session.attachment'
  | 'c2s.session.models'
  | 'c2s.session.selectModel'
  | 'c2s.session.delivery'
  | 'c2s.session.sendPrompt'
  | 'c2s.schedule.list'
  | 'c2s.schedule.history'
  | 'c2s.schedule.create'
  | 'c2s.schedule.update'
  | 'c2s.schedule.delete'
  | 'c2s.approval.respond'
  | 'c2s.question.respond'
  | 'c2s.device.revoke'
  | 'c2s.liveActivity.register'
  | 'c2s.liveActivity.unregister'
  | 'c2s.push.register'
  | 'c2s.widget.push.register'

/** 帧在连接生命周期里允许出现的阶段。 */
export type FrameStage = 'pre-auth' | 'authenticated'

/**
 * widget 短连接（clientRole: "widget"）的帧策略。
 *
 * - `allowed`：只读面板需要的少量帧；
 * - `deny`：通用只读拒绝；
 * - `handler`：交给 handler 用自己的理由拒绝——用于 c2s.device.revoke，
 *   通用门禁只会说 "read-only"，而规范要求给出「小组件不得解绑设备」的
 *   具体原因（PROTOCOL.md device.revoke 一节）。
 */
export type WidgetPolicy = 'allowed' | 'deny' | 'handler'

export const DEFAULT_WIDGET_POLICY: WidgetPolicy = 'deny'

/** 拒绝：wire 错误码 + 可读信息。undefined 表示通过。 */
export interface WireRejection {
  code: WireErrorCode
  message: string
}

/**
 * 校验结果：通过时带上「归一化后的载荷」——形状检查与归一化同处一行，
 * handler 拿到的就是可直接使用的值（比如 sendPrompt 的 images/documents
 * 已在此时完成媒体类型与长度清洗）。拒绝时带 wire 错误码与可读信息。
 */
export type CheckedPayload =
  | { ok: true; value: Record<string, unknown> }
  | ({ ok: false } & WireRejection)

/** 一帧在打开历史期间缓存的实时事件；连接持有所有权。 */
export interface OpenEventBuffer {
  readonly frames: Array<{ type: string; payload: unknown; seq?: number }>
}

/**
 * handler 看到的每帧 facade：把当前帧的 id 绑进 send/fail，handler 不必传 id；
 * 连接自身状态（打开中的会话缓冲、live activity 代次、撤销标志）以少量操作
 * 暴露，所有权仍在 connection —— 注册表只拥有帧的事实。
 */
export interface FrameContext extends BridgeSink {
  readonly frame: Envelope
  readonly deviceId: string | undefined
  readonly widgetClient: boolean
  readonly bridge: HostBridge
  readonly devices: DeviceStore
  readonly debug: boolean
  log(message: string): void
  send(type: S2CType, payload: unknown): void
  fail(code: WireErrorCode, message: string): void
  close(code: number, reason: string): void
  bufferOpenEvents(sessionId: string): OpenEventBuffer
  /** 打开失败：仅当缓冲仍属于本次尝试时才移除。 */
  discardOpenBuffer(sessionId: string, buffer: OpenEventBuffer): void
  /** 打开成功：认领缓冲并按其到达顺序补发；被并发操作取代时返回 false。 */
  flushOpenBuffer(sessionId: string, buffer: OpenEventBuffer): boolean
  closeOpenSession(sessionId: string): void
  /** 抬升 Live Activity 注册代次并返回新值；在途注册用旧值比对即知自己已被取代。 */
  nextLiveActivityGeneration(): number
  /** 当前代次：await 之后重新比对用。 */
  readonly liveActivityGeneration: number
  readonly pendingLiveActivityId: string | undefined
  setPendingLiveActivityId(activityId: string | undefined): void
  markRevoked(): void
  /** c2s.auth.prove 的实现仍在连接里：机制属于连接，行只登记事实。 */
  prove(): Promise<void>
  enrollPushKey(enrollKey: string): Promise<void> | void
  revokeSiblings(deviceId: string): Promise<unknown> | unknown
}

export interface WireFrameRow {
  readonly type: C2SType
  readonly stage: FrameStage
  /** 全部满足才放行；空数组表示控制帧，不要求业务 scope。 */
  readonly scopes: readonly DeviceScope[]
  readonly widgetPolicy?: WidgetPolicy
  readonly capability?: CapabilityGate
  /** PROTOCOL.md 小节名；tests/wire-registry.test.ts 断言其存在。 */
  readonly doc: string
  readonly validate?: (payload: unknown) => CheckedPayload
  readonly handle: (ctx: FrameContext, payload: Record<string, unknown>) => Promise<void> | void
}

// ---------- 检查（connection 在 dispatch 前依次调用） ----------

/** 第一个缺失的 scope；消息与迁移前一致（`scope <name> required`）。 */
export function scopeRejection(
  row: WireFrameRow,
  scopes: ReadonlySet<DeviceScope>,
): WireRejection | undefined {
  for (const scope of row.scopes) {
    if (!scopes.has(scope)) return { code: 'E_FORBIDDEN', message: `scope ${scope} required` }
  }
  return undefined
}

/** 能力位关闭时拒绝。校验先于本检查，与迁移前的次序一致。 */
export function capabilityRejection(
  row: WireFrameRow,
  capabilities: WelcomeCapabilities,
): WireRejection | undefined {
  if (row.capability === undefined) return undefined
  if (capabilities[row.capability] === true) return undefined
  return { code: 'E_UNSUPPORTED', message: 'capability unavailable on this host version' }
}

export function widgetPolicyOf(row: WireFrameRow): WidgetPolicy {
  return row.widgetPolicy ?? DEFAULT_WIDGET_POLICY
}

/** 校验一帧载荷；未登记 validate 的行原样通过。 */
export function validatePayload(row: WireFrameRow, payload: unknown): CheckedPayload {
  if (row.validate === undefined) {
    return { ok: true, value: (payload ?? {}) as Record<string, unknown> }
  }
  return row.validate(payload)
}

/** 执行一帧。检查（阶段/scope/能力/校验）由 connection 按序先行完成。 */
export async function dispatchFrame(
  row: WireFrameRow,
  ctx: FrameContext,
  payload: Record<string, unknown>,
): Promise<void> {
  await row.handle(ctx, payload)
}

// ---------- 行内校验共用工具 ----------

/**
 * 载荷必须是普通对象。此前这条判定住在 request-validation 里，对
 * `c2s.sessions.list` 等无参帧豁免、对 `c2s.sessions.archived` 却不通融
 * （同语义两种待遇，见 G2）；现在豁免由各行的 validate 自己声明。
 */
export function payloadObject(value: unknown): CheckedPayload {
  if (value === undefined || value === null) return { ok: true, value: {} }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'E_PROTOCOL', message: 'payload must be an object' }
  }
  return { ok: true, value: value as Record<string, unknown> }
}

/** 字符串字段：类型正确、不超长、非空（可放宽）。 */
export function isText(value: unknown, max = 4096, nonempty = true): boolean {
  return typeof value === 'string' && value.length <= max && (!nonempty || value.trim().length > 0)
}

/** 可选字段：缺省合法，给出时必须满足 check。 */
export function isOptionalField(
  payload: Record<string, unknown>,
  key: string,
  check: (value: unknown) => boolean,
): boolean {
  return payload[key] === undefined || check(payload[key])
}

export function isInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

export function reject(code: WireErrorCode, message: string): CheckedPayload {
  return { ok: false, code, message }
}

export function accept(value: Record<string, unknown>): CheckedPayload {
  return { ok: true, value }
}

// ---------- 表 ----------

import { interactionRows } from './wire-interaction.ts'
import { deviceRows } from './wire-device.ts'
import { pushRows } from './wire-push.ts'
import { scheduleRows } from './wire-schedule.ts'
import { sessionRows } from './wire-session.ts'

/** 全部入站行。装配是静态的：新增特性 module 必须在这里显式出现。 */
export const WIRE_FRAME_ROWS: readonly WireFrameRow[] = [
  ...sessionRows,
  ...scheduleRows,
  ...interactionRows,
  ...pushRows,
  ...deviceRows,
]

const ROWS_BY_TYPE = new Map<C2SType, WireFrameRow>(WIRE_FRAME_ROWS.map((row) => [row.type, row]))

export function registryRowFor(type: string): WireFrameRow | undefined {
  return ROWS_BY_TYPE.get(type as C2SType)
}

/** 供 build 期不变量检查与测试使用：每行可索引。 */
export function wireFrameRows(): readonly WireFrameRow[] {
  return WIRE_FRAME_ROWS
}
