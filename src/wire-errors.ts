/**
 * 错误词表（error vocabulary）的唯一属主。
 *
 * 一条失败信息在系统里要过三种词汇：Host 控制器返回的错误码（`session-not-found`、
 * `schedule_conflict`……）、Bridge 结果里的状态、以及 wire 上的 `E_*` 码。
 * 此前这三层各有映射函数（host-bridge 里 5 个、connection-policy 里 2 个、
 * connection.ts 的 switch 里 5 处内联三元链），一处漂移就会让客户端对
 * 「该不该重试」的判断失真。
 *
 * 本 module 只做一次翻译：每个域一张「Host code -> wire code」表，
 * Bridge 的结果直接携带 wire 码。`E_BUSY` 与 `E_PROTOCOL` 决定客户端是否
 * 重试，因此这张表是 wire 行为的一部分，逐码都有测试把守。
 *
 * 规范见 PROTOCOL.md 错误码表（`E_PROTOCOL` = 未知类型或非法 payload，
 * `E_FORBIDDEN` = 权限不足，`E_UNSUPPORTED` = 能力缺失）。
 */

/** wire 错误码及其规范描述；PROTOCOL.md 错误码表的 TS 镜像。 */
export const ERROR_CODES = {
  E_AUTH: 'device proof missing or invalid',
  E_FORBIDDEN: 'device scope does not allow this operation',
  E_PROTOCOL: 'unknown type or malformed payload',
  E_NOT_FOUND: 'session or request not found',
  E_BUSY: 'session is busy',
  E_UNSUPPORTED: 'protocol version or capability unsupported',
  E_INTERNAL: 'internal error',
} as const

export type WireErrorCode = keyof typeof ERROR_CODES

/** Bridge 未携带 code 的结果（内部守卫失败等）落到这一档。 */
export const WIRE_ERROR_FALLBACK: WireErrorCode = 'E_INTERNAL'

/**
 * 每个域一张「Host code -> wire code」表。查不到的 Host code 归
 * `E_INTERNAL`：未知的 Host 失败对手机没有可执行含义，重试只会放大故障。
 *
 * 表的取值与迁移前的行为逐码一致（见 tests/wire-errors.test.ts 的对等部分），
 * 即此前各映射链的并集——包括 models 域把 `model-unavailable` 映到
 * `E_NOT_FOUND` 的现行取值。
 *
 * 键写的是 DSH 实际抛出的**带命名空间**的码（旧 host 的扁平写法作为兼容别名
 * 逐条保留，它们同时充当「命名空间换了但尾部没换」时的兜底——查表会先原样命中，
 * 再剥前缀命中，见 lookupCode）。
 *
 * schedule 域例外：定时任务服务（`@deepseek-ai/dsh-schedule`）至今仍抛扁平
 * snake_case（`schedule_not_found`），不要给它加命名空间。
 */
export type ErrorDomain = 'session' | 'model' | 'schedule'

const DOMAIN_TABLES: Record<ErrorDomain, Readonly<Record<string, WireErrorCode>>> = {
  // 会话/工作区/目录管理域的 Host 错误码。
  session: {
    'session/not-found': 'E_NOT_FOUND',
    'workspace/not-found': 'E_NOT_FOUND',
    'session/agent-busy': 'E_BUSY',
    // writer-held 与 agent-busy 同类：会话正被别人占着写，稍后重试有意义。
    'session/writer-held': 'E_BUSY',
    'session/conflict': 'E_BUSY',
    'workspace/session-active': 'E_BUSY',
    'gateway/bad-request': 'E_PROTOCOL',
    'session/title-invalid': 'E_PROTOCOL',
    'session/attachment-invalid': 'E_PROTOCOL',
    'session/invalid-time-zone': 'E_PROTOCOL',
    'workspace/invalid-path': 'E_PROTOCOL',
    'workspace/name-conflict': 'E_PROTOCOL',
    'workspace/move-invalid': 'E_PROTOCOL',
    'workspace-file/not-found': 'E_NOT_FOUND',
    'directory-picker/unavailable': 'E_UNSUPPORTED',
    // 旧 host 的扁平写法：保留是为了兼容仍在跑的老 DSH。
    'session-not-found': 'E_NOT_FOUND',
    'workspace-not-found': 'E_NOT_FOUND',
    'agent-busy': 'E_BUSY',
    'session-conflict': 'E_BUSY',
    'title-invalid': 'E_PROTOCOL',
    'workspace-invalid-path': 'E_PROTOCOL',
    'workspace-name-conflict': 'E_PROTOCOL',
    'directory-unreadable': 'E_PROTOCOL',
    'directory-exists': 'E_PROTOCOL',
    'directory-create-failed': 'E_PROTOCOL',
    'directory-picker-unavailable': 'E_UNSUPPORTED',
  },
  // 模型目录与切换域的 Host 错误码。
  model: {
    'session/not-found': 'E_NOT_FOUND',
    'session/agent-busy': 'E_BUSY',
    'session/writer-held': 'E_BUSY',
    'session/conflict': 'E_BUSY',
    'session/model-unavailable': 'E_NOT_FOUND',
    // 旧 host 的扁平写法。
    'session-not-found': 'E_NOT_FOUND',
    'agent-busy': 'E_BUSY',
    'session-conflict': 'E_BUSY',
    'model-unavailable': 'E_NOT_FOUND',
  },
  // 定时任务域的 Host 错误码（snake_case 是 Host Schedule 服务的词表，至今未变）。
  schedule: {
    'schedule_not_found': 'E_NOT_FOUND',
    'delivery_cursor_not_found': 'E_NOT_FOUND',
    'schedule_conflict': 'E_BUSY',
    'invalid_prompt': 'E_PROTOCOL',
    'invalid_selector': 'E_PROTOCOL',
    'invalid_rule': 'E_PROTOCOL',
    'invalid_time_zone': 'E_PROTOCOL',
    'not_future': 'E_PROTOCOL',
    'time_out_of_range': 'E_PROTOCOL',
    'frequency_too_high': 'E_PROTOCOL',
    'schedule_ended': 'E_PROTOCOL',
    // DSH 0.2.1-alpha.1 新增：目标会话属于子代理路由，投递永远到不了它，
    // Host 对 create/update 拒绝（delete 仍放行以便清理旧数据）。
    // 归 E_PROTOCOL 而非 E_UNSUPPORTED：能力本身在宿主上存在，是这次请求
    // 的目标不可满足，重试无意义。与其余「参数/时序不合法」类拒绝同档。
    'subagent_session': 'E_PROTOCOL',
  },
}

