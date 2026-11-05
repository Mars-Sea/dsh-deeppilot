/**
 * 计划任务按需完成通知（#35）。
 *
 * heartbeat 式计划任务大多数轮次"一切正常"，每轮都推「任务完成」是噪音。插件
 * 给计划任务会话提供一个 Agent 工具：Agent 按任务提示词里的规则判断本轮不需要
 * 提醒时调用它，本轮成功结束就不发完成通知（不写 s2c.notify、不推 APNs）。
 * 失败、审批、提问照常通知；模型忘了调用时照常提醒，宁可多一次打扰也不漏报。
 *
 * 职责划分：
 * - scheduledTurnOf：同步读宿主会话日志，判定当前这一轮是否由计划任务投递驱动。
 *   工具的 `when` 与 `execute` 都在宿主进程内同步调用它，不依赖桥接层异步收到的
 *   事件（实测 `when` 求值时本轮 user/message 尚未落盘，桥接层也还没收到）。
 * - QuietCompletionTracker：计划任务会话的粘性集合，以及每个会话"本轮已请求静默"
 *   的记录；HostBridge 在 user/message 与 turn.end 处调用它。
 * - quietCompletionTool：面向模型的工具定义，由 index.ts 注册到宿主 `ctx.tools`。
 *
 * 只在宿主级计划任务（`schedulesHost`，DSH 0.2.2 起）上注册：0.2.1 的
 * `tools.register` 不支持 `when`，多余参数会被静默忽略，工具会变成全局可见。
 */

export const QUIET_COMPLETION_TOOL_NAME = 'deeppilot_skip_completion_notice'
/** reason 只出现在时间线的工具卡片里（日志只记长度），超出部分截断而不是拒绝调用。 */
export const MAX_QUIET_REASON_CHARS = 200
/** 往回扫描会话日志的上限：一轮内的事件远少于此，防止异常长轮次拖慢步骤准备。 */
export const MAX_TURN_SCAN_EVENTS = 2000

export interface QuietCompletionResult {
  suppressed: boolean
  note?: string
}

/** 宿主 Session 的最小只读形状（dsh-session：`id`、`seq`、`eventAt`）。 */
export interface SessionLogLike {
  readonly id: string
  readonly seq: number
  eventAt(seq: number): { type: string; data?: unknown } | undefined
}

/** 工具 `when` / `execute` 拿到的 agent。会话从 `agent.session` 读：运行时对象没有类型里声明的 `sessionId`。 */
export interface AgentLike {
  session?: unknown
}

export function sessionLogOf(agent: AgentLike | undefined): SessionLogLike | undefined {
  const session = agent?.session as Partial<SessionLogLike> | undefined
  if (!session || typeof session.id !== 'string' || typeof session.seq !== 'number' || typeof session.eventAt !== 'function') {
    return undefined
  }
  return session as SessionLogLike
}

export interface TurnVerdict {
  /** 本轮最近一条驱动消息是计划任务投递（且其后没有用户消息）。 */
  scheduled: boolean
  /** 本轮 `turn/start` 的轮次号；日志里读不到时为 undefined。 */
  turn?: number
}

type InboxItem = { source?: { kind?: unknown } }
type SplicedData = { target?: unknown; inserted?: unknown }

function sourceKindOf(value: unknown): string | undefined {
  const kind = (value as { source?: { kind?: unknown } } | undefined)?.source?.kind
  return typeof kind === 'string' ? kind : undefined
}

/** 一次 inbox 拼接里插入的条目（按插入顺序）及其目标队列。 */
function insertedOf(event: { type: string; data?: unknown }): { target: unknown; items: InboxItem[] } | undefined {
  if (event.type !== 'agent/inbox/spliced') return undefined
  const data = event.data as SplicedData | undefined
  const items = Array.isArray(data?.inserted) ? (data.inserted as InboxItem[]) : []
  return items.length > 0 ? { target: data?.target, items } : undefined
}

