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
 */
export type ErrorDomain = 'session' | 'model' | 'schedule'

const DOMAIN_TABLES: Record<ErrorDomain, Readonly<Record<string, WireErrorCode>>> = {
  // 会话/工作区/目录管理域的 Host 错误码。
  session: {
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
    'session-not-found': 'E_NOT_FOUND',
    'agent-busy': 'E_BUSY',
    'session-conflict': 'E_BUSY',
    'model-unavailable': 'E_NOT_FOUND',
  },
  // 定时任务域的 Host 错误码（snake_case 是 Host Schedule 服务的词表）。
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
  },
}

/** 一个 Host 失败翻译成 Bridge 的失败结果：直接携带 wire 错误码。 */
export function wireErrorOf(
  domain: ErrorDomain,
  error: { code: string; message?: string },
): { ok: false; code: WireErrorCode; message: string } {
  return {
    ok: false,
    code: DOMAIN_TABLES[domain][error.code] ?? WIRE_ERROR_FALLBACK,
    message: error.message ?? error.code,
  }
}

/** 只有一个 Host code（没有附带 message）时取它的 wire 码。 */
export function wireCodeFor(domain: ErrorDomain, hostCode: string | undefined): WireErrorCode {
  if (hostCode === undefined) return WIRE_ERROR_FALLBACK
  return DOMAIN_TABLES[domain][hostCode] ?? WIRE_ERROR_FALLBACK
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
