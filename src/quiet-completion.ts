/**
 * 计划任务按需完成通知（#35）。
 *
 * heartbeat 式计划任务大多数轮次"一切正常"，每轮都推「任务完成」是噪音。插件
 * 给计划任务会话提供一个 Agent 工具：Agent 按任务提示词里的规则判断本轮不需要
 * 提醒时调用它，本轮成功结束就不发完成通知（不写 s2c.notify、不推 APNs）。
 * 失败、审批、提问照常通知；模型忘了调用时照常提醒，宁可多一次打扰也不漏报。
 *
 * 职责划分：
 * - QuietCompletionTracker：识别计划任务会话与计划任务轮次，记录本轮是否请求
 *   静默；HostBridge 在 user/message 与 turn.end 处调用它。
 * - quietCompletionTool：面向模型的工具定义，由 index.ts 注册到宿主 `ctx.tools`。
 *
 * 只在宿主级计划任务（`schedulesHost`，DSH 0.2.2 起）上注册：0.2.1 的
 * `tools.register` 不支持 `when`，多余参数会被静默忽略，工具会变成全局可见。
 */

export const QUIET_COMPLETION_TOOL_NAME = 'deeppilot_skip_completion_notice'
/** reason 只出现在时间线的工具卡片里（日志只记长度），超出部分截断而不是拒绝调用。 */
export const MAX_QUIET_REASON_CHARS = 200

export interface QuietCompletionResult {
  suppressed: boolean
  note?: string
}

interface TurnState {
  /** 本轮由计划任务投递触发，且之后用户没有插话。 */
  scheduled: boolean
  /** Agent 已在本轮请求静默。 */
  quiet: boolean
}

export class QuietCompletionTracker {
  /**
   * 收到过计划任务投递的会话。粘性集合：加入后不再移除，工具不按轮出现或消失。
   * 宿主每次工具列表变化都会往会话追加一条工具增减消息并让提示词缓存失效，
   * 按轮开关会让同一会话反复产生这类消息。
   */
  private readonly scheduleSessions = new Set<string>()
  private readonly turns = new Map<string, TurnState>()

  /** 启动时用宿主任务列表里的投递目标会话预热，避免重启后工具先消失再出现。 */
  seed(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      if (sessionId) this.scheduleSessions.add(sessionId)
    }
  }

  /** 工具 `when` 条件：只有计划任务会话能看到这个工具。 */
  isScheduleSession(sessionId: string): boolean {
    return this.scheduleSessions.has(sessionId)
  }

  /**
   * 观察一条 user/message 的来源。`schedule` 标记本轮为计划任务轮次；`user`（或旧宿主
   * 没有来源，按用户消息处理）表示用户插话，本轮回到普通轮次、撤销已请求的静默；
   * 其他注入上下文（技能、运行时快照等）不影响判定。
   */
  noteUserMessage(sessionId: string, sourceKind: string | undefined): void {
    if (sourceKind === 'schedule') {
      this.scheduleSessions.add(sessionId)
      // 同一轮又来一条投递时撤销已请求的静默：新内容要由 Agent 重新判断。
      this.turns.set(sessionId, { scheduled: true, quiet: false })
      return
    }
    if (sourceKind === 'user' || sourceKind === undefined) {
      this.turns.delete(sessionId)
    }
  }

  /** 工具执行：只在计划任务轮次内生效。 */
  requestQuiet(sessionId: string | undefined): QuietCompletionResult {
    const turn = sessionId === undefined ? undefined : this.turns.get(sessionId)
    if (turn === undefined || !turn.scheduled) {
      return {
        suppressed: false,
        note: 'This run was not started by a scheduled task; the completion notification will be sent as usual.',
      }
    }
    turn.quiet = true
    return { suppressed: true }
  }

  /**
   * turn.end 时调用并清空本轮状态。返回 true 表示本轮完成通知应被抑制：
   * 只有成功结束、计划任务轮次、且 Agent 请求了静默三者同时成立。
   */
  consumeTurnEnd(sessionId: string, ok: boolean): boolean {
    const turn = this.turns.get(sessionId)
    this.turns.delete(sessionId)
    return ok && turn?.scheduled === true && turn.quiet
  }
}

/** 宿主 `ctx.tools` 的最小形状；插件不依赖 dsh-tools 包，按其原始定义契约手写。 */
export interface ToolsServiceLike {
  register(definition: unknown, options?: { when?: (context: { agent?: { sessionId?: string } }) => boolean }): () => void
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
    async execute(args: unknown, exec: { agent?: { sessionId?: string } }): Promise<QuietCompletionResult> {
      const sessionId = exec.agent?.sessionId
      const reason = normalizeReason((args as { reason?: unknown } | undefined)?.reason)
      const result = tracker.requestQuiet(sessionId)
      log(`quiet completion requested session=${sessionId ?? '?'} suppressed=${result.suppressed} reasonChars=${reason.length}`)
      return result
    },
  }
}

/** 注册工具；`when` 让普通会话看不到它。返回宿主给的注销函数。 */
export function registerQuietCompletionTool(
  tools: ToolsServiceLike,
  tracker: QuietCompletionTracker,
  log?: (message: string) => void,
): () => void {
  return tools.register(quietCompletionTool(tracker, log), {
    when: (context) => {
      const sessionId = context.agent?.sessionId
      return sessionId !== undefined && tracker.isScheduleSession(sessionId)
    },
  })
}