/**
 * 判定当前这一轮是否由计划任务投递驱动（同步读宿主会话日志，DSH 0.2.2-rc.1 实测形状）。
 *
 * 宿主把待处理消息先拼进 inbox（`agent/inbox/spliced`，带条目本体与目标队列），
 * `turn/start` 之后的拼接只是取走（`removedCount`，不带内容），条目随后才落成
 * user/message。因此按 inbox 插入判定：
 * - 本轮开始之后插入 `next-step` 的用户条目 = 用户中途插话，不算；
 * - 本轮开始时取走的是上一轮开始之后插入 `next-turn` 的条目；其中最后插入的一条
 *   来源为 `schedule` 才算（计划任务投递）；来源为 `user` 不算；
 * - 同为 `schedule` 来源的任务变更提示插入的是 `next-step`（宿主注明"不是投递"），不参与判定；
 * - 扫不到本轮 `turn/start` 时按普通轮次处理，宁可照常提醒。
 */
export function scheduledTurnOf(session: SessionLogLike): TurnVerdict {
  const floor = Math.max(0, session.seq - MAX_TURN_SCAN_EVENTS)
  let turn: number | undefined
  let seenTurnStart = false
  for (let seq = session.seq - 1; seq >= floor; seq--) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'turn/start') {
      if (seenTurnStart) break
      seenTurnStart = true
      const value = (event.data as { turn?: unknown } | undefined)?.turn
      if (typeof value === 'number') turn = value
      continue
    }
    const splice = insertedOf(event)
    if (splice === undefined) continue
    if (!seenTurnStart) {
      if (splice.target === 'next-step' && splice.items.some((item) => sourceKindOf(item) === 'user')) {
        return { scheduled: false, ...(turn !== undefined ? { turn } : {}) }
      }
      continue
    }
    if (splice.target !== 'next-turn') continue
    for (let index = splice.items.length - 1; index >= 0; index--) {
      const kind = sourceKindOf(splice.items[index])
      if (kind === 'user') return { scheduled: false, ...(turn !== undefined ? { turn } : {}) }
      if (kind === 'schedule') return { scheduled: true, ...(turn !== undefined ? { turn } : {}) }
    }
  }
  return { scheduled: false, ...(turn !== undefined ? { turn } : {}) }
}

interface QuietRequest {
  /** 请求静默时本轮的轮次号。 */
  turn?: number
  /** 请求静默时的会话日志位置；更早的 turn.end 是上一轮的迟到事件。 */
  seq: number
}

export class QuietCompletionTracker {
  /**
   * 判定过计划任务轮次的会话。粘性集合：加入后不再移除，工具不按轮出现或消失。
   * 宿主每次工具列表变化都会往会话追加一条工具增减消息并让提示词缓存失效，
   * 按轮开关会让同一会话反复产生这类消息。
   */
  private readonly scheduleSessions = new Set<string>()
  private readonly quiet = new Map<string, QuietRequest>()

  /** 启动时用宿主任务列表里的投递目标会话预热，避免重启后工具先消失再出现。 */
  seed(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      if (sessionId) this.scheduleSessions.add(sessionId)
    }
  }

  isScheduleSession(sessionId: string): boolean {
    return this.scheduleSessions.has(sessionId)
  }

  /** 加入粘性集合；返回是否为新加入（调用方据此记一次日志）。 */
  markScheduleSession(sessionId: string): boolean {
    if (this.scheduleSessions.has(sessionId)) return false
    this.scheduleSessions.add(sessionId)
    return true
  }

  /** 工具执行：只在计划任务轮次内生效。 */
  requestQuiet(sessionId: string | undefined, verdict: TurnVerdict, seq: number): QuietCompletionResult {
    if (sessionId === undefined || !verdict.scheduled) {
      return {
        suppressed: false,
        note: 'This run was not started by a scheduled task; the completion notification will be sent as usual.',
      }
    }
    this.quiet.set(sessionId, { ...(verdict.turn !== undefined ? { turn: verdict.turn } : {}), seq })
    return { suppressed: true }
  }

  /**
   * 桥接层观察到 user/message：用户在请求静默之后插话（日志位置更晚）就撤销静默，
   * 本轮照常提醒。计划任务与注入上下文不影响。
   */
  noteUserMessage(sessionId: string, sourceKind: string | undefined, seq: number | undefined): void {
    const request = this.quiet.get(sessionId)
    if (request === undefined || sourceKind !== 'user') return
    if (seq === undefined || seq > request.seq) this.quiet.delete(sessionId)
  }

  /**
   * turn.end 时调用。返回 true 表示本轮完成通知应被抑制：成功结束、且本轮请求过静默。
   * 轮次号能对上时按轮次号判定；迟到的上一轮 turn.end 保留本轮的请求。
   */
  consumeTurnEnd(sessionId: string, ok: boolean, turn: number | undefined, seq: number | undefined): boolean {
    const request = this.quiet.get(sessionId)
    if (request === undefined) return false
    if (turn !== undefined && request.turn !== undefined) {
      if (turn < request.turn) return false
      this.quiet.delete(sessionId)
      return ok && turn === request.turn
    }
    if (seq !== undefined && seq < request.seq) return false
    this.quiet.delete(sessionId)
    return ok
  }
}

