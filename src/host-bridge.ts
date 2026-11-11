import {
  openDispatchJournal,
  promptDeliveryCodec,
  scheduleMutationCodec,
  type DeliveryReceipt,
  type MutationDispatchResult,
} from './dispatch-journal.ts'
import { randomUUID } from 'node:crypto'
import { notificationPlainText } from './notification-text.ts'
import { GoalProjectionTracker } from './goal-projection.ts'
import type { Envelope, MessageProjection, NotifyCategory, PendingSnapshotPayload, PushNotification, SessionEventKind, SessionSummary, SessionTodoItem, SessionTodoStatus, SessionQueueItem, SessionUsageStats, WelcomeCapabilities } from './protocol.ts'
import {
  isSubagentRow,
  unwrapStreamItem,
} from './host-api.ts'
import type {
  ApiProxyLike,
  BridgeSink,
  DirectoryListingLike,
  HostModelSelection,
  HostScheduleApiLike,
  HostScheduleCreateRequestLike,
  HostScheduleListRequestLike,
  HostScheduleListResultLike,
  HostScheduleTaskView,
  HostSessionModels,
  PendingResponseOutcome,
  PhoneSessionRow,
  PromptArgs,
  PushOutlet,
  ScheduleHistoryViewLike,
  ScheduleTaskViewLike,
  SessionEventLike,
  SessionManagementResult,
  ModelBridgeResult,
  MuxFrameLike,
  WorkspaceViewLike,
} from './host-api.ts'
import type { HostSchedulePatch, HostScheduleTargetRequest, HostScheduleTiming } from './protocol.ts'
export * from './host-api.ts'
import {
  MAX_MESSAGE_PROJECTION_BYTES,
  MAX_SESSION_PAGE_MESSAGES_BYTES,
  DEFAULT_HISTORY_PAGE_MESSAGES,
  MAX_HISTORY_PAGE_MESSAGES,
  MIN_TAIL_MESSAGES,
  canonicalSessionMessages,
  formatLlmFailure,
  limitMessageProjection,
  limitSessionPageMessages,
  messageText,
  projectEvent,
  projectHistory,
  retryActivityText,
  turnEndFailureText,
  userMessageSourceKind,
} from './host-event-projection.ts'
import { QuietCompletionTracker } from './quiet-completion.ts'
import { documentPromptBlock, type PromptDocument } from './document-payload.ts'
import type { DispatchJournal } from './dispatch-journal.ts'
import { pushScopeFor } from './connection-policy.ts'
import { capabilityBits } from './host-capabilities.ts'
import { projectQueue, promptRequestId } from './prompt-queue.ts'
import { hostFailureOf, wireCodeFor, wireErrorOf, type WireErrorCode } from './wire-errors.ts'
import { formatLogLine } from './diagnostics.ts'
import { AssistantStream, type AssistantStreamDelta } from './assistant-stream.ts'
import { ImageRefIndex } from './image-ref-index.ts'

export {
  MAX_MESSAGE_PROJECTION_BYTES,
  MAX_SESSION_PAGE_MESSAGES_BYTES,
  canonicalSessionMessages,
  formatLlmFailure,
  limitMessageProjection,
  limitSessionPageMessages,
  projectEvent,
  projectHistory,
  retryActivityText,
  turnEndFailureText,
} from './host-event-projection.ts'

interface PendingApproval {
  rpcId: string
  sessionId: string
  toolName: string
  reason: string
  toolArguments?: string
}

interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: unknown
}

/**
 * 失败结果直接携带 wire 错误码（error vocabulary 见 wire-errors.ts）。
 *
 * 迁移前这里有 kind 中间层（'not-found' | 'busy' | 'conflict' | 'invalid'…），
 * 由 5 个映射函数在「Host code ↔ kind ↔ E_*」之间来回翻译，其中
 * E_BUSY→conflict→E_BUSY 的往返已证明有损。现在每个域查一次表，调用方拿到的
 * 就是手机上会看到的错误码。
 */
export type ScheduleBridgeResult<T> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; code: WireErrorCode; message: string; replayed?: boolean }

/**
 * 宿主级编辑（update / delete 合一的 `edit`）的 Bridge 结果值。
 *
 * 与 legacy 的 updated/deleted 两个独立帧结果分开表达，wire handler 用
 * `'deleted' in value` 落成 `deleted:true` 或 `task`。
 */
export type HostScheduleEditValue =
  | { task: HostScheduleTaskView }
  | { deleted: true; id: string }

const MAX_RING_DEFAULT = 2000;
/** 补发量超过它就改发 s2c.resync（经 Funnel 实测吞吐 40～80 KB/s，约 6～12 秒）。 */
export const REPLAY_RESYNC_BYTES = 512 * 1024;
/** 只改了用量统计的列表推送，同一会话这段时间内最多推一次（第二批 P5）。 */
export const SUMMARY_STATS_THROTTLE_MS = 5000;

/**
 * Process-wide bridge state: session mirror, pending approvals/questions,
 * and the per-device replay ring. Consumes the in-process mux/host streams
 * and fans projected pushes out to every registered sink.
 */
let BRIDGE_SEQ = 0;

export class HostBridge {
  readonly id = ++BRIDGE_SEQ;
  private summaries = new Map<string, SessionSummary>()
  private readonly goals = new GoalProjectionTracker()
  /**
   * 列表推送节流（连接传输第二批 P5）。每个会话最近一次推出去的摘要指纹，
   * 用来丢掉内容完全相同的重复推送；只改了 `stats` 的变化按 SUMMARY_STATS_THROTTLE_MS
   * 合并，状态、标题、任务清单、待处理标记、活动描述的变化照旧立即推。
   */
  private readonly summaryPushed = new Map<string, { full: string; withoutStats: string; at: number }>()
  private readonly summaryStatsTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private activeTools = new Map<string, Map<string, string>>()
  /** 会话在 llm/retry 退避等待期间的重试描述；新一轮、重试启动或新消息/工具到达时清除。 */
  private retryActivities = new Map<string, string>()
  /** 最近一轮以非 completed 异常结束的会话；保持 status='error' 直到下一轮开始，防止随后的 running=false 覆盖回 idle。 */
  private failedSessionIds = new Set<string>()
  private approvals = new Map<string, PendingApproval>()
  private questions = new Map<string, PendingQuestion>()
  private archivedSessionIds = new Set<string>()
  /** Mirrors archived rows from the last sessions.list so the phone can browse
   * and restore them. Excluded from `summaries` and from the live broadcast. */
  private archivedSummaries = new Map<string, SessionSummary>()
  private subagentSessionIds = new Set<string>()
  /** 计划任务按需完成通知（quiet-completion.ts）：index.ts 用它注册 Agent 工具。 */
  readonly quietCompletion = new QuietCompletionTracker()
  /**
   * 每个会话最近一次已知的队列（inbox 投影的折叠结果）及其指纹。来源是实时
   * 投影通知或打开会话时读到的基线；指纹用来丢掉内容没变的重复通知。
   */
  private queues = new Map<string, { items: SessionQueueItem[]; fingerprint: string }>()
  private sinks = new Set<BridgeSink>()
  private readonly assistantStream = new AssistantStream(
    payload => this.pushAssistantDelta(payload),
    sessionId => this.hasStreamViewer(sessionId),
  )
  private ring: Array<{ seq: number; type: string; payload: unknown }> = []
  private cursor = 0;
  private userReceiptSeq = 0;
  private abort = new AbortController();
  private started = false
  private disposed = false
  /** attachmentId → 宿主完整图片引用，供 attachmentData 补全 DSH 0.2.2+ 的读图参数。 */
  private readonly imageRefs = new ImageRefIndex()

  readonly promptDeliveries: DispatchJournal<{ sessionId: string; content: unknown }, DeliveryReceipt>
  readonly scheduleMutations: DispatchJournal<unknown, MutationDispatchResult<unknown>>
  readonly forkMutations: DispatchJournal<unknown, MutationDispatchResult<unknown>>

  constructor(
    private readonly apiProxy: ApiProxyLike,
    private readonly historyBufferMax: number = MAX_RING_DEFAULT,
    deliveryJournalPath?: string,
    scheduleJournalPath?: string,
    forkJournalPath?: string,
    /** 三个 journal 的落盘失败诊断输出；缺省即静默。不打任何消息体。 */
    private readonly log?: (message: string) => void,
  ) {
    // 三个实例是同一个 module 的三次配置：条目方言由 codec 决定（prompt 回执 /
    // schedule 结果 / fork 结果带持久化 value），落盘路径各自独立、互不影响。
    // log 必须在**首次**构造时就带上：openDispatchJournal 是按 path+codec 身份
    // 缓存的单例，事后补传不会生效。
    this.promptDeliveries = openDispatchJournal({
      path: deliveryJournalPath,
      codec: promptDeliveryCodec,
      joinInFlight: true,
      maxFileBytes: 8 * 1024 * 1024,
      log: this.log,
    })
    this.scheduleMutations = openDispatchJournal({
      path: scheduleJournalPath,
      codec: scheduleMutationCodec(false),
      joinInFlight: false,
      maxFileBytes: 4 * 1024 * 1024,
      log: this.log,
    })
    this.forkMutations = openDispatchJournal({
      path: forkJournalPath,
      codec: scheduleMutationCodec(true),
      joinInFlight: false,
      maxFileBytes: 4 * 1024 * 1024,
      log: this.log,
    })
  }

  private pushOutlet: PushOutlet | undefined;
  private widgetFingerprint = ''

  /**
   * Wire the offline-push fan-out. Present ⇒ welcome advertises the `push`
   * capability and notify-worthy events are mirrored to APNs.
   */
  setPushOutlet(outlet: PushOutlet | undefined): void {
    this.pushOutlet = outlet;
  }

  /**
   * welcome 能力位。委托 host-capabilities.ts 的探测表：此前同一条事实在这里
   * 和各方法体内各存一份，已经漂移过两次（models 位过严、schedules 位与
   * schedule 方法的探测不同源）。
   */
  get capabilities(): WelcomeCapabilities {
    return capabilityBits(this.apiProxy, this.pushOutlet)
  }

  diagnostic(message: string): void {
    console.log(formatLogLine('info', message));
  }

  currentCursor(): number {
    return this.cursor;
  }

  // ---------- sinks ----------

  addSink(sink: BridgeSink): void {
    this.sinks.add(sink);
  }

  removeSink(sink: BridgeSink): void {
    this.sinks.delete(sink);
    this.dropSinkSessions(sink);
  }

  /** Whether the ring still holds everything after the cursor. */
  canResumeFrom(cursor: number): boolean {
    const oldest = this.ring.length > 0 ? this.ring[0]!.seq : this.cursor + 1;
    // A cursor ahead of this process belongs to an older bridge lifetime.
    // Treat it as a gap instead of incorrectly claiming a successful resume.
    return cursor <= this.cursor && cursor + 1 >= oldest;
  }

  private sinkSessions = new Map<BridgeSink, Set<string>>();
  private lastAssistantText = new Map<string, string>();

  /** Mark a sink as actively viewing a session (suppresses its turn notifications). */
  markSinkOpen(sink: BridgeSink, sessionId: string): void {
    let set = this.sinkSessions.get(sink);
    if (!set) { set = new Set(); this.sinkSessions.set(sink, set); }
    set.add(sessionId);
  }

  markSinkClosed(sink: BridgeSink, sessionId: string): void {
    this.sinkSessions.get(sink)?.delete(sessionId);
    if (!this.hasStreamViewer(sessionId)) this.assistantStream.clearPending(sessionId);
  }

  dropSinkSessions(sink: BridgeSink): void {
    const sessions = this.sinkSessions.get(sink);
    this.sinkSessions.delete(sink);
    for (const sessionId of sessions ?? []) {
      if (!this.hasStreamViewer(sessionId)) this.assistantStream.clearPending(sessionId);
    }
  }

  private hasStreamViewer(sessionId: string): boolean {
    if (this.disposed || this.subagentSessionIds.has(sessionId)) return false;
    return [...this.sinks].some(sink => this.isViewedBy(sink, sessionId) && sink.canReceive('sessions.read'));
  }

  /** Instant publications bypass record(): no cursor, ring, notification or push side effect. */
  private pushAssistantDelta(payload: AssistantStreamDelta): void {
    if (this.disposed || this.subagentSessionIds.has(payload.sessionId)) return;
    for (const sink of this.sinks) {
      if (this.isViewedBy(sink, payload.sessionId) && sink.canReceive('sessions.read')) {
        sink.push('s2c.session.delta', payload);
      }
    }
  }

  private isViewedBy(sink: BridgeSink, sessionId: string): boolean {
    return this.sinkSessions.get(sink)?.has(sessionId) ?? false;
  }