/**
 * 一个 Host 失败在 Bridge 侧的形状。
 *
 * `details` 是 DSH 的 `RemoteError` 附带的结构化载荷（dsh-typert-protocol 的
 * `remote-error.d.ts`），键由错误码决定；prompt 准入那一路的 `reason` 装的就是
 * 被包装掉的真实原因。窄化成只读 `reason` 是因为**只有**这一路会用到它。
 */
export interface HostFailure {
  code: string
  message?: string
  readonly details?: { readonly reason?: unknown } | undefined
}

/**
 * 剥掉 `namespace/` 前缀：`session/agent-busy` -> `agent-busy`。
 *
 * DSH 的 API 层现在抛的是带命名空间的码（`session/agent-busy`、
 * `workspace/not-found`、`gateway/internal`……），而下面的表一开始只有扁平写法。
 * 两边对不上时整表失配、一律落进 `E_INTERNAL`，于是 `E_BUSY` 永远出不来——
 * 而 `E_BUSY` 正是客户端决定「该不该重试」的那个码（issue #26）。
 */
export function canonicalHostCode(code: string): string {
  const slash = code.lastIndexOf('/')
  return slash === -1 ? code : code.slice(slash + 1)
}

/** 查表顺序：原样命中优先，其次剥掉命名空间后命中，最后才是兜底。 */
function lookupCode(domain: ErrorDomain, code: string): WireErrorCode {
  const table = DOMAIN_TABLES[domain]
  return table[code] ?? table[canonicalHostCode(code)] ?? WIRE_ERROR_FALLBACK
}

/** 一个 Host 失败翻译成 Bridge 的失败结果：直接携带 wire 错误码。 */
export function wireErrorOf(
  domain: ErrorDomain,
  error: HostFailure,
): { ok: false; code: WireErrorCode; message: string } {
  const code = lookupCode(domain, error.code)
  return {
    ok: false,
    code,
    message: describeFailure(error, code),
  }
}

/**
 * 组装给手机看的那句话。
 *
 * DSH 把 prompt 准入的**任意**内部失败包成 `session/agent-busy`，真实原因只留在
 * `details.reason`（`@deepseek-ai/dsh-api-session-controller` 的 `types/commands.js`
 * 里那一句 `throw new RemoteError('session/agent-busy', 'prompt rejected', { reason: … })`）。
 * 插件原先只取 `message`，于是手机端永远只显示笼统的「发送未确认」。
 *
 * 只在落到 `E_INTERNAL` 时追加 reason：这类码按定义对客户端没有可执行含义，
 * 多这一句不改变「该不该重试」的判断，却能让用户和排查者看到真正的原因。已映射
 * 的码本身已经可执行，保持原样不动。
 */
function describeFailure(error: HostFailure, wireCode: WireErrorCode): string {
  const base = error.message ?? error.code
  if (wireCode !== WIRE_ERROR_FALLBACK) return base
  const reason = error.details?.reason
  if (typeof reason !== 'string' || reason.length === 0) return base
  return `${base} (${error.code}): ${reason}`
}

/** 只有一个 Host code（没有附带 message）时取它的 wire 码。 */
export function wireCodeFor(domain: ErrorDomain, hostCode: string | undefined): WireErrorCode {
  if (hostCode === undefined) return WIRE_ERROR_FALLBACK
  return lookupCode(domain, hostCode)
}

/**
 * 回答待决 approval/question 的三种结局。保留三分而不是压成布尔：
 * 「没有这条待决」与「Host 拒收了答案」必须让客户端分得清，否则手机上
 * 任何拒绝都显示成 question not pending。
 */
export type PendingResponseReason = 'not-pending' | 'bad-response' | 'transport'

export function pendingResponseErrorCode(reason: PendingResponseReason): WireErrorCode {
  switch (reason) {
    case 'not-pending': return 'E_NOT_FOUND'
    // Host 拒收了答案批次（形状/标签不匹配）——客户端载荷问题，不是待决消失。
    case 'bad-response': return 'E_PROTOCOL'
    case 'transport': return 'E_INTERNAL'
  }
}

/** 与 pendingResponseErrorCode 配套的可读信息，同一处维护。 */
export function pendingResponseMessage(
  kind: 'approval' | 'question',
  reason: PendingResponseReason,
): string {
  switch (reason) {
    case 'not-pending': return kind + ' not pending'
    case 'bad-response': return kind + ' answer rejected by host: answer does not match the asked questions'
    case 'transport': return 'host connection failed while answering ' + kind
  }
}