/** 宿主 `ctx.tools` 的最小形状；插件不依赖 dsh-tools 包，按其原始定义契约手写。 */
export interface ToolsServiceLike {
  register(definition: unknown, options?: { when?: (context: { agent?: AgentLike }) => boolean }): () => void
}

const DESCRIPTION = [
  'Call this during a scheduled run only when the task prompt says the user does not need to be notified',
  'for results like this one. It suppresses only this run\'s "task completed" notification; approvals,',
  'questions and errors still notify. Do not call it if anything needs the user\'s attention, or if the',
  'prompt gives no such rule.',
].join(' ')

/** reason 归一化：非字符串按空串处理，去首尾空白并截断。 */
function normalizeReason(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  return text.length > MAX_QUIET_REASON_CHARS ? text.slice(0, MAX_QUIET_REASON_CHARS) : text
}

/**
 * 面向模型的工具定义（宿主 ToolDefinition 原始形状：JSON Schema 参数、输出 schema
 * 与 render、execute）。`log` 只记会话 ID、结果与 reason 长度：reason 由模型撰写，
 * 可能引用结果内容，按插件日志约定不打正文。
 */
export function quietCompletionTool(
  tracker: QuietCompletionTracker,
  log: (message: string) => void = () => {},
): unknown {
  return {
    name: QUIET_COMPLETION_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: {
        reason: {
          type: 'string',
          description: `Why this run does not need the user's attention (at most ${MAX_QUIET_REASON_CHARS} characters).`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['suppressed'],
        properties: {
          suppressed: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
      render(_args: unknown, value: QuietCompletionResult) {
        const text = value.suppressed
          ? 'The completion notification for this run will not be sent.'
          : value.note ?? 'The completion notification will be sent as usual.'
        return [{ type: 'text', text }]
      },
    },
    async execute(args: unknown, exec: { agent?: AgentLike }): Promise<QuietCompletionResult> {
      const session = sessionLogOf(exec.agent)
      const reason = normalizeReason((args as { reason?: unknown } | undefined)?.reason)
      const result = session === undefined
        ? tracker.requestQuiet(undefined, { scheduled: false }, 0)
        : tracker.requestQuiet(session.id, scheduledTurnOf(session), session.seq)
      log(`quiet completion requested session=${session?.id ?? '?'} suppressed=${result.suppressed} reasonChars=${reason.length}`)
      return result
    },
  }
}

/**
 * 注册工具。`when`：粘性集合内的会话直接放行；否则同步判定本轮是否计划任务轮次，
 * 是则加入集合（首轮即可见，`new` 目标每次新建的会话同样可见）。普通会话看不到。
 * 返回宿主给的注销函数。
 */
export function registerQuietCompletionTool(
  tools: ToolsServiceLike,
  tracker: QuietCompletionTracker,
  log: (message: string) => void = () => {},
): () => void {
  return tools.register(quietCompletionTool(tracker, log), {
    when: (context) => {
      const session = sessionLogOf(context.agent)
      if (session === undefined) return false
      if (tracker.isScheduleSession(session.id)) return true
      if (!scheduledTurnOf(session).scheduled) return false
      if (tracker.markScheduleSession(session.id)) log(`quiet completion: session joined scheduled set session=${session.id}`)
      return true
    },
  })
}