  /** F-9: when a notification-worthy event fires, mirror it to every
   *  online device that is not currently viewing the session (the s2c.notify
   *  frame counts toward the seq cursor and joins the replay ring per
   *  PROTOCOL §6 + §7), then fan the same payload out to offline devices
   *  holding an APNs token. */
  private emitNotify(args: {
    sessionId: string
    category: NotifyCategory
    title: string
    /** Host 原文（可能是 Markdown），出站前在这里统一转纯文本。 */
    body: string
    /** body 清洗后为空（如回复只有代码块）时改用的纯文本，例如会话标题。 */
    fallbackBody?: string
    notificationId: string
    toolName?: string
    detail?: string
  }): void {
    const turnEnd = args.category === 'turn.completed' || args.category === 'session.error';
    if (turnEnd && this.subagentSessionIds.has(args.sessionId)) return;
    // 回合结束取回复最后一段（通常是结论）；审批原因与提问原文合成一行。
    const plain = notificationPlainText(args.body, turnEnd ? 'last' : 'all') || (args.fallbackBody ?? '');
    const body = plain.length > 120 ? plain.slice(0, 119) + '…' : plain;
    // 展开页所需的工具名与详情只随审批通知下发；正文 120 字的上限不动，详情另有 600 字上限。
    const approvalExtras = args.category === 'approval.required' && args.toolName
      ? { toolName: args.toolName.slice(0, 80), ...(args.detail ? { detail: args.detail.slice(0, 600) } : {}) }
      : {};
    this.record(
      's2c.notify',
      {
        notificationId: args.notificationId,
        category: args.category,
        sessionId: args.sessionId,
        title: args.title,
        body,
        ...approvalExtras,
        ts: Date.now(),
      },
      // Background clients can keep their session subscription during the socket
      // grace period; deliver goals to all sinks so their local foreground policy decides.
      args.category === 'goal.completed' ? undefined : (sink) => this.isViewedBy(sink, args.sessionId),
    );
    this.fanOutPush({
      notificationId: args.notificationId,
      category: args.category,
      sessionId: args.sessionId,
      title: args.title,
      body,
      ...approvalExtras,
    });
  }

  /** F-9: when a turn completes, notify every device not viewing the session. */
  private emitTurnCompletedNotify(sessionId: string, ok: boolean, errorText?: string): void {
    if (this.subagentSessionIds.has(sessionId)) return;

    const row = this.summaries.get(sessionId);
    // A goal spans turns. Its completion has one separate durable transition;
    // failures remain actionable even while a goal is unfinished.
    if (ok && this.goals.inGoalTurn(sessionId)) return;
    const title = ok ? '任务完成' : '任务异常结束';
    // 异常结束时优先携带本轮错误原因，避免拿上一轮旧回复或空串充数。
    const body = (!ok && errorText)
      ? errorText
      : (this.lastAssistantText.get(sessionId) ?? '');
    this.emitNotify({
      sessionId,
      category: ok ? 'turn.completed' : 'session.error',
      title,
      body,
      fallbackBody: row?.title ?? '',
      notificationId: 'n-' + (this.cursor + 1),
    });
  }

  /**
   * Mirror one notification-worthy event to offline devices. Fire-and-forget:
   * push failures must never block or break the WS data plane.
   */
  private fanOutPush(notification: PushNotification): void {
    try {
      this.pushOutlet?.fanOut(notification);
    } catch {
      // outlet misbehavior must not take down the bridge
    }
  }


  /**
   * Remember the latest assistant text so notifications can quote it. 存完整原文：
   * 按字符数截尾会从链接地址中间切开（横幅只剩 URL 编码的路径），段落选择与
   * Markdown 清洗统一留到 emitNotify。条目随 sessions.list / 归档清理。
   */
  private captureAssistantText(sessionId: string, event: SessionEventLike): void {
    if (event.type !== 'assistant/message') return;
    const text = messageText(event.data).trim();
    if (text.length > 0) this.lastAssistantText.set(sessionId, text);
  }

  /**
   * Replay buffered pushes after the given cursor; false when the gap is
   * unrecoverable. Frames go to `target` only — replaying into every sink
   * duplicated the whole window onto devices that never asked for it.
   * Each frame is filtered by the S→C permission policy per sink, so a
   * reader without interactions.respond never gets the missed approval
   * frames back (R1/P2).
   */
  /**
   * 按序补发游标之后的帧。先按权限与关注集合筛出该 sink 真正会收到的帧，
   * 估算字节数超过 REPLAY_RESYNC_BYTES 时改发 `s2c.resync`：补发是同步一次性
   * 写出的，经 Funnel 时插件这侧看不到积压，大补发会把之后所有请求响应堵在
   * 链路上（实测 450 帧堵 37 秒）。重新同步让客户端只拉列表和正在看的会话。
   */
  resumeFrom(cursor: number, target?: BridgeSink): boolean {
    const oldest = this.ring.length > 0 ? this.ring[0]!.seq : this.cursor + 1;
    if (cursor + 1 < oldest) return false;
    const receivers = target !== undefined ? [target] : [...this.sinks];
    for (const sink of receivers) {
      const window: Array<{ seq: number; type: string; payload: unknown }> = []
      let bytes = 0
      for (const entry of this.ring) {
        if (entry.seq <= cursor) continue
        const need = pushScopeFor(entry.type, entry.payload)
        if (need === undefined || !sink.canReceive(need)) continue
        if (sink.accepts && !sink.accepts(entry.type, entry.payload)) continue
        window.push(entry)
        bytes += Buffer.byteLength(JSON.stringify(entry.payload) ?? '')
      }
      if (bytes > REPLAY_RESYNC_BYTES) {
        this.log?.(`resume window ${bytes}B over ${REPLAY_RESYNC_BYTES}B; sending resync`)
        sink.resync()
        continue
      }
      for (const entry of window) sink.replay([entry]);
      sink.replayDone();
    }
    return true;
  }

  refreshLiveActivities(): void {
    try { this.pushOutlet?.liveActivityChanged?.(this.listSessions()) } catch { /* independent delivery */ }
  }

  private record(type: string, payload: unknown, except?: (sink: BridgeSink) => boolean): void {
    if (this.disposed) return
    if (type === 's2c.sessions.delta') this.refreshLiveActivities()
    if (type === 's2c.sessions.delta' || type.startsWith('s2c.pending.')) {
      const fingerprint = JSON.stringify([
        this.listSessions().map(({ id, title, status, lastActivityTs, todos, todoItems, pendingApproval, pendingQuestion }) =>
          ({ id, title, status, lastActivityTs, todos, todoItems, pendingApproval, pendingQuestion })),
        this.approvals.size, this.questions.size,
      ])
      if (fingerprint !== this.widgetFingerprint) {
        this.widgetFingerprint = fingerprint
        try { this.pushOutlet?.widgetChanged?.() } catch { /* push cannot break the data plane */ }
      }
    }
    this.cursor += 1;
    const entry = { seq: this.cursor, type, payload };
    this.ring.push(entry);
    if (this.ring.length > this.historyBufferMax) {
      this.ring.splice(0, this.ring.length - this.historyBufferMax);
    }
    const need = pushScopeFor(type, payload)
    for (const sink of this.sinks) {
      if (need === undefined || !sink.canReceive(need)) continue
      if (except && except(sink)) continue
      sink.push(type, payload, entry.seq);
    }
  }


  // ---------- lifecycle ----------

  /** Start consuming host + mux streams. Idempotent; aborts on dispose(). */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    void this.runHostStream();
    void this.runMuxStream();
    void this.refreshSummaries();
  }

  /**
   * 用宿主任务列表里的投递目标会话预热计划任务会话集合，避免插件重启后工具
   * 先消失、等下一次投递再出现（每次变化都会给会话追加工具增减消息）。
   * `new` 目标没有固定会话，只能从最近一次投递回执里取。失败只记日志：集合仍会
   * 在下一次投递时补上。由 index.ts 在 schedule 服务就绪、注册工具时调用。
   */
  async seedQuietCompletionSessions(): Promise<void> {
    if (this.hostSchedule === undefined) return
    const sessionIds: string[] = []
    let offset = 0
    for (;;) {
      const result = await this.listHostSchedules({ limit: HOST_SCHEDULE_PAGE_SIZE, offset })
      if (!result.ok) {
        this.log?.(`quiet completion seed skipped: ${result.code}`)
        return
      }
      for (const task of result.value.tasks) {
        if (task.target.kind !== 'new') sessionIds.push(task.target.sessionId)
        if (task.lastDelivery) sessionIds.push(task.lastDelivery.targetSessionId)
      }
      offset += result.value.tasks.length
      if (result.value.tasks.length === 0 || offset >= result.value.total) break
    }
    if (this.disposed) return
    this.quietCompletion.seed(sessionIds)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort();
    for (const timer of this.summaryStatsTimers.values()) clearTimeout(timer)
    this.summaryStatsTimers.clear()
    this.assistantStream.dispose();
    this.sinks.clear();
    this.sinkSessions.clear();
    this.pushOutlet = undefined;
  }

  private async runHostStream(): Promise<void> {
    try {
      for await (const item of this.apiProxy.events.host({ rpcId: randomUUID() }, this.abort.signal)) {
        const frame = unwrapStreamItem(item);
        this.onHostFrame(frame);
      }
    } catch {
      // stream ended (dispose or host shutdown); bridges degrade to RPC-only
    }
  }

  private async runMuxStream(): Promise<void> {
    try {
      for await (const item of this.apiProxy.events.mux({ rpcId: randomUUID() }, this.abort.signal)) {
        const frame = unwrapStreamItem(item);
        this.onMuxFrame(frame);
      }
    } catch {
      // ditto
    } finally {
      this.assistantStream.dispose();
    }
  }

  private onHostFrame(frame: MuxFrameLike): void {
    switch (frame.type) {
      case 'host/session-added':
      case 'host/session-removed':
      case 'host/workspace-changed':
      case 'host/workspace-removed':
      case 'host/workspace-order-changed':
        void this.refreshSummaries();
        break;
      case 'host/archived-sessions-changed': {
        const archived = (frame as { archivedSessionIds?: unknown }).archivedSessionIds
        if (Array.isArray(archived)) {
          this.archivedSessionIds = new Set(archived.map(String))
        }
        void this.refreshSummaries();
        break;
      }
      case 'host/schedule-changed':
        this.record('s2c.schedule.changed', {})
        break
      case 'host/session-status': {
        const p = frame as { sessionId?: string; running?: boolean };
        const id = String(p.sessionId);
        if (p?.running === true) this.failedSessionIds.delete(id);
        const row = this.summaries.get(id);
        if (row && typeof p?.running === 'boolean') {
          row.status = p.running ? 'running' : (this.failedSessionIds.has(id) ? 'error' : 'idle');
          this.pushSummary(row);
        }
        break;
      }
      default:
        break;
    }
  }

  private onMuxFrame(frame: MuxFrameLike): void {
    switch (frame.type) {
      case 'skills/changed':
        this.record('s2c.skills.changed', {})
        break;
      case 'commands/changed':
        this.record('s2c.commands.changed', {})
        break;
      case 'session/assistant-stream': {
        const sessionId = String(frame.sessionId ?? '');
        if (frame.isSubagent === true) this.subagentSessionIds.add(sessionId);
        if (this.subagentSessionIds.has(sessionId)) {
          this.assistantStream.abandon(sessionId);
          break;
        }
        this.assistantStream.accept(sessionId, frame.value);
        break;
      }
      case 'session/assistant-stream-disposed':
        this.assistantStream.abandon(String(frame.sessionId ?? ''));
        break;
      case 'session/event': {
        const event = frame.event as SessionEventLike | undefined;
        const sessionId = String(frame.sessionId ?? '');
        if (!event || !sessionId) break;
        if (frame.isSubagent === true) this.subagentSessionIds.add(sessionId);
        if (this.subagentSessionIds.has(sessionId)) {
          this.assistantStream.abandon(sessionId);
          break;
        }
        const streamId = this.assistantStream.beforeEvent(sessionId, event);
        if (event.type === 'turn/end') this.assistantStream.abandon(sessionId);
        if (event.type === 'agent-preset/selected') {
          this.record('s2c.skills.changed', { sessionId });
        }
        if (event.type === 'turn/start') {
          // 新一轮开始时清除上一轮残留的回复文本与异常标记，防止本轮未生成新回复就报错时误引旧文本。
          this.lastAssistantText.delete(sessionId);
          this.failedSessionIds.delete(sessionId);
          const row = this.summaries.get(sessionId);
          this.goals.turnStarted(sessionId);
          if (row && row.status === 'error') row.status = 'running';
        }
        const projection = projectEvent(sessionId, event);
        if (projection?.kind === 'turn.end') {
          const ok = projection.data.ok === true;
          const row = this.summaries.get(sessionId);
          if (ok) {
            this.failedSessionIds.delete(sessionId);
            if (row && row.status === 'error') row.status = 'idle';
          } else {
            this.failedSessionIds.add(sessionId);
            if (row) row.status = 'error';
          }
        }
        this.noteActivity(sessionId, event);
        if (event.type === 'user/message') {
          this.quietCompletion.noteUserMessage(sessionId, userMessageSourceKind(event.data), event.seq);
        }
        this.captureAssistantText(sessionId, event);
        this.imageRefs.remember(sessionId, [event]);
        this.captureActivity(sessionId, event, projection?.data.tool as { name?: string; summary?: string } | undefined);
        if (projection) {
          this.record('s2c.session.event', { sessionId, kind: projection.kind, seq: event.seq,
            data: { ...projection.data, ...(streamId && projection.kind === 'message.final' ? { streamId } : {}) } });
        }
        if (projection?.kind === 'turn.end') {
          const ok = projection.data.ok === true;
          const errorText = typeof projection.data.text === 'string' ? projection.data.text : undefined;
          // 计划任务轮次中 Agent 请求了静默：turn.end 本身照常记录，只跳过完成通知。
          const turn = (event.data as { turn?: unknown } | undefined)?.turn;
          if (this.quietCompletion.consumeTurnEnd(sessionId, ok, typeof turn === 'number' ? turn : undefined, event.seq)) {
            this.log?.(`completion notice skipped by scheduled run session=${sessionId}`);
          } else {
            this.emitTurnCompletedNotify(sessionId, ok, errorText);
          }
          this.goals.turnEnded(sessionId);
        }
        break;
      }
      case 'goal/activation-changed': {
        const sessionId = String(frame.sessionId ?? '');
        if (this.goals.activate(sessionId, frame.value)) {
          const row = this.summaries.get(sessionId);
          if (row) { row.goal = this.goals.get(sessionId); this.pushSummary(row); }
        }
        break;
      }
      case 'session/projection': {
        const p = frame as { sessionId?: string; key?: string; value?: unknown; seq?: number };
        if (!p.sessionId) break;
        if (p.key === 'workingDirectory' || p.key === 'agentPreset') {
          this.record('s2c.skills.changed', { sessionId: p.sessionId });
        }
        // 当前权限档位只在 `permissions` 投影里；其他客户端（Web、另一台手机）改了档位，
        // 手机输入框的权限胶囊要重拉 `c2s.session.permissions`，复用命令/权限目录的失效推送。
        if (p.key === 'permissions') {
          this.record('s2c.commands.changed', { sessionId: p.sessionId });
        }
        if (p.key === 'modelSelection') {
          const next = (p.value as { next?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined)?.next
          const current = next && typeof next.provider === 'string' && typeof next.model === 'string'
            ? { provider: next.provider, model: next.model, ...(typeof next.reasoningEffort === 'string' ? { reasoningEffort: next.reasoningEffort } : {}) }
            : undefined
          // 当前选择来自实时投影；目录缓存不能让其他客户端的模型切换长期滞留。
          this.record('s2c.models.changed', { sessionId: p.sessionId, ...(current ? { current } : {}) });
        }
        if (p.key === 'inbox') this.applyInbox(p.sessionId, p.value, 'live');
        this.applyProjection(p.sessionId, String(p.key ?? ''), p.value, 'live', p.seq);
        break;
      }
      case 'approval/requested': {
        const p = frame as { sessionId?: string; approvalId?: string; toolName?: string; reason?: string; callId?: string };
        if (!p.approvalId || !frame.rpcId) break;
        const toolName = String(p.toolName ?? 'tool');
        const summary = String(p.reason ?? '');
        const sessionId = String(p.sessionId ?? '');
        this.approvals.set(p.approvalId, {
          rpcId: frame.rpcId,
          sessionId,
          toolName,
          reason: summary,
        });
        this.record('s2c.pending.approval', {
          requestId: p.approvalId,
          sessionId,
          toolName,
          summary,
          riskLevel: riskOf(toolName),
        });
        if (p.callId) void this.loadApprovalArguments(p.approvalId, p.callId);
        this.emitNotify({
          sessionId,
          category: 'approval.required',
          title: '需要批准',
          body: toolName + ': ' + summary,
          notificationId: 'apr-' + p.approvalId,
          toolName,
          detail: summary,
        });
        this.bumpPendingFlags(sessionId);
        break;
      }
      case 'approval/resolved': {
        const p = frame as { approvalId?: string };
        if (!p.approvalId) break;
        const pending = this.approvals.get(p.approvalId);
        this.approvals.delete(p.approvalId);
        this.record('s2c.pending.cleared', { requestId: p.approvalId });
        if (pending) this.bumpPendingFlags(pending.sessionId);
        break;
      }
      case 'question/requested': {
        const p = frame as { sessionId?: string; questions?: unknown };
        if (!frame.rpcId) break;
        const requestId = 'q-' + frame.rpcId;
        const sessionId = String(p?.sessionId ?? '');
        this.questions.set(requestId, { rpcId: frame.rpcId, sessionId, questions: p?.questions });
        this.record('s2c.pending.question', { requestId, sessionId, questions: p?.questions ?? [] });
        this.emitNotify({
          sessionId,
          category: 'question.asked',
          title: '有问题需要回答',
          body: firstQuestionText(p?.questions),
          notificationId: requestId,
        });
        this.bumpPendingFlags(sessionId);
        break;
      }
      case 'question/resolved': {
        const p = frame as { questionRpcId?: string };
        if (!p.questionRpcId) break;
        const requestId = 'q-' + p.questionRpcId;
        const pending = this.questions.get(requestId);
        this.questions.delete(requestId);
        this.record('s2c.pending.cleared', { requestId });
        if (pending) this.bumpPendingFlags(pending.sessionId);
        break;
      }
      default:
        break;
    }
  }


  // ---------- session mirror ----------

  async refreshSummaries(): Promise<void> {
    try {
      const response = await this.apiProxy.sessions.list({ rpcId: randomUUID(), payload: {} });
      if (!response.result || !response.result.ok) {
        this.diagnostic('sessions.list rejected: ' + JSON.stringify(response.result ?? null).slice(0, 200));
        return;
      }
      let workspaces: WorkspaceViewLike[] = []
      const workspaceList = this.apiProxy.workspace?.list
      if (typeof workspaceList === 'function') {
        const workspaceResponse = await workspaceList.call(this.apiProxy.workspace, {
          rpcId: randomUUID(),
          payload: {},
        })
        if (workspaceResponse.result?.ok) {
          workspaces = workspaceResponse.result.value.items ?? []
          this.archivedSessionIds = new Set(
            (workspaceResponse.result.value.archivedSessionIds ?? []).map(String),
          )
        }
      }
      const previousIds = new Set(this.summaries.keys())
      const workspaceBySession = new Map<string, WorkspaceViewLike>()
      for (const workspace of workspaces) {
        for (const sessionId of workspace.sessionIds ?? []) {
          workspaceBySession.set(String(sessionId), workspace)
        }
      }
      const next = new Map<string, SessionSummary>();
      // Archived sessions stay out of the live list and its broadcast so
      // existing clients keep their current behaviour; they are mirrored here
      // and served on demand through c2s.sessions.archived.
      const nextArchived = new Map<string, SessionSummary>();
      for (const row of response.result.value.items ?? []) {
        if (isSubagentRow(row)) this.subagentSessionIds.add(row.sessionId);
        if (this.subagentSessionIds.has(row.sessionId)) continue
        if (row.running) this.failedSessionIds.delete(row.sessionId);
        const summary = toSummary(row, this.approvals, this.questions, workspaceBySession.get(row.sessionId));
        this.goals.apply(row.sessionId, row.projections?.values?.goal, 'baseline', row.projections?.asOfSeq);
        const goal = this.goals.get(row.sessionId);
        if (goal !== undefined) summary.goal = goal;
        if (!row.running && this.failedSessionIds.has(row.sessionId)) {
          summary.status = 'error';
        }
        if (this.archivedSessionIds.has(row.sessionId)) {
          nextArchived.set(row.sessionId, { ...summary, archived: true });
          continue
        }
        next.set(row.sessionId, summary);
      }
      for (const [id, calls] of this.activeTools) {
        const row = next.get(id);
        if (!row || (row.status !== 'running' && !row.pendingApproval && !row.pendingQuestion)) this.activeTools.delete(id);
        else row.activity = [...calls.values()].at(-1) ?? null;
      }
      for (const [id, retryText] of this.retryActivities) {
        const row = next.get(id);
        if (!row || (row.status !== 'running' && !row.pendingApproval && !row.pendingQuestion)) this.retryActivities.delete(id);
        else row.activity = retryText;
      }
      // Worker identity is immutable for this bridge lifetime. A stale list or
      // a removed worker must not erase identity learned from the event stream.
      this.summaries = next;
      this.archivedSummaries = nextArchived;
      const removedIds = [...previousIds].filter((id) => !next.has(id))
      // sessions.list is authoritative. This also removes assistant snippets
      // captured for child/subagent event streams that never enter summaries.
      for (const id of this.lastAssistantText.keys()) {
        if (!next.has(id)) this.lastAssistantText.delete(id)
      }
      for (const id of removedIds) {
        this.goals.forget(id)
        this.failedSessionIds.delete(id)
        this.retryActivities.delete(id)
      }
      // 全量列表推送同样记账，之后的单行推送才能按它去重、节流。
      for (const id of removedIds) this.forgetSummaryPush(id)
      for (const row of next.values()) this.noteSummaryPushed(row)
      this.record('s2c.sessions.delta', { upserted: [...next.values()], removedIds });
    } catch {
      // apiProxy absent or transient failure; keep last mirror
    }
  }

  /** Cold sessions may lack a title projection; fall back to first user text. */
  private deriveTitleFallback(sessionId: string, messages: MessageProjection[]): void {
    const row = this.summaries.get(sessionId);
    if (!row || row.title.length > 0) return;
    const firstUser = messages.find(m => m.role === 'user' && (m.text ?? '').trim().length > 0);
    if (!firstUser) return;
    row.title = firstUser!.text!.replace(/\s+/g, ' ').trim().slice(0, 60);
    this.pushSummary(row);
  }

  private captureActivity(sessionId: string, event: SessionEventLike, tool?: { name?: string; summary?: string }): void {
    const row = this.summaries.get(sessionId);
    if (!row) return;
    const data = event.data as { callId?: string } | undefined;
    if (event.type === 'llm/retry') {
      const retryText = retryActivityText(event.data);
      if (!retryText) return;
      this.retryActivities.set(sessionId, retryText);
    } else if (
      event.type === 'llm/retry-started' ||
      event.type === 'assistant/chunk' ||
      event.type === 'assistant/message' ||
      event.type === 'step/end'
    ) {
      if (!this.retryActivities.delete(sessionId)) return;
    } else if (event.type === 'tool/call' && data?.callId) {
      this.retryActivities.delete(sessionId);
      const calls = this.activeTools.get(sessionId) ?? new Map<string, string>();
      const detail = [tool?.name, tool?.summary].filter(Boolean).join(': ');
      calls.set(data.callId, Array.from(detail).slice(0, 160).join(''));
      if (calls.size > 64) calls.delete(calls.keys().next().value!);
      this.activeTools.set(sessionId, calls);
    } else if (event.type === 'tool/result' && data?.callId) {
      this.activeTools.get(sessionId)?.delete(data.callId);
    } else if (event.type === 'turn/start' || event.type === 'turn/end') {
      this.retryActivities.delete(sessionId);
      this.activeTools.delete(sessionId);
    } else return;
    const activity = this.retryActivities.get(sessionId)
      ?? [...(this.activeTools.get(sessionId)?.values() ?? [])].at(-1)
      ?? null;
    if (row.activity === activity) return;
    row.activity = activity;
    // Tool progress must not reorder the session list or trigger Widget pushes.
    this.pushSummary(row);
  }

  private noteActivity(sessionId: string, event?: SessionEventLike): void {
    const row = this.summaries.get(sessionId);
    if (!row) return;
    // Recency must reflect USER-VISIBLE milestones only: a new prompt moves
    // a session to the top and a finished turn settles it into place. Token
    // chunks / tool calls / per-step assistant messages fire constantly while
    // an agent works; counting them made concurrently running sessions fight
    // over the top slot in every recency-sorted list.
    switch (event?.type) {
      case 'user/message':
      case 'turn/start':
      case 'turn/end':
        break;
      default:
        return;
    }
    row.lastActivityTs = Date.now();
    this.pushSummary(row);
  }

  /**
   * 折叠一次 inbox 投影。只有实时变化才广播 s2c.session.queue；基线只补缓存，
   * 打开会话的那台设备另由 pushQueueSnapshot 点对点拿到快照。
   *
   * 基线只补缺不覆盖：实时通知带的是完整投影值，收到过就以它为准；基线读取与
   * 实时变化并发时，较早算出的基线不得盖掉较新的实时值。
   */
  private applyInbox(sessionId: string, value: unknown, origin: 'live' | 'baseline'): void {
    if (this.capabilities.promptQueue !== true) return;
    // 子代理会话由父会话路由，不向手机提供队列。
    if (this.subagentSessionIds.has(sessionId)) return;
    if (origin === 'baseline' && this.queues.has(sessionId)) return;
    const items = projectQueue(value);
    // 读不懂的值不当作空队列：客户端会把消失的项当成已发出。
    if (items === undefined) return;
    const fingerprint = JSON.stringify(items);
    const previous = this.queues.get(sessionId);
    this.queues.set(sessionId, { items, fingerprint });
    if (origin === 'live' && previous?.fingerprint !== fingerprint) {
      this.record('s2c.session.queue', { sessionId, items });
    }
  }

  /**
   * 打开会话时补发的快照：不占 seq，与 tail 同属打开响应。还没读到过该会话的
   * 投影（基线失败、Host 不提供或子代理会话）时不发，因为未知不等于空队列。
   */
  private pushQueueSnapshot(sink: BridgeSink, sessionId: string): void {
    if (this.disposed) return;
    const queue = this.queues.get(sessionId);
    if (queue === undefined) return;
    sink.push('s2c.session.queue', { sessionId, items: queue.items });
  }

  private applyProjection(sessionId: string, key: string, value: unknown, origin: 'baseline' | 'live' = 'baseline', seq?: number): void {
    const row = this.summaries.get(sessionId);
    if (key === 'goal') {
      if (this.subagentSessionIds.has(sessionId)) return;
      const result = this.goals.apply(sessionId, value, origin, seq);
      if (!result.accepted) return;
      if (row) { row.goal = this.goals.get(sessionId); this.pushSummary(row); }
      if (result.completed) this.emitNotify({
        sessionId, category: 'goal.completed', title: '目标完成', body: result.completed.objective,
        notificationId: 'goal-' + result.completed.id + ':' + sessionId,
      });
      return;
    }
    if (!row) return;
    if (key === 'title') {
      row.title = typeof value === 'string' ? value : '';
    } else if (key === 'todos') {
      const items = Array.isArray(value) ? value as Array<{ content?: unknown; status?: unknown }> : null;
      const sanitized = sanitizeTodoItems(items);
      row.todoItems = sanitized.length > 0 ? sanitized : null;
      row.todos = sanitized.length > 0
        ? { done: sanitized.filter(i => i.status === 'completed').length, total: sanitized.length }
        : null;
    } else if (key === 'sessionListMetadata') {
      const meta = value as { lastPromptAt?: number } | null;
      if (meta?.lastPromptAt) row.lastActivityTs = Math.max(row.lastActivityTs, meta.lastPromptAt);
    } else if (key === 'sessionStats' || key === 'tokenUsage') {
      // Host usage projections arrive as two independent keys over the mux
      // stream; merge each patch into the summary's stats snapshot so a
      // sessionStats-only or tokenUsage-only host still shows partial data.
      const patch = sanitizeUsageStatsPatch(key, value);
      if (!patch) return;
      row.stats = { ...emptyUsageStats, ...(row.stats ?? {}), ...patch };
    } else {
      return;
    }
    this.pushSummary(row);
  }

  private bumpPendingFlags(sessionId: string): void {
    const row = this.summaries.get(sessionId);
    if (!row) return;
    let approval = false;
    for (const pending of this.approvals.values()) {
      if (pending.sessionId === sessionId) approval = true;
    }
    let question = false;
    for (const pending of this.questions.values()) {
      if (pending.sessionId === sessionId) question = true;
    }
    row.pendingApproval = approval;
    row.pendingQuestion = question;
    this.pushSummary(row);
  }

  private pushSummary(row: SessionSummary): void {
    const full = JSON.stringify(row)
    const previous = this.summaryPushed.get(row.id)
    // 内容与上次推出的完全相同：多个来源（状态、投影、活动）同一时刻各推一次时常见。
    if (previous?.full === full) return
    const withoutStats = JSON.stringify({ ...row, stats: undefined })
    const now = Date.now()
    const statsOnly = previous !== undefined && previous.withoutStats === withoutStats
    if (statsOnly && now - previous.at < SUMMARY_STATS_THROTTLE_MS) {
      // 只改了用量统计：窗口内合并成一次，到点推送届时的最新值。
      if (!this.summaryStatsTimers.has(row.id)) {
        const timer = setTimeout(() => {
          this.summaryStatsTimers.delete(row.id)
          const latest = this.summaries.get(row.id)
          if (latest && !this.disposed) this.pushSummary(latest)
        }, SUMMARY_STATS_THROTTLE_MS - (now - previous.at))
        timer.unref?.()
        this.summaryStatsTimers.set(row.id, timer)
      }
      return
    }
    const pending = this.summaryStatsTimers.get(row.id)
    if (pending !== undefined) {
      clearTimeout(pending)
      this.summaryStatsTimers.delete(row.id)
    }
    this.summaryPushed.set(row.id, { full, withoutStats, at: now })
    this.record('s2c.sessions.delta', { upserted: [row], removedIds: [] });
  }

  private noteSummaryPushed(row: SessionSummary): void {
    const pending = this.summaryStatsTimers.get(row.id)
    if (pending !== undefined) {
      clearTimeout(pending)
      this.summaryStatsTimers.delete(row.id)
    }
    this.summaryPushed.set(row.id, {
      full: JSON.stringify(row),
      withoutStats: JSON.stringify({ ...row, stats: undefined }),
      at: Date.now(),
    })
  }

  private forgetSummaryPush(sessionId: string): void {
    const pending = this.summaryStatsTimers.get(sessionId)
    if (pending !== undefined) clearTimeout(pending)
    this.summaryStatsTimers.delete(sessionId)
    this.summaryPushed.delete(sessionId)
  }

  listSessions(): SessionSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  }

  /**
   * Archived rows from the last sessions.list, newest first. Served only on
   * demand so the live session list and its broadcast keep their shape for
   * clients that predate `c2s.sessions.archived`.
   */
  listArchivedSessions(): SessionSummary[] {
    return [...this.archivedSummaries.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  }

  /**
   * Complete transient interaction state. Unlike the replay ring, this remains
   * authoritative after a long disconnect and is rehydrated by apiProxy's mux
   * stream when the bridge itself restarts.
   */
  pendingSnapshot(): PendingSnapshotPayload {
    return {
      approvals: [...this.approvals.entries()].map(([requestId, pending]) => ({
        requestId,
        sessionId: pending.sessionId,
        toolName: pending.toolName,
        summary: pending.reason,
        ...(pending.toolArguments !== undefined ? { toolArguments: pending.toolArguments } : {}),
        riskLevel: riskOf(pending.toolName),
      })),
      questions: [...this.questions.entries()].map(([requestId, pending]) => ({
        requestId,
        sessionId: pending.sessionId,
        questions: Array.isArray(pending.questions)
          ? pending.questions as PendingSnapshotPayload['questions'][number]['questions']
          : [],
      })),
    };
  }

  /** Resolve only the exact invocation in this session; never guess from the latest tool. */
  private async loadApprovalArguments(requestId: string, callId: string): Promise<void> {
    const pending = this.approvals.get(requestId);
    if (!pending) return;
    try {
      const response = await this.apiProxy.sessions.history({
        rpcId: randomUUID(),
        payload: { sessionId: pending.sessionId, maxMessages: 200 },
      });
      if (this.disposed || this.approvals.get(requestId) !== pending || !response.result?.ok) return;
      const event = (response.result.value.events ?? []).map(row => row.event).find(event => {
        const data = event.data as { callId?: string; name?: string } | undefined;
        return event.type === 'tool/call' && data?.callId === callId && data?.name === pending.toolName;
      });
      const args = (event?.data as { arguments?: unknown } | undefined)?.arguments;
      if (typeof args !== 'string' || !args.trim()) return;
      pending.toolArguments = args;
      this.record('s2c.pending.approval', {
        requestId, sessionId: pending.sessionId, toolName: pending.toolName,
        summary: pending.reason, riskLevel: riskOf(pending.toolName), toolArguments: args,
      });
    } catch {
      // Keep the approval answerable with explicitly unavailable execution details.
    }
  }

  // ---------- data operations ----------

  /** Tail history for an opened session; pushes s2c.session.tail to the sink. */
  async openSession(sink: BridgeSink, sessionId: string, tailCount: number, sinceSeq?: number): Promise<boolean> {
    try {
      const response = await this.apiProxy.sessions.history({
        rpcId: randomUUID(),
        payload: { sessionId, maxMessages: clampTail(tailCount) },
      });
      if (!response.result || !response.result.ok) return false;
      const result = response.result.value;
      const events = result.events ?? [];
      this.imageRefs.remember(sessionId, events.map(row => row.event));
      const touched = new Map<number, number>();
      const projected = projectHistory(events, touched);
      const page = limitSessionPageMessages(projected);
      const messages = page.messages;
      const oldestSeq = messages.length > 0 ? messages[0]!.seq : 0;
      const hasMore = Boolean(result.hasMore) || page.dropped > 0;
      const delta = sinceSeq === undefined ? undefined : incrementalTail(events, projected, touched, sinceSeq);
      sink.push('s2c.session.tail', delta === undefined
        ? { sessionId, messages, oldestSeq, hasMore }
        // 增量：只含 sinceSeq 之后改动过的行；oldestSeq/hasMore 仍是本次窗口的值，客户端忽略。
        : { sessionId, messages: delta, oldestSeq, hasMore, incremental: true, sinceSeq });
      this.deriveTitleFallback(sessionId, messages);
      // DSH exposes a complete per-session projection baseline; fold it
      // into the summary row when the phone opens a session so the first paint
      // does not depend on list-row hints or frames missed while offline.
      // The queue snapshot follows the baseline because a bridge that has not
      // yet seen a live inbox change for this session only learns it there.
      void this.refreshProjections(sessionId).then(() => this.pushQueueSnapshot(sink, sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pull one session's projection baseline and fold every key
   * through applyProjection — unknown keys are ignored there, `null` means the
   * session no longer exists, and any failure degrades to a diagnostic: opening
   * a session must never fail because a baseline could not be read.
   */
  private async refreshProjections(sessionId: string): Promise<void> {
    try {
      const response = await this.apiProxy.sessions.projections({
        rpcId: randomUUID(),
        payload: { sessionId },
      });
      if (this.disposed) return;
      const result = response.result;
      if (!result) return;
      if (!result.ok) {
        this.diagnostic('sessions.projections failed: ' + result.error.code);
        return;
      }
      const baseline = result.value;
      if (baseline === null || baseline === undefined) {
        this.queues.delete(sessionId);
        return;
      }
      for (const [key, value] of Object.entries(baseline.values ?? {})) {
        if (key === 'inbox') this.applyInbox(sessionId, value, 'baseline');
        this.applyProjection(sessionId, key, value, 'baseline', baseline.asOfSeq);
      }
    } catch (error) {
      this.diagnostic('sessions.projections threw: ' + String((error as { message?: unknown })?.message ?? error));
    }
  }

  async historyPage(
    sessionId: string,
    beforeSeq: number,
    limit: number,
  ): Promise<{ sessionId: string; messages: MessageProjection[]; hasMore: boolean } | null> {
    try {
      const response = await this.apiProxy.sessions.history({
        rpcId: randomUUID(),
        payload: { sessionId, beforeSeq, maxMessages: clampTail(limit) },
      });
      if (!response.result || !response.result.ok) return null;
      const result = response.result.value;
      this.imageRefs.remember(sessionId, (result.events ?? []).map(row => row.event));
      // Some host versions include the boundary event even though beforeSeq
      // is exclusive. Enforce the phone protocol here so a client can never
      // request and append the same page indefinitely.
      const projected = projectHistory(result.events ?? [])
        .filter((message) => message.seq < beforeSeq);
      const page = limitSessionPageMessages(projected);
      return {
        sessionId,
        messages: page.messages,
        // An empty exclusive page cannot advance beforeSeq. Advertising more
        // here would make the client request the same boundary forever.
        hasMore: page.messages.length > 0 && (Boolean(result.hasMore) || page.dropped > 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * 本机预览准入（PROTOCOL.md「本机预览扩展」）：会话最近 `maxMessages` 条消息里是否
   * 出现过 `needle`（形如 `127.0.0.1:4720`）。
   *
   * 直接在宿主原始事件的 JSON 上找子串，而不是在手机投影上找：链接可能出现在助手正文、
   * 工具输出或命令参数里，投影会裁剪其中一部分。`needle` 只含数字、点、冒号、方括号与
   * 字母，JSON 序列化不会转义它们。读取失败或会话不存在时返回 null（对应 reason
   * `session-not-found`），由调用方决定文案。
   */
  async sessionMentions(sessionId: string, needle: string, maxMessages = 2000): Promise<boolean | null> {
    let beforeSeq: number | undefined
    let scanned = 0
    try {
      while (scanned < maxMessages) {
        const response = await this.apiProxy.sessions.history({
          rpcId: randomUUID(),
          payload: {
            sessionId,
            ...(beforeSeq !== undefined ? { beforeSeq } : {}),
            maxMessages: clampTail(Math.min(MAX_HISTORY_PAGE_MESSAGES, maxMessages - scanned)),
          },
        });
        if (!response.result || !response.result.ok) return scanned === 0 ? null : false;
        const events = response.result.value.events ?? [];
        if (events.length === 0) return false;
        if (JSON.stringify(events).includes(needle)) return true;
        scanned += events.length;
        // 下一页从本页最早的 seq 往前取；seq 不前进（宿主边界异常）时停止，防止死循环。
        const oldest = Math.min(...events.map((row) => row.event.seq));
        if (!response.result.value.hasMore || !Number.isFinite(oldest) || (beforeSeq !== undefined && oldest >= beforeSeq)) {
          return false;
        }
        beforeSeq = oldest;
      }
      return false;
    } catch {
      return scanned === 0 ? null : false;
    }
  }

  /**
   * Result of one attachment read-back for the phone.
   *
   * 宿主读图参数有两代：DSH ≤ 0.2.1 收 `{sessionId, attachmentId}` 并自己在会话日志里
   * 找引用；DSH 0.2.2 起改收 `{sessionId, attachment: 完整引用}`，且不再核对会话。
   * 控制器是直接注入的实例、不经参数 schema 校验，所以两代字段一起传：旧宿主读前者，
   * 新宿主读后者。完整引用来自 imageRefs（本会话投影过的图片）；找不到时不带
   * `attachment`，旧宿主照常自查，新宿主读不到即回 null（E_NOT_FOUND）——手机因此
   * 读不到不属于该会话的图片。
   */
  async attachmentData(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ mediaType?: string; data: string } | null> {
    const read = this.apiProxy.sessions.attachment
    if (typeof read !== 'function') return null;
    try {
      const ref = await this.imageRefs.resolve(sessionId, attachmentId, (id, beforeSeq) => this.readHistoryEvents(id, beforeSeq));
      const response = await read.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId, attachmentId, ...(ref ? { attachment: ref } : {}) },
      });
      if (!response.result || !response.result.ok) return null;
      const data = response.result.value.data;
      if (typeof data !== 'string' || data.length === 0) return null;
      return {
        ...(typeof response.result.value.attachment?.mediaType === 'string'
          ? { mediaType: response.result.value.attachment.mediaType as string }
          : {}),
        data,
      };
    } catch {
      return null;
    }
  }

  /** 图片引用回查用的原始历史页：只取事件，不投影、不推给手机。 */
  private async readHistoryEvents(
    sessionId: string,
    beforeSeq: number | undefined,
  ): Promise<{ events: SessionEventLike[]; hasMore: boolean } | null> {
    try {
      const response = await this.apiProxy.sessions.history({
        rpcId: randomUUID(),
        payload: { sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: MAX_HISTORY_PAGE_MESSAGES },
      });
      if (!response.result || !response.result.ok) return null;
      const result = response.result.value;
      return { events: (result.events ?? []).map(row => row.event), hasMore: Boolean(result.hasMore) };
    } catch {
      return null;
    }
  }

  async commandOperation(operation: 'list' | 'execute' | 'permissions' | 'feedback', payload: Record<string, unknown>): Promise<SessionManagementResult<unknown>> {
    const api = this.apiProxy.commands
    if (!api) return { ok: false, code: 'E_UNSUPPORTED', message: '当前主机不支持手机指令' }
    try {
      const invoke = api[operation] as (request: { rpcId: string; payload: Record<string, unknown> }) => Promise<{ result?: { ok: boolean; value?: unknown; error?: { code: string; message?: string } } }>
      const response = await invoke.call(api, { rpcId: randomUUID(), payload })
      if (response.result?.ok) return { ok: true, value: response.result.value ?? {} }
      // 指令域的失败一律过域表：原先这里无条件回落 E_INTERNAL，于是「指令不存在」
      // 与「主机内部错误」在手机上是同一个码，客户端没法据此分支。
      return wireErrorOf('command', response.result?.error ?? { code: 'command/invalid-response' })
    } catch (error) {
      return wireErrorOf('command', hostFailureOf(error, 'command/invalid-response'))
    }
  }

  /**
   * 输入框 `@` 引用候选。两类候选的单类失败已在 reference-api 内吸收为空列表，
   * 这里只处理「两类都不可用」与代理层意外异常。
   */
  async referenceCandidates(sessionId: string, query: string, signal?: AbortSignal): Promise<SessionManagementResult<import('./reference-api.ts').ReferenceCandidates>> {
    const api = this.apiProxy.references
    if (!api) return { ok: false, code: 'E_UNSUPPORTED', message: '当前主机不支持引用文件或会话' }
    try {
      const response = await api.list({ rpcId: randomUUID(), payload: { sessionId, query } }, signal)
      if (response.result?.ok && response.result.value) return { ok: true, value: response.result.value }
      return { ok: false, code: 'E_INTERNAL', message: '无法读取引用候选' }
    } catch {
      return { ok: false, code: 'E_INTERNAL', message: '无法读取引用候选' }
    }
  }

  async exportSession(sessionId: string, signal: AbortSignal, format?: import('./protocol.ts').SessionExportFormat): Promise<Response> {
    const api = this.apiProxy.commands
    if (!api) throw Object.assign(new Error('当前主机不支持日志导出'), { code: 'command/export-unsupported' })
    return api.export({ rpcId: randomUUID(), payload: { sessionId, ...(format === undefined ? {} : { format }) } }, signal)
  }

  /** 由会话目录决定技能可见性；不读取正文，也不把本机路径发给移动端。 */
  async sessionSkills(sessionId: string): Promise<SessionManagementResult<{ skills: import('./protocol.ts').SkillSummary[] }>> {
    const read = this.apiProxy.sessions.skills
    if (!read) return { ok: false, code: 'E_UNSUPPORTED', message: '当前主机不支持技能目录' }
    try {
      const response = await read.call(this.apiProxy.sessions, { rpcId: randomUUID(), payload: { sessionId } })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: '技能目录响应无效' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      const seen = new Set<string>()
      const skills = response.result.value.skills.map(skill => {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(skill.name) || seen.has(skill.name) ||
            typeof skill.description !== 'string' || typeof skill.modelInvocable !== 'boolean') {
          throw new Error('技能目录条目无效')
        }
        seen.add(skill.name)
        return { name: skill.name, description: skill.description, modelInvocable: skill.modelInvocable }
      })
      return { ok: true, value: { skills } }
    } catch {
      return { ok: false, code: 'E_INTERNAL', message: '无法读取当前会话的技能目录' }
    }
  }

  async sessionModels(sessionId: string): Promise<ModelBridgeResult<HostSessionModels>> {
    const models = this.apiProxy.sessions.models
    if (typeof models !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'model catalog unavailable on this host version' }
    }
    try {
      const response = await models.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'model catalog returned no result' }
      if (!response.result.ok) return wireErrorOf('model', response.result.error)
      return { ok: true, value: projectSessionModels(response.result.value) }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async selectSessionModel(
    sessionId: string,
    selection: HostModelSelection,
  ): Promise<ModelBridgeResult<HostModelSelection>> {
    const selectModel = this.apiProxy.sessions.selectModel
    if (typeof selectModel !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'model selection unavailable on this host version' }
    }
    try {
      const response = await selectModel.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: {
          sessionId,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'model selection returned no result' }
      if (!response.result.ok) return wireErrorOf('model', response.result.error)
      return { ok: true, value: { ...response.result.value.selected } }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async renameSession(sessionId: string, title: string): Promise<SessionManagementResult<string>> {
    const rename = this.apiProxy.sessions.rename
    if (typeof rename !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'session rename unavailable on this host version' }
    }
    try {
      const response = await rename.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId, title },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'session rename returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      const acceptedTitle = String(response.result.value.title)
      const row = this.summaries.get(sessionId)
      if (row) {
        row.title = acceptedTitle
        this.pushSummary(row)
      }
      return { ok: true, value: acceptedTitle }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async archiveSession(sessionId: string): Promise<SessionManagementResult<true>> {
    const archive = this.apiProxy.workspace?.archiveSession
    if (typeof archive !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'session archive unavailable on this host version' }
    }
    try {
      const response = await archive.call(this.apiProxy.workspace, {
        rpcId: randomUUID(),
        payload: { sessionId },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'session archive returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      this.archivedSessionIds = new Set(
        (response.result.value.archivedSessionIds ?? []).map(String),
      )
      this.summaries.delete(sessionId)
      this.goals.forget(sessionId)
      this.lastAssistantText.delete(sessionId)
      this.forgetSummaryPush(sessionId)
      this.record('s2c.sessions.delta', { upserted: [], removedIds: [sessionId] })
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async unarchiveSession(sessionId: string): Promise<SessionManagementResult<true>> {
    const unarchive = this.apiProxy.workspace?.unarchiveSession
    if (typeof unarchive !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'session restore unavailable on this host version' }
    }
    try {
      const response = await unarchive.call(this.apiProxy.workspace, {
        rpcId: randomUUID(),
        payload: { sessionId },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'session restore returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      this.archivedSessionIds = new Set(
        (response.result.value.archivedSessionIds ?? []).map(String),
      )
      // Rebuild both mirrors from the Host instead of hand-moving the row:
      // refreshSummaries re-emits s2c.sessions.delta, which carries the restored
      // session back to the client's live list.
      await this.refreshSummaries()
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  /**
   * 删除或转向一条排队项。ack 只表示 Host 已提交变更，真实状态以随后的
   * s2c.session.queue 为准；不做幂等，项已消失时 Host 回 queue-item-not-found。
   */
  async updateQueue(
    sessionId: string,
    itemId: string,
    action: 'remove' | 'steer',
  ): Promise<SessionManagementResult<{ sessionId: string; itemId: string }>> {
    const update = this.apiProxy.sessions.updateQueue
    if (typeof update !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'prompt queue unavailable on this host version' }
    }
    try {
      const response = await update.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId, itemId, action: { kind: action } },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'queue update returned no result' }
      if (!response.result.ok) return wireErrorOf('queue', response.result.error)
      return { ok: true, value: { sessionId, itemId } }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async cancelSession(sessionId: string): Promise<SessionManagementResult<true>> {
    const cancel = this.apiProxy.sessions.cancel
    if (typeof cancel !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'session cancel unavailable on this host version' }
    }
    try {
      const response = await cancel.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'session cancel returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async listWorkspaces(): Promise<SessionManagementResult<Array<{
    id: string; title: string; path: string; sessionIds: string[]
  }>>> {
    const list = this.apiProxy.workspace?.list
    if (typeof list !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'workspace list unavailable on this host version' }
    }
    try {
      const response = await list.call(this.apiProxy.workspace, { rpcId: randomUUID(), payload: {} })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'workspace list returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      return { ok: true, value: (response.result.value.items ?? []).map(projectWorkspace) }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async createWorkspace(path: string): Promise<SessionManagementResult<{
    workspace: { id: string; title: string; path: string; sessionIds: string[] }; created: boolean
  }>> {
    const create = this.apiProxy.workspace?.create
    if (typeof create !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'workspace create unavailable on this host version' }
    }
    try {
      const response = await create.call(this.apiProxy.workspace, {
        rpcId: randomUUID(),
        payload: { path },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'workspace create returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      await this.refreshSummaries()
      return {
        ok: true,
        value: { workspace: projectWorkspace(response.result.value.workspace), created: response.result.value.created === true },
      }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async listDirectory(path?: string): Promise<SessionManagementResult<DirectoryListingLike>> {
    const list = this.apiProxy.host?.listDirectory
    if (typeof list !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'directory browsing unavailable on this host version' }
    }
    try {
      const response = await list.call(this.apiProxy.host, {
        rpcId: randomUUID(),
        payload: path && path.trim().length > 0 ? { path } : {},
      }, this.abort.signal)
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'directory list returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      return { ok: true, value: response.result.value }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async pickDirectory(): Promise<SessionManagementResult<string | null>> {
    const pick = this.apiProxy.host?.pickDirectory
    if (typeof pick !== 'function') {
      return { ok: false, code: 'E_UNSUPPORTED', message: 'native directory picker unavailable on this host version' }
    }
    try {
      const response = await pick.call(this.apiProxy.host, {
        rpcId: randomUUID(),
        payload: {},
      }, this.abort.signal)
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'directory picker returned no result' }
      if (!response.result.ok) return wireErrorOf('session', response.result.error)
      return { ok: true, value: response.result.value.path }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  /** Create a fresh blank session in an existing workspace or legacy cwd. */
  async createSession(destination: { workspaceId?: string; cwd?: string } = {}): Promise<string | null> {
    try {
      const response = await this.apiProxy.sessions.create({
        rpcId: randomUUID(),
        payload: {
          ...(destination.workspaceId?.trim() ? { workspaceId: destination.workspaceId.trim() } : {}),
          ...(destination.cwd?.trim() ? { cwd: destination.cwd.trim() } : {}),
        },
      });
      if (!response.result || !response.result.ok) return null;
      const sessionId = response.result.value.sessionId;
      await this.refreshSummaries();
      return sessionId;
    } catch {
      return null;
    }
  }

  async forkSession(
    deviceId: string,
    payload: { clientRequestId: string; sessionId: string; atSeq?: number },
  ): Promise<ScheduleBridgeResult<{ sessionId: string }>> {
    const fork = this.apiProxy.sessions.fork
    if (typeof fork !== 'function') return { ok: false, code: 'E_UNSUPPORTED', message: 'session fork unavailable on this host version' }
    if (!this.summaries.has(payload.sessionId)) return { ok: false, code: 'E_NOT_FOUND', message: 'session not found' }
    if (this.archivedSessionIds.has(payload.sessionId) || this.subagentSessionIds.has(payload.sessionId)) {
      return { ok: false, code: 'E_PROTOCOL', message: 'archived or subagent sessions cannot be forked' }
    }
    const result = await this.forkMutations.dispatch(
      deviceId,
      payload.clientRequestId,
      { sessionId: payload.sessionId, ...(payload.atSeq !== undefined ? { atSeq: payload.atSeq } : {}) },
      async () => {
        const response = await fork.call(this.apiProxy.sessions, {
          rpcId: randomUUID(),
          payload: { sessionId: payload.sessionId, ...(payload.atSeq !== undefined ? { atSeq: payload.atSeq } : {}) },
        })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'session fork returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        return { ok: true, value: { sessionId: response.result.value.sessionId } }
      },
    )
    if (result.ok) {
      await this.refreshSummaries()
      return { ok: true, value: result.value as { sessionId: string }, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  /**
   * 当前 adapter 是否宿主级计划任务模型。
   *
   * 能力位 `schedulesHost`（host-capabilities.ts）与新帧、旧帧映射全部读这一个
   * 判别位：探测只发生一次（DshApiProxy.resolveSchedule），这里不再看控制器
   * 方法，也不看版本号字符串。
   */
  private get hostSchedule(): HostScheduleApiLike | undefined {
    const schedule = this.apiProxy.schedule
    return schedule?.mode === 'host' ? schedule : undefined
  }

  async listSchedules(sessionId: string): Promise<ScheduleBridgeResult<ScheduleTaskViewLike[]>> {
    const schedule = this.apiProxy.schedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'schedules unavailable on this host version' }
    // 旧帧映射（PROTOCOL.md「旧帧在宿主级模型上的映射」）：宿主级列表全量分页后
    // 过滤目标会话，反向投影成旧视图；旧 App 不需要升级。
    if (schedule.mode === 'host') return this.listHostSchedulesAsLegacy(schedule, sessionId)
    try {
      const response = await schedule.list({ rpcId: randomUUID(), payload: { sessionId } })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule list returned no result' }
      if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
      return { ok: true, value: response.result.value.tasks }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  /** 宿主级列表 -> 旧会话级视图：过滤 session 目标、丢弃 ended、按 scheduledAt 升序。 */
  private async listHostSchedulesAsLegacy(
    schedule: HostScheduleApiLike,
    sessionId: string,
  ): Promise<ScheduleBridgeResult<ScheduleTaskViewLike[]>> {
    try {
      const tasks: HostScheduleTaskView[] = []
      let offset = 0
      // 全量分页：`total` 是过滤后总数；空页或凑满 total 即收口，避免 Host 在
      // 翻页期间变更导致的死循环。
      for (;;) {
        const response = await schedule.list({
          rpcId: randomUUID(),
          payload: { limit: HOST_SCHEDULE_PAGE_SIZE, offset },
        })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule list returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        const page = response.result.value
        tasks.push(...page.tasks)
        offset += page.tasks.length
        if (page.tasks.length === 0 || offset >= page.total) break
      }
      const views: ScheduleTaskViewLike[] = []
      for (const task of tasks) {
        if (task.target.kind !== 'session' || task.target.sessionId !== sessionId) continue
        if (task.status === 'ended') continue
        const view = toLegacyScheduleView(task)
        if (view !== undefined) views.push(view)
      }
      views.sort((left, right) => left.scheduledAt < right.scheduledAt ? -1 : left.scheduledAt > right.scheduledAt ? 1 : 0)
      return { ok: true, value: views }
    } catch (error) {
      return wireErrorOf('schedule', hostFailureOf(error, 'internal'))
    }
  }

  async listHostSchedules(
    request: HostScheduleListRequestLike = {},
  ): Promise<ScheduleBridgeResult<HostScheduleListResultLike>> {
    const schedule = this.hostSchedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'host-level schedules unavailable on this host version' }
    try {
      const response = await schedule.list({ rpcId: randomUUID(), payload: request })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule host list returned no result' }
      if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
      return { ok: true, value: response.result.value }
    } catch (error) {
      return wireErrorOf('schedule', hostFailureOf(error, 'internal'))
    }
  }

  async viewHostSchedule(id: string): Promise<ScheduleBridgeResult<HostScheduleTaskView>> {
    const schedule = this.hostSchedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'host-level schedules unavailable on this host version' }
    try {
      const response = await schedule.view({ rpcId: randomUUID(), payload: { id } })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule host view returned no result' }
      if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
      const value = response.result.value
      if (value.kind === 'not-found') return { ok: false, code: 'E_NOT_FOUND', message: 'schedule not found' }
      return { ok: true, value: value.task }
    } catch (error) {
      return wireErrorOf('schedule', hostFailureOf(error, 'internal'))
    }
  }

  async createHostSchedule(
    deviceId: string,
    payload: Record<string, unknown> & {
      clientRequestId: string
      title: string
      prompt: string
      timing: unknown
      target?: unknown
    },
  ): Promise<ScheduleBridgeResult<HostScheduleTaskView>> {
    const schedule = this.hostSchedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'host-level schedules unavailable on this host version' }
    const { clientRequestId, ...request } = payload
    // 幂等：新帧与旧帧共用 scheduleMutations journal 与 clientRequestId；
    // journal 只存请求指纹，不落提醒正文。
    const result = await this.scheduleMutations.dispatch(
      deviceId,
      clientRequestId,
      request,
      async () => {
        const response = await schedule.create({
          rpcId: randomUUID(),
          payload: {
            title: request.title as string,
            prompt: request.prompt as string,
            timing: request.timing as HostScheduleTiming,
            ...(request.target !== undefined
              ? { target: request.target as HostScheduleTargetRequest }
              : {}),
          } satisfies HostScheduleCreateRequestLike,
        })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule host create returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        return { ok: true, value: response.result.value }
      },
    )
    if (result.ok) {
      this.record('s2c.schedule.changed', {})
      return { ok: true, value: result.value as HostScheduleTaskView, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  async editHostSchedule(
    deviceId: string,
    payload: Record<string, unknown> & {
      clientRequestId: string
      id: string
      action: 'update' | 'delete'
      expectedUpdatedAt?: string | null
      patch?: unknown
    },
  ): Promise<ScheduleBridgeResult<HostScheduleEditValue>> {
    const schedule = this.hostSchedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'host-level schedules unavailable on this host version' }
    const { clientRequestId, ...request } = payload
    const result = await this.scheduleMutations.dispatch(
      deviceId,
      clientRequestId,
      request,
      async () => {
        const expected = request.expectedUpdatedAt !== undefined
          ? { expectedUpdatedAt: request.expectedUpdatedAt as string | null }
          : {}
        const response = await schedule.edit({
          rpcId: randomUUID(),
          payload: request.action === 'update'
            ? { id: request.id as string, action: 'update', patch: request.patch as HostSchedulePatch, ...expected }
            : { id: request.id as string, action: 'delete', ...expected },
        })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule host edit returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        const value = response.result.value
        if (value.kind === 'conflict') return { ok: false, code: 'E_BUSY', message: 'schedule changed since it was read' }
        if (value.kind === 'not-found') return { ok: false, code: 'E_NOT_FOUND', message: 'schedule not found' }
        if (request.action === 'delete') {
          if (value.kind !== 'deleted') return { ok: false, code: 'E_INTERNAL', message: 'schedule delete returned an updated task' }
          return { ok: true, value: { deleted: true as const, id: value.id } }
        }
        if (value.kind !== 'task') return { ok: false, code: 'E_INTERNAL', message: 'schedule update returned a deletion' }
        return { ok: true, value: { task: value.task } }
      },
    )
    if (result.ok) {
      this.record('s2c.schedule.changed', {})
      return { ok: true, value: result.value as HostScheduleEditValue, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  async runHostSchedule(
    deviceId: string,
    payload: { clientRequestId: string; id: string },
  ): Promise<ScheduleBridgeResult<HostScheduleTaskView>> {
    const schedule = this.hostSchedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'host-level schedules unavailable on this host version' }
    const result = await this.scheduleMutations.dispatch(
      deviceId,
      payload.clientRequestId,
      { id: payload.id },
      async () => {
        const response = await schedule.run({ rpcId: randomUUID(), payload: { id: payload.id } })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule host run returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        const value = response.result.value
        if (value.kind === 'pending') return { ok: false, code: 'E_BUSY', message: 'schedule execution already pending' }
        if (value.kind === 'not-found') return { ok: false, code: 'E_NOT_FOUND', message: 'schedule not found' }
        return { ok: true, value: value.task }
      },
    )
    if (result.ok) {
      this.record('s2c.schedule.changed', {})
      return { ok: true, value: result.value as HostScheduleTaskView, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  /**
   * 删除宿主上全部已结束（`status="ended"`）的任务，返回删除条数。
   *
   * 与其他变更帧共用 scheduleMutations journal：同一 clientRequestId 重放时直接回放
   * 首次结果，不会再删一次。成功后广播 `s2c.schedule.changed`；失败时同样广播——上游
   * 文档说明失败的批次无法确定哪些行已删除，客户端应重新读取列表。
   */
  async deleteEndedHostSchedules(
    deviceId: string,
    payload: { clientRequestId: string },
  ): Promise<ScheduleBridgeResult<{ deleted?: number }>> {
    const schedule = this.hostSchedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'host-level schedules unavailable on this host version' }
    const result = await this.scheduleMutations.dispatch(
      deviceId,
      payload.clientRequestId,
      { operation: 'deleteEnded' },
      async () => {
        const response = await schedule.deleteEnded({ rpcId: randomUUID(), payload: {} })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule delete ended returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        return { ok: true, value: response.result.value }
      },
    )
    this.record('s2c.schedule.changed', {})
    if (result.ok) {
      // schedule journal 不落盘成功值（persistValues=false），重放时拿不到条数，只回 replayed。
      const value = result.value as { deleted: number } | undefined
      return { ok: true, value: value ?? {}, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  async scheduleLimits(): Promise<ScheduleBridgeResult<{ newSessionIntervalSeconds: number }>> {
    const schedule = this.hostSchedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'host-level schedules unavailable on this host version' }
    try {
      const response = await schedule.limits({ rpcId: randomUUID(), payload: {} })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule limits returned no result' }
      if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
      return { ok: true, value: response.result.value }
    } catch (error) {
      return wireErrorOf('schedule', hostFailureOf(error, 'internal'))
    }
  }

  async scheduleHistory(
    sessionId: string,
    id: string,
    limit: number,
    before?: string,
  ): Promise<ScheduleBridgeResult<ScheduleHistoryViewLike>> {
    const schedule = this.apiProxy.schedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'schedules unavailable on this host version' }
    // 宿主级模型下 id 是任务的唯一标识，sessionId 被忽略（旧帧映射表）。
    if (schedule.mode === 'host') {
      try {
        const response = await schedule.history({
          rpcId: randomUUID(),
          payload: { id, limit, ...(before !== undefined ? { before } : {}) },
        })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule history returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        return { ok: true, value: response.result.value }
      } catch (error) {
        return wireErrorOf('schedule', hostFailureOf(error, 'internal'))
      }
    }
    try {
      const response = await schedule.history({
        rpcId: randomUUID(),
        payload: { sessionId, id, limit, ...(before !== undefined ? { before } : {}) },
      })
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule history returned no result' }
      if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
      return { ok: true, value: response.result.value.history }
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) }
    }
  }

  async createSchedule(
    deviceId: string,
    payload: Record<string, unknown> & { sessionId: string; clientRequestId: string; title: string; prompt: string },
  ): Promise<ScheduleBridgeResult<ScheduleTaskViewLike>> {
    const schedule = this.apiProxy.schedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'schedules unavailable on this host version' }
    // 旧帧映射：选择器 -> timing，target 固定为请求里的会话；成功回旧视图。
    if (schedule.mode === 'host') {
      const { clientRequestId, sessionId, title, prompt, ...selectors } = payload
      const timing = hostTimingFromLegacySelector(selectors)
      if (timing === undefined) return { ok: false, code: 'E_PROTOCOL', message: 'unsupported schedule selector' }
      const request = { title, prompt, timing, target: { kind: 'session', sessionId } satisfies HostScheduleTargetRequest }
      const result = await this.scheduleMutations.dispatch(
        deviceId,
        clientRequestId,
        request,
        async () => {
          const response = await schedule.create({
            rpcId: randomUUID(),
            payload: {
              title,
              prompt,
              timing,
              target: { kind: 'session', sessionId },
            } satisfies HostScheduleCreateRequestLike,
          })
          if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule create returned no result' }
          if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
          const legacy = toLegacyScheduleView(response.result.value)
          if (legacy === undefined) return { ok: false, code: 'E_PROTOCOL', message: 'schedule cannot be represented in the session-scoped view' }
          return { ok: true, value: legacy }
        },
      )
      if (result.ok) {
        this.record('s2c.schedule.changed', {})
        return { ok: true, value: result.value as ScheduleTaskViewLike, replayed: result.replayed }
      }
      return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
    }
    const { clientRequestId, sessionId, ...request } = payload
    const result = await this.scheduleMutations.dispatch(
      deviceId,
      clientRequestId,
      { sessionId, request },
      async () => {
        const response = await schedule.create({ rpcId: randomUUID(), payload: { sessionId, ...request } })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule create returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        return { ok: true, value: response.result.value }
      },
    )
    if (result.ok) {
      this.record('s2c.schedule.changed', {})
      return { ok: true, value: result.value as ScheduleTaskViewLike, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  async updateSchedule(
    deviceId: string,
    payload: Record<string, unknown> & { sessionId: string; id: string; clientRequestId: string; expected: unknown },
  ): Promise<ScheduleBridgeResult<ScheduleTaskViewLike>> {
    const schedule = this.apiProxy.schedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'schedules unavailable on this host version' }
    // 旧帧映射（尽力而为的冲突保护）：先读当前任务，与 expected 不一致回 E_BUSY；
    // 一致则把 title/prompt/change 翻成 patch 走 edit。
    if (schedule.mode === 'host') {
      const request = {
        sessionId: payload.sessionId,
        id: payload.id,
        expected: payload.expected,
        title: payload.title,
        prompt: payload.prompt,
        change: payload.change,
      }
      const result = await this.scheduleMutations.dispatch(
        deviceId,
        payload.clientRequestId,
        request,
        async () => {
          const current = await schedule.view({ rpcId: randomUUID(), payload: { id: payload.id } })
          if (!current.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule view returned no result' }
          if (!current.result.ok) return wireErrorOf('schedule', current.result.error)
          if (current.result.value.kind === 'not-found') return { ok: false, code: 'E_NOT_FOUND', message: 'schedule not found' }
          const currentTask = current.result.value.task
          if (!legacyScheduleMatchesExpected(currentTask, payload.expected)) {
            return { ok: false, code: 'E_BUSY', message: 'schedule changed since it was read' }
          }
          const patch = hostPatchFromLegacyUpdate(payload)
          if (Object.keys(patch).length === 0) {
            // 旧帧允许只带 expected 的无操作更新；宿主级 edit 要求 patch 非空，
            // 因此按成功返回当前任务，不写 Host。
            const legacy = toLegacyScheduleView(currentTask)
            if (legacy === undefined) return { ok: false, code: 'E_PROTOCOL', message: 'schedule cannot be represented in the session-scoped view' }
            return { ok: true, value: legacy }
          }
          const response = await schedule.edit({
            rpcId: randomUUID(),
            payload: { id: payload.id, action: 'update', patch },
          })
          if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule edit returned no result' }
          if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
          const value = response.result.value
          if (value.kind === 'conflict') return { ok: false, code: 'E_BUSY', message: 'schedule changed since it was read' }
          if (value.kind === 'not-found') return { ok: false, code: 'E_NOT_FOUND', message: 'schedule not found' }
          if (value.kind !== 'task') return { ok: false, code: 'E_INTERNAL', message: 'schedule edit returned an unexpected deletion' }
          const legacy = toLegacyScheduleView(value.task)
          if (legacy === undefined) return { ok: false, code: 'E_PROTOCOL', message: 'schedule cannot be represented in the session-scoped view' }
          return { ok: true, value: legacy }
        },
      )
      if (result.ok) {
        this.record('s2c.schedule.changed', {})
        return { ok: true, value: result.value as ScheduleTaskViewLike, replayed: result.replayed }
      }
      return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
    }
    const { clientRequestId, ...request } = payload
    const result = await this.scheduleMutations.dispatch(
      deviceId,
      clientRequestId,
      request,
      async () => {
        const response = await schedule.update({ rpcId: randomUUID(), payload: request })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule update returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        const value = response.result.value
        if (value.updated !== true || value.record === undefined) {
          return { ok: false, code: wireCodeFor('schedule', value.code), message: value.code ?? 'schedule update rejected' }
        }
        return { ok: true, value: value.record }
      },
    )
    if (result.ok) {
      this.record('s2c.schedule.changed', {})
      return { ok: true, value: result.value as ScheduleTaskViewLike, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  async deleteSchedule(
    deviceId: string,
    payload: { sessionId: string; id: string; clientRequestId: string },
  ): Promise<ScheduleBridgeResult<{ id: string; deleted: true }>> {
    const schedule = this.apiProxy.schedule
    if (schedule === undefined) return { ok: false, code: 'E_UNSUPPORTED', message: 'schedules unavailable on this host version' }
    // 旧帧映射：delete 直接走宿主级 edit({action:"delete"})。
    if (schedule.mode === 'host') {
      const result = await this.scheduleMutations.dispatch(
        deviceId,
        payload.clientRequestId,
        { sessionId: payload.sessionId, id: payload.id },
        async () => {
          const response = await schedule.edit({
            rpcId: randomUUID(),
            payload: { id: payload.id, action: 'delete' },
          })
          if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule delete returned no result' }
          if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
          const value = response.result.value
          if (value.kind === 'deleted') return { ok: true, value: { id: value.id, deleted: true as const } }
          if (value.kind === 'not-found') return { ok: false, code: 'E_NOT_FOUND', message: 'schedule not found' }
          if (value.kind === 'conflict') return { ok: false, code: 'E_BUSY', message: 'schedule changed since it was read' }
          return { ok: false, code: 'E_INTERNAL', message: 'schedule delete returned an updated task' }
        },
      )
      if (result.ok) {
        this.record('s2c.schedule.changed', {})
        return { ok: true, value: result.value as { id: string; deleted: true }, replayed: result.replayed }
      }
      return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
    }
    const result = await this.scheduleMutations.dispatch(
      deviceId,
      payload.clientRequestId,
      { sessionId: payload.sessionId, id: payload.id },
      async () => {
        const response = await schedule.delete({
          rpcId: randomUUID(),
          payload: { sessionId: payload.sessionId, id: payload.id },
        })
        if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'schedule delete returned no result' }
        if (!response.result.ok) return wireErrorOf('schedule', response.result.error)
        if (response.result.value.deleted !== true) {
          return { ok: false, code: 'E_NOT_FOUND', message: response.result.value.code ?? 'schedule not found' }
        }
        return { ok: true, value: { id: response.result.value.id, deleted: true as const } }
      },
    )
    if (result.ok) {
      this.record('s2c.schedule.changed', {})
      return { ok: true, value: result.value as { id: string; deleted: true }, replayed: result.replayed }
    }
    return { ok: false, code: result.code, message: result.message ?? result.code, replayed: result.replayed }
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    images: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }> = [],
    documents: PromptDocument[] = [],
    options: { mode?: 'queue' | 'steer'; clientSendId?: string } = {},
  ): Promise<SessionManagementResult<number>> {
    try {
      const content: PromptArgs['content'] = [];
      if (text.trim().length > 0) content.push({ type: 'text', text });
      for (const image of images) content.push({ type: 'image', ...image });
      for (const document of documents) content.push({ type: 'text', text: documentPromptBlock(document) });
      const response = await this.apiProxy.sessions.prompt({
        // rpcId 即 Host requestId：带 clientSendId 时用确定值，日志崩溃后的重新派发
        // 由 Host 按 requestId 去重；队列快照也靠它把项还原成 clientSendId。
        rpcId: options.clientSendId !== undefined ? promptRequestId(options.clientSendId) : randomUUID(),
        payload: {
          sessionId,
          mode: options.mode ?? 'queue',
          content,
          clientTimeZone: localTimeZone(),
        },
      });
      if (!response.result) return { ok: false, code: 'E_INTERNAL', message: 'prompt returned no result' };
      // Preserve the host's error kind so the phone can tell "retry later"
      // (E_BUSY) from "session is gone" (E_NOT_FOUND) instead of mapping
      // every failure onto E_BUSY.
      if (!response.result.ok) return wireErrorOf('session', response.result.error);
      const row = this.summaries.get(sessionId);
      if (row) {
        row.lastActivityTs = Date.now();
        this.pushSummary(row);
      }
      this.userReceiptSeq += 1;
      return { ok: true, value: this.userReceiptSeq };
    } catch (error) {
      return { ok: false, code: 'E_INTERNAL', message: String(error) };
    }
  }


  async respondApproval(
    requestId: string,
    decision: 'allow' | 'deny',
    reason?: string,
  ): Promise<PendingResponseOutcome> {
    const pending = this.approvals.get(requestId);
    if (!pending) return { ok: false, reason: 'not-pending' };
    // Claim the pending entry before responding: a second phone (or a double
    // tap) must not fire another client-response for the same rpcId while the
    // resolved frame is still in flight.
    this.approvals.delete(requestId);
    const outcome = decision === 'allow' ? 'allowed-once' : 'rejected';
    const denialReason = typeof reason === 'string' ? reason.trim().slice(0, 500) : '';
    try {
      const receipt = await this.apiProxy.respond({
        type: 'client-response',
        rpcId: pending.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: pending.sessionId,
            approvalId: requestId,
            outcome,
            // PROTOCOL v2: a deny may carry the user's explanation so the
            // model can adjust course instead of blindly retrying.
            ...(denialReason.length > 0 ? { reason: denialReason } : {}),
          },
        },
      });
      const accepted = Boolean(receipt?.accepted);
      if (!accepted) {
        const failure = receiptFailureReason(receipt);
        // Restore only what the user can retry: `not-pending` means the host
        // already settled the request, and restoring would strand a ghost
        // entry that no future resolved frame will ever clear.
        if (failure !== 'not-pending' && !this.approvals.has(requestId)) {
          this.approvals.set(requestId, pending);
        }
        return { ok: false, reason: failure };
      }
      // The claim above removed the entry, so the upcoming approval/resolved
      // frame finds nothing left to bump — refresh the summary flags here or
      // the session badge stays "pending" until an unrelated refresh.
      this.bumpPendingFlags(pending.sessionId);
      return { ok: true };
    } catch {
      // Transport-level failure: give the request back so the user can retry.
      if (!this.approvals.has(requestId)) this.approvals.set(requestId, pending);
      return { ok: false, reason: 'transport' };
    }
  }

  async respondQuestion(requestId: string, answers: unknown): Promise<PendingResponseOutcome> {
    const pending = this.questions.get(requestId);
    if (!pending) return { ok: false, reason: 'not-pending' };
    this.questions.delete(requestId);
    try {
      const receipt = await this.apiProxy.respond({
        type: 'client-response',
        rpcId: pending.rpcId,
        result: { ok: true, value: { sessionId: pending.sessionId, answer: { answers: normalizeAnswerItems(answers, pending.questions) } } },
      });
      const accepted = Boolean(receipt?.accepted);
      if (!accepted) {
        const failure = receiptFailureReason(receipt);
        // Same ghost-entry rule as approvals: `not-pending` is final, never
        // restore — the host has no record left to resolve against.
        if (failure !== 'not-pending' && !this.questions.has(requestId)) {
          this.questions.set(requestId, pending);
        }
        return { ok: false, reason: failure };
      }
      // Mirror the approval path: the claimed entry cannot bump flags when the
      // resolved frame arrives, so recompute them right after acceptance.
      this.bumpPendingFlags(pending.sessionId);
      return { ok: true };
    } catch {
      if (!this.questions.has(requestId)) this.questions.set(requestId, pending);
      return { ok: false, reason: 'transport' };
    }
  }
}

/**
 * The host validates question answers strictly (core dsh-user-questions via
 * apiProxy): a present-but-empty `custom` fails `matchesQuestions`, and a
 * single-select question rejects `custom` combined with a selection. Clients
 * may send lenient shapes (the phone historically always attached
 * `"custom": ""`, which made EVERY option-only answer fail), so normalize to
 * exactly what the host accepts before forwarding.
 */
export function normalizeAnswerItems(
  raw: unknown,
  questions?: unknown,
): Array<{ id: string; selected: string[]; custom?: string }> {
  if (!Array.isArray(raw)) return [];
  const askedById = new Map<string, { multiSelect?: unknown }>();
  if (Array.isArray(questions)) {
    for (const q of questions) {
      if (typeof q === 'object' && q !== null && typeof (q as { id?: unknown }).id === 'string') {
        askedById.set((q as { id: string }).id, q as { multiSelect?: unknown });
      }
    }
  }
  const items: Array<{ id: string; selected: string[]; custom?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as { id?: unknown; selected?: unknown; custom?: unknown };
    if (typeof r.id !== 'string') continue;
    // De-duplicate while preserving order; duplicate labels are rejected by the host.
    const selected = [...new Set(
      Array.isArray(r.selected) ? r.selected.filter((s): s is string => typeof s === 'string') : [],
    )];
    const customText = typeof r.custom === 'string' ? r.custom : '';
    let custom: string | undefined;
    if (customText.trim().length > 0) custom = customText;
    // A single-select answer must be either options or free text, never both.
    if (custom !== undefined && selected.length > 0 && askedById.get(r.id)?.multiSelect !== true) {
      custom = undefined;
    }
    items.push({ id: r.id, selected, ...(custom !== undefined ? { custom } : {}) });
  }
  return items;
}

/** Map an apiProxy respond receipt onto the failure vocabulary. */
function receiptFailureReason(receipt: { accepted: boolean; reason?: string } | undefined):
  'not-pending' | 'bad-response' {
  return receipt?.reason === 'not-pending' ? 'not-pending' : 'bad-response';
}

// ---------- projection helpers ----------

/**
 * 尾部条数收敛到 [MIN_TAIL_MESSAGES, MAX_HISTORY_PAGE_MESSAGES]。
 * 区间与 wire 行校验（tailCount 1..10000、limit 1..500）共用投影 module 的
 * 常量——「一页能要多少条消息」本是一条规则，原先散在三处。
 */
/**
 * 增量 tail（能力 `incrementalTail`）：返回 sinceSeq 之后改动过的行；不能保证完整时
 * 返回 undefined，调用方回退全量。三种回退：
 * - 窗口没覆盖到 sinceSeq（最旧事件比它新）：中间可能有事件没取到；
 * - sinceSeq 比窗口里最新事件还新：客户端的视图和主机对不上（例如历史被改写）；
 * - 增量本身超过单页 900 KB 预算。
 */
export function incrementalTail(
  events: Array<{ event: SessionEventLike }>,
  projected: MessageProjection[],
  touched: Map<number, number>,
  sinceSeq: number,
): MessageProjection[] | undefined {
  if (events.length === 0) return undefined
  let oldest = Infinity
  let newest = -Infinity
  for (const { event } of events) {
    if (event.seq < oldest) oldest = event.seq
    if (event.seq > newest) newest = event.seq
  }
  if (oldest > sinceSeq || sinceSeq > newest) return undefined
  const delta = projected.filter((message) => (touched.get(message.seq) ?? message.seq) > sinceSeq)
  const limited = limitSessionPageMessages(delta)
  return limited.dropped > 0 ? undefined : limited.messages
}

function clampTail(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HISTORY_PAGE_MESSAGES;
  return Math.max(MIN_TAIL_MESSAGES, Math.min(MAX_HISTORY_PAGE_MESSAGES, Math.floor(n)));
}

function localTimeZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function riskOf(toolName: string): 'read' | 'write' | 'destructive' {
  if (/bash|pwsh|terminal/.test(toolName)) return 'write';
  if (/edit|write|str_replace|create/.test(toolName)) return 'write';
  if (/delete|remove|kill/.test(toolName)) return 'destructive';
  return 'read';
}

/** First question's text for the push banner; the questions payload shape is
 * host-version dependent, so extract defensively. */
export function firstQuestionText(questions: unknown): string {
  if (!Array.isArray(questions) || questions.length === 0) return 'Agent 等待你的输入';
  const first = questions[0] as { question?: unknown } | undefined;
  const text = String(first?.question ?? '').trim();
  return text || 'Agent 等待你的输入';
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/** Validate a host todo projection once; progress counts and the full
 * checklist both derive from this sanitized list so they never disagree. */
function sanitizeTodoItems(items: Array<{ content?: unknown; status?: unknown }> | null): SessionTodoItem[] {
  if (!items) return [];
  return items
    .map(i => ({ content: String(i.content ?? '').trim(), status: String(i.status ?? '') }))
    .filter(i => i.content.length > 0 && TODO_STATUSES.has(i.status))
    .slice(0, 100)
    .map(i => ({ content: i.content, status: i.status as SessionTodoStatus }));
}

/** Zero-value stats snapshot used as the merge base for partial patches. */
const emptyUsageStats: SessionUsageStats = {
  turns: 0,
  steps: 0,
  llmMs: 0,
  toolMs: 0,
  ttftMs: 0,
  ttftSteps: 0,
  decodeMs: 0,
  decodeTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Coerce one host counter to a non-negative integer; junk becomes 0. */
function usageCounter(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

const SESSION_STATS_COUNTERS = [
  'turns', 'steps', 'llmMs', 'toolMs',
  'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens',
] as const;

const TOKEN_USAGE_COUNTERS = [
  'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
] as const;

/** Sanitize one `sessionStats` / `tokenUsage` projection value into the wire
 * stats fields; undefined when the payload carries nothing readable. Host
 * field names differ between the two projections (tokenUsage reports
 * `uncachedInputTokens`, the wire mirrors it as `inputTokens`). */
function sanitizeUsageStatsPatch(key: string, value: unknown): Partial<SessionUsageStats> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const patch: Partial<SessionUsageStats> = {};
  if (key === 'sessionStats') {
    for (const field of SESSION_STATS_COUNTERS) {
      if (field in raw) patch[field] = usageCounter(raw[field]);
    }
  } else {
    if ('uncachedInputTokens' in raw) patch.inputTokens = usageCounter(raw.uncachedInputTokens);
    for (const field of TOKEN_USAGE_COUNTERS) {
      if (field in raw) patch[field] = usageCounter(raw[field]);
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Combine one session's `sessionStats` + `tokenUsage` projection values into
 * a complete wire stats object; undefined when neither carries anything. */
function usageStatsOf(sessionStats: unknown, tokenUsage: unknown): SessionUsageStats | undefined {
  const patches = [
    sanitizeUsageStatsPatch('sessionStats', sessionStats),
    sanitizeUsageStatsPatch('tokenUsage', tokenUsage),
  ].filter((patch): patch is Partial<SessionUsageStats> => patch !== undefined);
  if (patches.length === 0) return undefined;
  return Object.assign({}, emptyUsageStats, ...patches);
}

function toSummary(
  row: PhoneSessionRow,
  approvals: Map<string, PendingApproval>,
  questions: Map<string, PendingQuestion>,
  workspace?: WorkspaceViewLike,
): SessionSummary {
  const values = row.projections?.values ?? {};
  const todos = Array.isArray(values.todos) ? values.todos as Array<{ content?: unknown; status?: unknown }> : null;
  let pendingApproval = false;
  for (const pending of approvals.values()) {
    if (pending.sessionId === row.sessionId) pendingApproval = true;
  }
  let pendingQuestion = false;
  for (const pending of questions.values()) {
    if (pending.sessionId === row.sessionId) pendingQuestion = true;
  }
  const cwd = typeof row.cwd === 'string' ? row.cwd : '';
  const label = workspace?.title ?? (cwd ? cwd.split('/').filter(Boolean).pop() : undefined);
  const todoItems = sanitizeTodoItems(todos);
  const stats = usageStatsOf(values.sessionStats, values.tokenUsage);
  return {
    id: row.sessionId,
    title: typeof values.title === 'string' ? values.title : '',
    // A blank session has never run a turn, and the running flag above
    // already covers the live case. Reporting `unknown` here made the phone
    // treat the composer as "still syncing" forever: nothing ever converges
    // the state back because the first prompt is exactly what the disabled
    // button cannot send. Idle is truthful for every non-running blank row.
    status: row.running ? 'running' : 'idle',
    lastActivityTs: Number(row.updatedAt ?? Date.now()),
    todos: todoItems.length > 0
      ? {
          done: todoItems.filter(i => i.status === 'completed').length,
          total: todoItems.length,
        }
      : null,
    todoItems: todoItems.length > 0 ? todoItems : null,
    pendingApproval,
    pendingQuestion,
    ...(stats ? { stats } : {}),
    workspaceLabel: label ?? null,
    workspaceId: workspace?.workspaceId ?? null,
    workspacePath: workspace?.path ?? (cwd || null),
  };
}

function projectWorkspace(workspace: WorkspaceViewLike): {
  id: string; title: string; path: string; sessionIds: string[]
} {
  return {
    id: String(workspace.workspaceId),
    title: String(workspace.title),
    path: String(workspace.path),
    sessionIds: (workspace.sessionIds ?? []).map(String),
  }
}

/** 把 Host 的模型目录投影成 wire 形状：字段全部收敛为字符串，缺省不补位。 */
function projectSessionModels(value: HostSessionModels): HostSessionModels {
  return {
    current: {
      provider: String(value.current.provider),
      model: String(value.current.model),
      ...(value.current.reasoningEffort ? { reasoningEffort: String(value.current.reasoningEffort) } : {}),
    },
    routable: value.routable === true,
    groups: (value.groups ?? []).map((group) => ({
      id: String(group.id),
      name: String(group.name),
      models: (group.models ?? []).map((model) => ({
        id: String(model.id),
        name: String(model.name),
        ...(model.description ? { description: String(model.description) } : {}),
        ...(model.reasoning ? {
          reasoning: {
            efforts: (model.reasoning.efforts ?? []).map((effort) => ({
              id: String(effort.id),
              name: String(effort.name),
              ...(effort.description ? { description: String(effort.description) } : {}),
            })),
            ...(model.reasoning.defaultEffort
              ? { defaultEffort: String(model.reasoning.defaultEffort) }
              : {}),
          },
        } : {}),
      })),
    })),
    failures: (value.failures ?? []).map((failure) => ({
      id: String(failure.id),
      name: String(failure.name),
      message: String(failure.message),
    })),
  }
}

/** Project a history page (raw events) into MessageProjection rows. */

/* ---------- 旧帧 -> 宿主级模型的映射（PROTOCOL.md「旧帧在宿主级模型上的映射」） ----------
 *
 * 旧 App 只认识会话级视图；宿主级模型的任务带 target 且没有 update/delete。
 * 这些纯函数只负责「把新任务视图反向投影成旧视图」与「把旧请求翻成宿主级
 * 请求」，不含任何 I/O；冲突保护是尽力而为的：旧视图没有 updatedAt，因此用
 * `expected` 与当前任务的旧投影逐字段比较。
 */

/** 宿主级列表全量拉取时的页大小（Host 允许的最大值）。 */
const HOST_SCHEDULE_PAGE_SIZE = 500

/** 参与旧帧冲突比较的字段：`state`/`deliveryMode` 是派生字段，不参与。 */
const LEGACY_PROJECTION_FIELDS = [
  'id',
  'kind',
  'title',
  'prompt',
  'scheduledAt',
  'afterSeconds',
  'everySeconds',
  'time',
  'timeZone',
  'weekdays',
  'expression',
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function legacyNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function legacyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function normalizeAtInput(
  value: unknown,
): string | { date: string; time: string; time_zone: string } | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (!isPlainObject(value)) return undefined
  const date = legacyString(value.date)
  const time = legacyString(value.time)
  const zone = legacyString(value.time_zone, value.timeZone)
  return date !== undefined && time !== undefined && zone !== undefined
    ? { date, time, time_zone: zone }
    : undefined
}

function normalizeLocalTime(value: unknown): { time: string; time_zone: string } | undefined {
  if (!isPlainObject(value)) return undefined
  const time = legacyString(value.time)
  const zone = legacyString(value.time_zone, value.timeZone)
  return time !== undefined && zone !== undefined ? { time, time_zone: zone } : undefined
}

function normalizeWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const days = value.filter(
    (day): day is number => typeof day === 'number' && Number.isSafeInteger(day) && day >= 1 && day <= 7,
  )
  return days.length === value.length ? days : undefined
}

/** 旧创建帧的选择器 -> 宿主级 timing。旧 wire 校验保证恰好一个选择器。 */
function hostTimingFromLegacySelector(
  selectors: Record<string, unknown>,
): HostScheduleTiming | undefined {
  const after = legacyNumber(selectors.after_seconds)
  if (after !== undefined) return { kind: 'after', after_seconds: after }
  if (selectors.at !== undefined) {
    const at = normalizeAtInput(selectors.at)
    return at === undefined ? undefined : { kind: 'at', at }
  }
  const every = legacyNumber(selectors.every_seconds)
  if (every !== undefined) return { kind: 'every', every_seconds: every }
  if (selectors.daily !== undefined) {
    const daily = normalizeLocalTime(selectors.daily)
    return daily === undefined ? undefined : { kind: 'daily', daily }
  }
  if (selectors.weekly !== undefined) {
    if (!isPlainObject(selectors.weekly)) return undefined
    const time = normalizeLocalTime(selectors.weekly)
    const weekdays = normalizeWeekdays(selectors.weekly.weekdays)
    return time === undefined || weekdays === undefined
      ? undefined
      : { kind: 'weekly', weekly: { ...time, weekdays } }
  }
  if (selectors.cron !== undefined) {
    if (!isPlainObject(selectors.cron)) return undefined
    const expression = legacyString(selectors.cron.expression)
    const zone = legacyString(selectors.cron.time_zone, selectors.cron.timeZone)
    return expression === undefined || zone === undefined
      ? undefined
      : { kind: 'cron', cron: { expression, time_zone: zone } }
  }
  return undefined
}

/**
 * 旧更新帧的 `change` -> 宿主级 timing。
 *
 * 两种历史写法都认：选择器式（`{kind:'daily', daily:{...}}`，与创建帧同形）与
 * 扁平式（`{kind:'daily', time, timeZone}` / `{kind:'cron', expression}`）。
 */
function hostTimingFromLegacyChange(change: unknown): HostScheduleTiming | undefined {
  if (!isPlainObject(change)) return undefined
  const selector = hostTimingFromLegacySelector(change)
  if (selector !== undefined) return selector
  switch (change.kind) {
    case 'daily': {
      const time = legacyString(change.time)
      const zone = legacyString(change.time_zone, change.timeZone)
      return time === undefined || zone === undefined ? undefined : { kind: 'daily', daily: { time, time_zone: zone } }
    }
    case 'weekly': {
      const time = legacyString(change.time)
      const zone = legacyString(change.time_zone, change.timeZone)
      const weekdays = normalizeWeekdays(change.weekdays)
      return time === undefined || zone === undefined || weekdays === undefined
        ? undefined
        : { kind: 'weekly', weekly: { time, time_zone: zone, weekdays } }
    }
    case 'cron': {
      const expression = legacyString(change.expression)
      const zone = legacyString(change.time_zone, change.timeZone)
      return expression === undefined || zone === undefined
        ? undefined
        : { kind: 'cron', cron: { expression, time_zone: zone } }
    }
    case 'rrule': {
      const rrule = legacyString(change.rrule)
      return rrule === undefined ? undefined : { kind: 'rrule', rrule }
    }
    default:
      return undefined
  }
}

/** 旧更新帧的 title/prompt/change -> 宿主级 patch。 */
function hostPatchFromLegacyUpdate(payload: Record<string, unknown>): HostSchedulePatch {
  const patch: HostSchedulePatch = {}
  if (typeof payload.title === 'string') patch.title = payload.title
  if (typeof payload.prompt === 'string') patch.prompt = payload.prompt
  const timing = hostTimingFromLegacyChange(payload.change)
  if (timing !== undefined) patch.timing = timing
  return patch
}

/**
 * 宿主级任务视图 -> 旧会话级视图。
 *
 * `state` 只由 `scheduledAt` 是否已过推导（PROTOCOL.md 映射表）；`rrule` 在旧枚举
 * 里没有对应 kind，返回 undefined 让调用方跳过——旧客户端按枚举解码列表，塞进
 * 未知 kind 会让整页解码失败，静默隐藏比让旧 App 打不开列表更安全。
 */
function toLegacyScheduleView(task: HostScheduleTaskView): ScheduleTaskViewLike | undefined {
  const instant = Date.parse(task.scheduledAt)
  const base = {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    scheduledAt: task.scheduledAt,
    state: Number.isFinite(instant) && instant < Date.now() ? 'overdue' as const : 'scheduled' as const,
    deliveryMode: 'host' as const,
  }
  switch (task.timing.kind) {
    case 'after':
      return { ...base, kind: 'after', afterSeconds: task.timing.after_seconds }
    case 'at':
      return { ...base, kind: 'at' }
    case 'every':
      return { ...base, kind: 'every', everySeconds: task.timing.every_seconds }
    case 'daily':
      return {
        ...base,
        kind: 'daily',
        time: task.timing.daily.time,
        timeZone: task.timing.daily.time_zone,
      }
    case 'weekly':
      return {
        ...base,
        kind: 'weekly',
        time: task.timing.weekly.time,
        timeZone: task.timing.weekly.time_zone,
        weekdays: [...task.timing.weekly.weekdays],
      }
    case 'cron':
      return {
        ...base,
        kind: 'cron',
        expression: task.timing.cron.expression,
        timeZone: task.timing.cron.time_zone,
      }
    default:
      return undefined
  }
}

/** 旧帧的冲突保护：当前任务的旧投影与客户端回传的 `expected` 逐字段相等。 */
function legacyScheduleMatchesExpected(task: HostScheduleTaskView, expected: unknown): boolean {
  const view = toLegacyScheduleView(task)
  if (view === undefined) return false
  if (!isPlainObject(expected)) return false
  const actual = view as unknown as Record<string, unknown>
  return LEGACY_PROJECTION_FIELDS.every(
    (key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key]),
  )
}
