import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/wire-errors.d.ts
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
declare const ERROR_CODES: {
  readonly E_AUTH: 'device proof missing or invalid';
  readonly E_FORBIDDEN: 'device scope does not allow this operation';
  readonly E_PROTOCOL: 'unknown type or malformed payload';
  readonly E_NOT_FOUND: 'session or request not found';
  readonly E_BUSY: 'session is busy';
  readonly E_UNSUPPORTED: 'protocol version or capability unsupported';
  readonly E_INTERNAL: 'internal error';
};
type WireErrorCode = keyof typeof ERROR_CODES;
//#endregion
//#region src/dispatch-journal.d.ts
/** 落盘条目：两个通用字段 + codec 私有字段。 */
interface JournalEntry {
  fingerprint: string;
  createdAt: number;
  [field: string]: unknown;
}
/** operation 的结果：成功带值，失败带 wire 错误码。 */
type OperationResult<T = unknown> = {
  ok: true;
  value: T;
} | {
  ok: false;
  code: WireErrorCode;
  message?: string;
};
/**
 * 一切「不看条目就能定」的结果类别。codec 用一个方法把它们翻译成自己的方言，
 * 而不是让核心知道任何一方的形状。
 */
type DispatchOutcome =
/** 命中既有条目（重放）。 */
{
  kind: 'replay';
  entry: JournalEntry;
} |
/** 同一 id 搭不同内容。 */
{
  kind: 'mismatch';
} |
/** 构造期解析失败：journal 已永久降级，本次进程不再投递。 */
{
  kind: 'unavailable';
} |
/** id 的纪元前缀超出保留窗口。 */
{
  kind: 'expired';
} |
/** 条目数已达容量上限。 */
{
  kind: 'full';
} |
/** 刚跑完的那一次：operation 的结果原样带出（不标 replayed）。 */
{
  kind: 'ran';
  entry: JournalEntry;
  result: OperationResult;
} |
/** operation 抛错：条目保持 unknown，且不得自动重试。 */
{
  kind: 'crashed';
} |
/**
 * 预留条目时落盘失败——上游**没有**被调用，但无从判断 rename 是否已经
 * 生效（save() 可能在 rename 之后才抛），因此条目留在内存里按 unknown 处理。
 */
{
  kind: 'reserve-failed';
} |
/** id 形状不合法（仅 mutation 变体开启这道守卫）。 */
{
  kind: 'invalid-id';
};
interface DispatchCodec<TRequest = unknown, TResult = unknown> {
  /** 实例身份：opener 单例键的一部分（含 persistValues 等变体差异）。 */
  readonly identity: string;
  /** 请求指纹。prompt 覆盖 [sessionId, content]；mutation 只覆盖 content。 */
  fingerprint(request: TRequest): string;
  /** 预留条目时写入的 codec 字段（fingerprint/createdAt 由核心补）。 */
  reserve(request: TRequest, id: string): Record<string, unknown>;
  /** operation 成功后就地更新条目。 */
  accepted(entry: JournalEntry, id: string, value: unknown): void;
  /** operation 失败后就地更新条目。 */
  rejected(entry: JournalEntry, id: string, code: WireErrorCode): void;
  /** 把结果类别翻译成调用方言。 */
  resultOf(outcome: DispatchOutcome, id: string): TResult;
  /** id 非法时是否先拒掉（mutation 是；prompt 由 wire 层保证，故否）。 */
  readonly requiresValidId?: boolean;
  /** lookup 的匹配规则；缺省表示该实例不提供 lookup。 */
  matches?(entry: JournalEntry, request: unknown): boolean;
  /** lookup 未命中时回什么（prompt 要区分 notFound / expired）。 */
  miss?(id: string, expired: boolean): TResult;
  /** 落盘容器 → 内存条目表；任何不合法都抛错（核心转成 healthy=false）。 */
  parse(raw: unknown): Record<string, JournalEntry>;
  /** 内存条目表 → 落盘容器。 */
  serialize(entries: Record<string, JournalEntry>): unknown;
}
interface DispatchJournalOptions<TRequest = unknown, TResult = unknown> {
  codec: DispatchCodec<TRequest, TResult>;
  path?: string;
  /** 落盘体积上限：prompt 8MB、mutation 4MB（由条目实际大小决定，不统一）。 */
  maxFileBytes?: number;
  capacity?: number;
  retentionMs?: number;
  /**
   * 并发重复是否搭同在途那次。prompt 是（重复方拿到同一个最终回执）；
   * mutation 否（重复方立刻拿到 unknown → E_INTERNAL）。两者都由对等快照钉住。
   */
  joinInFlight?: boolean;
  /**
   * 落盘失败的诊断输出。由调用方注入它已有的 logger；缺省即静默。
   * 只打阶段与 errno，绝不打条目内容或消息体（plugin 的日志禁令）。
   */
  log?: (message: string) => void;
  /**
   * 目录 fsync 里「对 fd 调用 fsync」这一步的覆盖点，缺省即 `fsyncSync`。
   *
   * 存在的唯一理由是可测：Linux CI 上复现不出 Windows 的 EPERM。注入点刻意
   * 停在 fd 这一层而不是替换整个目录 fsync——容忍 EPERM 的判断必须留在真实
   * 路径里被测到，换掉整函数就等于把待测逻辑一起换掉了。
   */
  fsyncFileDescriptor?: (fd: number) => void;
}
/** Durable at-most-once dispatch. Unknown outcomes are never automatically retried. */
declare class DispatchJournal<TRequest = unknown, TResult = unknown> {
  private readonly options;
  private entries;
  private inFlight;
  /** 只由构造期的解析失败置位，见下方 catch；运行期落盘失败不碰它。 */
  private healthy;
  private readonly maxFileBytes;
  private readonly capacity;
  private readonly retentionMs;
  private readonly joinInFlight;
  constructor(options: DispatchJournalOptions<TRequest, TResult>);
  private key;
  /** id 的纪元前缀是否还在保留窗口内（未来 5 分钟以上同样算非法）。 */
  private expired;
  private save;
  /**
   * 落盘一次，失败只报不降级。
   *
   * 与 `healthy` 的分工：`healthy` 只由构造期的解析失败置位，运行期的磁盘错误
   * 不再拉黑整个进程——此前一次 save() 失败就让本进程余下的所有投递永久返回
   * unknown，直到 DSH 重启（issue #20 / #26）。现在只影响当次投递，下一次
   * dispatch 会重新尝试。
   */
  private persist;
  /** 查询既有回执；`request` 交给 codec 的 matches 判定（缺省即不提供 lookup）。 */
  lookup(deviceId: string, id: string, request?: unknown): TResult | undefined;
  /**
   * 幂等投递。未知结果绝不自动重试：条目保持 unknown，重放时由 codec 决定
   * 调用方看到什么。
   */
  dispatch(deviceId: string, id: string, request: TRequest, operation: () => Promise<OperationResult>): Promise<TResult>;
  /** 等所有在途投递结束；供进程收尾。 */
  settled(): Promise<void>;
}
/** prompt 投递的回执：手机侧按 clientSendId 对账。 */
type DeliveryStatus = 'accepted' | 'rejected' | 'unknown' | 'notFound' | 'expired';
interface DeliveryReceipt {
  clientSendId: string;
  status: DeliveryStatus;
  userSeq?: number;
  code?: string;
}
/** mutation 的结果：replayed 让调用方知道这是重放而非新执行。 */
type MutationErrorCode = WireErrorCode;
type MutationDispatchResult<T> = {
  ok: true;
  value?: T;
  replayed?: boolean;
} | {
  ok: false;
  code: MutationErrorCode;
  message?: string;
  replayed?: boolean;
};
//#endregion
//#region src/device-auth.d.ts
declare const DEVICE_SCOPES: readonly ['sessions.read', 'prompt.send', 'sessions.manage', 'interactions.respond', 'notifications.register', 'schedule.manage'];
type DeviceScope = (typeof DEVICE_SCOPES)[number];
//#endregion
//#region src/protocol.d.ts
interface WelcomeCapabilities {
  historyPaging: boolean;
  replay: boolean;
  approvals: boolean;
  questions: boolean;
  /** Client can request the complete currently-pending approval/question set. */
  pendingSnapshot?: boolean;
  promptDelivery?: boolean;
  /** Bridge emits s2c.notify for all four notification categories. */
  notifyAllCategories?: boolean;
  models: boolean;
  sessionManagement: boolean;
  /** Bridge can fork a session at an exact event boundary. */
  sessionFork?: boolean;
  /** Bridge can list archived sessions and restore them
   * (c2s.sessions.archived / c2s.session.unarchive). Absent on hosts whose
   * workspace controller predates unarchiveSession. */
  sessionRestore?: boolean;
  projectSelection: boolean;
  /** Host exposes the optional DSH Schedule service. */
  schedules?: boolean;
  /** Bridge has APNs configured; clients may send c2s.push.register. */
  push?: boolean;
  widgetPush?: boolean;
  liveActivityPush?: boolean;
  /** Bridge accepts c2s.device.revoke, letting a client unbind itself before
   * deleting its local credentials. Absent on older bridges; older clients
   * ignore the extra field. */
  deviceRevoke?: boolean;
}
type SessionStatus = "running" | "idle" | "error" | "unknown";
/**
 * Cumulative model/token statistics for one session, mirrored from the
 * host's `sessionStats` (dsh-session-stats) + `tokenUsage` (dsh-token-meter)
 * projections. Every counter is a non-negative integer; 0 means nothing
 * recorded yet. Clients derive their display figures from the raw sums:
 * average TTFT = ttftMs / ttftSteps; decode speed = decodeTokens /
 * (decodeMs / 1000); cache hit ratio = cacheReadTokens / (inputTokens +
 * cacheReadTokens + cacheWriteTokens); total prompt tokens = inputTokens +
 * cacheReadTokens + cacheWriteTokens. Absent/null when the host exposes no
 * stats projections (older DSH versions) or nothing has been measured —
 * clients must tolerate missing stats and fall back.
 */
interface SessionUsageStats {
  turns: number;
  steps: number;
  /** Summed model wall time in ms. */
  llmMs: number;
  /** Summed tool wall time in ms. */
  toolMs: number;
  /** Summed first-token latency in ms over ttftSteps. */
  ttftMs: number;
  /** Steps that recorded a first token. */
  ttftSteps: number;
  /** Summed decode wall time in ms over the decode-timed steps. */
  decodeMs: number;
  /** Provider output tokens over the same decode-timed steps. */
  decodeTokens: number;
  /** Provider-reported uncached prompt tokens. */
  inputTokens: number;
  /** Provider-reported output tokens (reasoning included). */
  outputTokens: number;
  /** Prompt tokens served from the provider cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to the provider cache. */
  cacheWriteTokens: number;
}
type SessionTodoStatus = "pending" | "in_progress" | "completed";
/** One checklist entry of the session todo projection. */
interface SessionTodoItem {
  content: string;
  status: SessionTodoStatus;
}
interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  lastActivityTs: number;
  todos: {
    done: number;
    total: number;
  } | null;
  /** Full checklist so a conversation view can render progress, not just counts. Absent/null when the session has none. */
  todoItems?: SessionTodoItem[] | null;
  /** Current tool operation, bounded to 160 Unicode code points. */
  activity?: string | null;
  pendingApproval: boolean;
  pendingQuestion: boolean;
  /** Optional cumulative usage stats (see SessionUsageStats); hosts without
   * the stats projections omit it, and clients must tolerate its absence. */
  stats?: SessionUsageStats | null;
  workspaceLabel: string | null;
  workspaceId?: string | null;
  workspacePath?: string | null;
  /** Present only on rows served by `c2s.sessions.archived`; the live session
   * list never contains archived rows. Clients restore one with
   * `c2s.session.unarchive`. */
  archived?: boolean;
}
type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';
type ToolState = 'running' | 'ok' | 'error';
/** Provenance of host-injected context; present only on `role: "system"` rows.
 * Mirrors the durable DSH message source (`dsh-llm` MessageSource): `label`
 * names the producer (plugin name, skill name, instruction paths…), `form` is
 * the semantic ContextForm vocabulary ('instructions' | 'catalog' | 'snapshot'
 * | 'notice' | 'relay' | 'recall'). Both degrade gracefully — clients must
 * tolerate absent fields and unknown values. */
interface MessageContextInfo {
  label?: string;
  form?: string;
}
/** One image carried by a user message. `attachmentId` keys the read-back RPC
 * (c2s.session.attachment); width/height let clients reserve layout space. */
interface MessageAttachment {
  kind: 'image' | 'document';
  name?: string;
  mediaType?: string;
  attachmentId?: string;
  width?: number;
  height?: number;
  truncated?: boolean;
}
interface MessageProjection {
  /** Durable row identity; unique within one session/page. */
  seq: number;
  role: MessageRole;
  text?: string;
  /** Reasoning ("thinking") text accompanying the answer, when present. */
  thinking?: string;
  streaming?: boolean;
  tool?: {
    name: string;
    state: ToolState;
    summary: string;
  };
  attachments?: MessageAttachment[];
  /** Present only on system rows: provenance of the injected context.
   * The DSH host logs synthetic agent.inject() content (runtime-context
   * snapshots, background-job notices, workspace instructions…) as user-role
   * messages whose `source.kind` is not 'user'; those project here as
   * `role: "system"` so clients never show them as human prompts. */
  context?: MessageContextInfo;
  ts: number;
  truncated?: boolean;
}
type NotifyCategory = 'turn.completed' | 'approval.required' | 'question.asked' | 'session.error';
/**
 * One offline-push-worthy event (same facts as s2c.notify / pending frames,
 * projected for APNs). The bridge fans these out to paired devices that hold
 * an APNs token and no live WebSocket.
 */
interface PushNotification {
  hostAudience?: string;
  notificationId: string;
  category: NotifyCategory;
  sessionId: string;
  title: string;
  body: string;
}
interface PendingApprovalPayload {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  toolArguments?: string;
  riskLevel: 'read' | 'write' | 'destructive';
}
interface PendingQuestionOption {
  label: string;
  description?: string;
}
interface PendingQuestionItem {
  id: string;
  question: string;
  multiSelect?: boolean;
  options?: PendingQuestionOption[];
}
interface PendingQuestionPayload {
  requestId: string;
  sessionId: string;
  questions: PendingQuestionItem[];
}
interface PendingSnapshotPayload {
  approvals: PendingApprovalPayload[];
  questions: PendingQuestionPayload[];
}
//#endregion
//#region src/host-api.d.ts
interface RpcOk<T> {
  ok: true;
  value: T;
}
interface RpcErr {
  ok: false;
  error: {
    code: string;
    message?: string;
  };
}
type RpcResult<T> = RpcOk<T> | RpcErr;
interface RpcRequestLike<T> {
  rpcId?: string;
  payload?: T;
}
interface RpcResponseLike<T> {
  result?: RpcResult<T>;
}
interface SessionsApiLike {
  list(req?: RpcRequestLike<{
    cursor?: string;
  }>): Promise<RpcResponseLike<{
    items: PhoneSessionRow[];
  }>>;
  history(req: RpcRequestLike<{
    sessionId: string;
    beforeSeq?: number;
    maxMessages?: number;
  }>): Promise<RpcResponseLike<HistoryResult>>;
  prompt(req: RpcRequestLike<PromptArgs>): Promise<RpcResponseLike<{
    accepted: true;
  }>>;
  create(req: RpcRequestLike<{
    workspaceId?: string;
    cwd?: string;
    agentPreset?: string;
  }>): Promise<RpcResponseLike<{
    sessionId: string;
    agentPreset?: string;
  }>>;
  fork?(req: RpcRequestLike<{
    sessionId: string;
    atSeq?: number;
  }>): Promise<RpcResponseLike<{
    sessionId: string;
  }>>;
  models?(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<HostSessionModels>>;
  selectModel?(req: RpcRequestLike<{
    sessionId: string;
    provider: string;
    model: string;
    reasoningEffort?: string;
  }>): Promise<RpcResponseLike<{
    selected: HostModelSelection;
  }>>;
  rename?(req: RpcRequestLike<{
    sessionId: string;
    title: string;
  }>): Promise<RpcResponseLike<{
    title: string;
    seq: number;
  }>>;
  cancel?(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<Record<string, unknown> | undefined>>;
  /** Reads one durable image back after the host verifies the session log references its id. */
  attachment?(req: RpcRequestLike<{
    sessionId: string;
    attachmentId: string;
  }>): Promise<RpcResponseLike<{
    attachment: {
      mediaType?: string;
    };
    data: string;
  }>>;
  /** Complete projection baseline for one session; null when it is gone. */
  projections(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<{
    asOfSeq: number;
    values: Record<string, unknown>;
  } | null>>;
}
interface WorkspaceApiLike {
  list?(req: RpcRequestLike<Record<string, never>>): Promise<RpcResponseLike<{
    items: WorkspaceViewLike[];
    archivedSessionIds: string[];
  }>>;
  create?(req: RpcRequestLike<{
    path: string;
  }>): Promise<RpcResponseLike<{
    workspace: WorkspaceViewLike;
    created: boolean;
  }>>;
  archiveSession?(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<{
    archivedSessionIds: string[];
  }>>;
  unarchiveSession?(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<{
    archivedSessionIds: string[];
  }>>;
}
type ScheduleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron';
interface ScheduleTaskViewLike {
  id: string;
  kind: ScheduleKind;
  title: string;
  prompt: string;
  scheduledAt: string;
  state: 'scheduled' | 'overdue';
  deliveryMode: 'host';
  afterSeconds?: number;
  everySeconds?: number;
  time?: string;
  timeZone?: string;
  weekdays?: number[];
  expression?: string;
}
interface ScheduleHistoryViewLike {
  id: string;
  records: Array<{
    scheduledAt: string;
    deliveredAt: string;
    messageId: string;
    prompt?: string;
  }>;
  earlierRecordsUnavailable: boolean;
  earlierRecordsPruned?: boolean;
  retention: {
    days: number;
    records: number;
  };
  nextBefore?: string;
}
interface ScheduleApiLike {
  list(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<{
    sessionId: string;
    tasks: ScheduleTaskViewLike[];
  }>>;
  history(req: RpcRequestLike<{
    sessionId: string;
    id: string;
    limit: number;
    before?: string;
  }>): Promise<RpcResponseLike<{
    sessionId: string;
    history: ScheduleHistoryViewLike;
  }>>;
  create(req: RpcRequestLike<{
    sessionId: string;
    title: string;
    prompt: string;
    [key: string]: unknown;
  }>): Promise<RpcResponseLike<ScheduleTaskViewLike>>;
  update(req: RpcRequestLike<{
    sessionId: string;
    id: string;
    expected: unknown;
    title?: string;
    prompt?: string;
    change?: unknown;
  }>): Promise<RpcResponseLike<{
    id: string;
    updated: boolean;
    record?: ScheduleTaskViewLike;
    code?: string;
  }>>;
  delete(req: RpcRequestLike<{
    sessionId: string;
    id: string;
  }>): Promise<RpcResponseLike<{
    id: string;
    deleted: boolean;
    code?: string;
  }>>;
}
interface HostApiLike {
  listDirectory?(req: RpcRequestLike<{
    path?: string;
  }>, signal?: AbortSignal): Promise<RpcResponseLike<DirectoryListingLike>>;
  pickDirectory?(req: RpcRequestLike<Record<string, never>>, signal?: AbortSignal): Promise<RpcResponseLike<{
    path: string | null;
  }>>;
}
interface WorkspaceViewLike {
  workspaceId: string;
  path: string;
  title: string;
  sessionIds: string[];
  createdAt?: string;
  updatedAt?: string;
}
interface DirectoryEntryLike {
  name: string;
  path: string;
  hidden: boolean;
}
interface DirectoryListingLike {
  path: string;
  home: string;
  crumbs: DirectoryEntryLike[];
  entries: DirectoryEntryLike[];
  truncated: boolean;
}
interface HostModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
interface HostSessionModels {
  current: HostModelSelection;
  routable: boolean;
  groups: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      description?: string;
      reasoning?: {
        efforts: Array<{
          id: string;
          name: string;
          description?: string;
        }>;
        defaultEffort?: string;
      };
    }>;
  }>;
  failures: Array<{
    id: string;
    name: string;
    message: string;
  }>;
}
/**
 * Bridge 方法的结果。失败直接携带 wire 错误码（error vocabulary 见
 * wire-errors.ts）：调用方（wire-registry 的行）原样透给手机，不再经过
 * kind 中间层翻译。
 */
type ModelBridgeResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  code: WireErrorCode;
  message: string;
};
type SessionManagementResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  code: WireErrorCode;
  message: string;
};
interface PromptArgs {
  sessionId: string;
  mode: 'queue' | 'steer';
  content: Array<{
    type: 'text';
    text: string;
  } | {
    type: 'image';
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
    name?: string;
  }>;
  clientTimeZone?: string;
}
interface PhoneSessionRow {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  /** Host marks never-prompted sessions as blank; informational only — the
   * summary projects them as idle (see toSummary) so phones can send. */
  blank?: boolean;
  cwd?: string;
  origin?: string;
  parentSessionId?: string;
  projections?: {
    asOfSeq?: number;
    values?: Record<string, unknown>;
  };
}
interface HistoryResult {
  events: Array<{
    event: SessionEventLike;
    view?: unknown;
  }>;
  hasMore: boolean;
  projections?: {
    values?: Record<string, unknown>;
  };
}
interface SessionEventLike {
  type: string;
  seq: number;
  time?: number;
  data?: unknown;
}
interface MuxFrameLike {
  /** Internal Host identity hint; never serialized into the phone protocol. */
  isSubagent?: boolean;
  type: string;
  rpcId?: string;
  payload?: any;
  sessionId?: string;
  event?: SessionEventLike;
  key?: string;
  value?: unknown;
  approvalId?: string;
  callId?: string;
  toolName?: string;
  reason?: string;
  questions?: unknown;
  questionRpcId?: string;
  running?: boolean;
}
/**
 * apiProxy stream items are server-request envelopes: the frame lives in
 * `payload`, while the stable request id used to answer approval/question
 * waits lives beside it. Flattening only `payload` loses that id and makes
 * both interactions silently disappear.
 */
interface ApiStreamItemLike {
  rpcId?: string;
  payload: MuxFrameLike;
}
interface ApiProxyLike {
  sessions: SessionsApiLike;
  workspace?: WorkspaceApiLike;
  schedule?: ScheduleApiLike;
  host?: HostApiLike;
  respond(message: {
    type: 'client-response';
    rpcId: string;
    result: RpcResult<unknown>;
  }): Promise<{
    accepted: boolean;
    reason?: string;
  }>;
  events: {
    mux(req: RpcRequestLike<Record<string, never>>, signal: AbortSignal): AsyncIterable<MuxFrameLike | ApiStreamItemLike>;
    host(req: RpcRequestLike<Record<string, never>>, signal: AbortSignal): AsyncIterable<MuxFrameLike | ApiStreamItemLike>;
  };
}
/**
 * Outcome of answering a pending approval/question. The host distinguishes
 * "never/no longer pending" from "payload rejected", and collapsing both into
 * a boolean made every rejection read as `question not pending` on the phone.
 */
type PendingResponseOutcome = {
  ok: true;
} | {
  ok: false;
  reason: 'not-pending' | 'bad-response' | 'transport';
};
/** Downward sink every connected phone registers (one per WebSocket). */
interface BridgeSink {
  push(type: string, payload: unknown, seq?: number): void;
  lastCursor(): number;
  replay(entries: Array<{
    seq: number;
    type: string;
    payload: unknown;
  }>): void;
  replayDone(): void;
  resync(): void;
  /**
   * S→C permission gate (R1/P2): whether this sink may receive broadcast or
   * replayed frames that require `scope`. The bridge consults this before
   * every push/replay delivery; unknown broadcast types are denied.
   */
  canReceive(scope: DeviceScope): boolean;
}
/**
 * Offline push fan-out (F-9 离线推送). The bridge forwards every
 * notification-worthy event here; the outlet decides which paired devices
 * (token holders without a live socket) receive an APNs delivery.
 */
interface PushOutlet {
  fanOut(notification: PushNotification): void;
  widgetChanged?(): void;
  liveActivityChanged?(sessions: SessionSummary[]): void;
  /**
   * Whether offline push is currently configured and usable. Drives the
   * welcome capability bit: advertising push while no APNs credentials are
   * loaded would make clients suppress their own local banners and lose
   * notifications entirely.
   */
  isAvailable(): boolean;
}
//#endregion
//#region src/document-payload.d.ts
interface PromptDocument {
  name: string;
  mediaType: string;
  text: string;
  truncated?: boolean;
}
//#endregion
//#region src/host-bridge.d.ts
/**
 * 失败结果直接携带 wire 错误码（error vocabulary 见 wire-errors.ts）。
 *
 * 迁移前这里有 kind 中间层（'not-found' | 'busy' | 'conflict' | 'invalid'…），
 * 由 5 个映射函数在「Host code ↔ kind ↔ E_*」之间来回翻译，其中
 * E_BUSY→conflict→E_BUSY 的往返已证明有损。现在每个域查一次表，调用方拿到的
 * 就是手机上会看到的错误码。
 */
type ScheduleBridgeResult<T> = {
  ok: true;
  value: T;
  replayed?: boolean;
} | {
  ok: false;
  code: WireErrorCode;
  message: string;
  replayed?: boolean;
};
declare class HostBridge {
  private readonly apiProxy;
  private readonly historyBufferMax;
  /** 三个 journal 的落盘失败诊断输出；缺省即静默。不打任何消息体。 */
  private readonly log?;
  readonly id: number;
  private summaries;
  private activeTools;
  private approvals;
  private questions;
  private archivedSessionIds;
  /** Mirrors archived rows from the last sessions.list so the phone can browse
   * and restore them. Excluded from `summaries` and from the live broadcast. */
  private archivedSummaries;
  private subagentSessionIds;
  private sinks;
  private ring;
  private cursor;
  private userReceiptSeq;
  private abort;
  private started;
  private disposed;
  readonly promptDeliveries: DispatchJournal<{
    sessionId: string;
    content: unknown;
  }, DeliveryReceipt>;
  readonly scheduleMutations: DispatchJournal<unknown, MutationDispatchResult<unknown>>;
  readonly forkMutations: DispatchJournal<unknown, MutationDispatchResult<unknown>>;
  constructor(apiProxy: ApiProxyLike, historyBufferMax?: number, deliveryJournalPath?: string, scheduleJournalPath?: string, forkJournalPath?: string,
  /** 三个 journal 的落盘失败诊断输出；缺省即静默。不打任何消息体。 */
  log?: ((message: string) => void) | undefined);
  private pushOutlet;
  private widgetFingerprint;
  /**
   * Wire the offline-push fan-out. Present ⇒ welcome advertises the `push`
   * capability and notify-worthy events are mirrored to APNs.
   */
  setPushOutlet(outlet: PushOutlet | undefined): void;
  /**
   * welcome 能力位。委托 host-capabilities.ts 的探测表：此前同一条事实在这里
   * 和各方法体内各存一份，已经漂移过两次（models 位过严、schedules 位与
   * schedule 方法的探测不同源）。
   */
  get capabilities(): WelcomeCapabilities;
  diagnostic(message: string): void;
  currentCursor(): number;
  addSink(sink: BridgeSink): void;
  removeSink(sink: BridgeSink): void;
  /** Whether the ring still holds everything after the cursor. */
  canResumeFrom(cursor: number): boolean;
  private sinkSessions;
  private lastAssistantText;
  /** Mark a sink as actively viewing a session (suppresses its turn notifications). */
  markSinkOpen(sink: BridgeSink, sessionId: string): void;
  markSinkClosed(sink: BridgeSink, sessionId: string): void;
  dropSinkSessions(sink: BridgeSink): void;
  private isViewedBy;
  /** F-9: when a notification-worthy event fires, mirror it to every
   *  online device that is not currently viewing the session (the s2c.notify
   *  frame counts toward the seq cursor and joins the replay ring per
   *  PROTOCOL §6 + §7), then fan the same payload out to offline devices
   *  holding an APNs token. */
  private emitNotify;
  /** F-9: when a turn completes, notify every device not viewing the session. */
  private emitTurnCompletedNotify;
  /**
   * Mirror one notification-worthy event to offline devices. Fire-and-forget:
   * push failures must never block or break the WS data plane.
   */
  private fanOutPush;
  /** Remember the latest assistant text so notifications can quote it. */
  private captureAssistantText;
  /**
   * Replay buffered pushes after the given cursor; false when the gap is
   * unrecoverable. Frames go to `target` only — replaying into every sink
   * duplicated the whole window onto devices that never asked for it.
   * Each frame is filtered by the S→C permission policy per sink, so a
   * reader without interactions.respond never gets the missed approval
   * frames back (R1/P2).
   */
  resumeFrom(cursor: number, target?: BridgeSink): boolean;
  refreshLiveActivities(): void;
  private record;
  /** Start consuming host + mux streams. Idempotent; aborts on dispose(). */
  start(): void;
  dispose(): void;
  private runHostStream;
  private runMuxStream;
  private onHostFrame;
  private onMuxFrame;
  refreshSummaries(): Promise<void>;
  /** Cold sessions may lack a title projection; fall back to first user text. */
  private deriveTitleFallback;
  private captureActivity;
  private noteActivity;
  private applyProjection;
  private bumpPendingFlags;
  private pushSummary;
  listSessions(): SessionSummary[];
  /**
   * Archived rows from the last sessions.list, newest first. Served only on
   * demand so the live session list and its broadcast keep their shape for
   * clients that predate `c2s.sessions.archived`.
   */
  listArchivedSessions(): SessionSummary[];
  /**
   * Complete transient interaction state. Unlike the replay ring, this remains
   * authoritative after a long disconnect and is rehydrated by apiProxy's mux
   * stream when the bridge itself restarts.
   */
  pendingSnapshot(): PendingSnapshotPayload;
  /** Resolve only the exact invocation in this session; never guess from the latest tool. */
  private loadApprovalArguments;
  /** Tail history for an opened session; pushes s2c.session.tail to the sink. */
  openSession(sink: BridgeSink, sessionId: string, tailCount: number): Promise<boolean>;
  /**
   * Pull one session's projection baseline and fold every key
   * through applyProjection — unknown keys are ignored there, `null` means the
   * session no longer exists, and any failure degrades to a diagnostic: opening
   * a session must never fail because a baseline could not be read.
   */
  private refreshProjections;
  historyPage(sessionId: string, beforeSeq: number, limit: number): Promise<{
    sessionId: string;
    messages: MessageProjection[];
    hasMore: boolean;
  } | null>;
  /** Result of one attachment read-back for the phone. */
  attachmentData(sessionId: string, attachmentId: string): Promise<{
    mediaType?: string;
    data: string;
  } | null>;
  sessionModels(sessionId: string): Promise<ModelBridgeResult<HostSessionModels>>;
  selectSessionModel(sessionId: string, selection: HostModelSelection): Promise<ModelBridgeResult<HostModelSelection>>;
  renameSession(sessionId: string, title: string): Promise<SessionManagementResult<string>>;
  archiveSession(sessionId: string): Promise<SessionManagementResult<true>>;
  unarchiveSession(sessionId: string): Promise<SessionManagementResult<true>>;
  cancelSession(sessionId: string): Promise<SessionManagementResult<true>>;
  listWorkspaces(): Promise<SessionManagementResult<Array<{
    id: string;
    title: string;
    path: string;
    sessionIds: string[];
  }>>>;
  createWorkspace(path: string): Promise<SessionManagementResult<{
    workspace: {
      id: string;
      title: string;
      path: string;
      sessionIds: string[];
    };
    created: boolean;
  }>>;
  listDirectory(path?: string): Promise<SessionManagementResult<DirectoryListingLike>>;
  pickDirectory(): Promise<SessionManagementResult<string | null>>;
  /** Create a fresh blank session in an existing workspace or legacy cwd. */
  createSession(destination?: {
    workspaceId?: string;
    cwd?: string;
  }): Promise<string | null>;
  forkSession(deviceId: string, payload: {
    clientRequestId: string;
    sessionId: string;
    atSeq?: number;
  }): Promise<ScheduleBridgeResult<{
    sessionId: string;
  }>>;
  listSchedules(sessionId: string): Promise<ScheduleBridgeResult<ScheduleTaskViewLike[]>>;
  scheduleHistory(sessionId: string, id: string, limit: number, before?: string): Promise<ScheduleBridgeResult<ScheduleHistoryViewLike>>;
  createSchedule(deviceId: string, payload: Record<string, unknown> & {
    sessionId: string;
    clientRequestId: string;
    title: string;
    prompt: string;
  }): Promise<ScheduleBridgeResult<ScheduleTaskViewLike>>;
  updateSchedule(deviceId: string, payload: Record<string, unknown> & {
    sessionId: string;
    id: string;
    clientRequestId: string;
    expected: unknown;
  }): Promise<ScheduleBridgeResult<ScheduleTaskViewLike>>;
  deleteSchedule(deviceId: string, payload: {
    sessionId: string;
    id: string;
    clientRequestId: string;
  }): Promise<ScheduleBridgeResult<{
    id: string;
    deleted: true;
  }>>;
  sendPrompt(sessionId: string, text: string, images?: Array<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
    name?: string;
  }>, documents?: PromptDocument[]): Promise<SessionManagementResult<number>>;
  respondApproval(requestId: string, decision: 'allow' | 'deny', reason?: string): Promise<PendingResponseOutcome>;
  respondQuestion(requestId: string, answers: unknown): Promise<PendingResponseOutcome>;
}
//#endregion
//#region src/config.d.ts
interface Config {
  /** Master switch; when false the plugin activates and does nothing. */
  enabled?: boolean;
  /** Protocol-v2 device registry JSON path. */
  devicesPath?: string;
  /** Replay ring buffer bound (frames) per deployment. */
  historyBufferMax?: number;
  /** Testing & troubleshooting, rendered as its own settings section. */
  diagnostics?: {
    /** Verbose per-frame diagnostics (never prints token or message bodies). */
    debug?: boolean;
  };
  /** Independent LAN transport. Never exposes the wider DSH web server. */
  local?: {
    enabled?: boolean;
    port?: number;
  };
  /** Optional embedded remote transport. Reconciled when settings change. */
  remote?: {
    enabled?: boolean;
    provider?: 'tailscale-funnel';
    hostname?: string;
    statePath?: string;
    helperPath?: string;
    funnelPort?: 443 | 8443 | 10000;
    /** Concurrent Funnel WebSockets allowed from one public source address. */
    maxConnectionsPerSource?: number;
  };
  /**
   * Offline push (F-9). `apns` sends directly from the Mac with the user's
   * Apple credentials. `relay` sends notify projections to an operator-run
   * relay for distributed builds. The device reports its own APNs environment,
   * so development and TestFlight/App Store devices may coexist.
   */
  push?: {
    /** `none` (default), `apns`, or `relay`. */
    provider?: 'none' | 'apns' | 'relay';
    /** Generic mode removes conversation-derived titles and bodies before outbound push. */
    contentMode?: 'preview' | 'generic';
    /** Apple Developer team id (JWT iss claim). */
    teamId?: string;
    /** APNs auth key id (JWT kid header). */
    keyId?: string;
    /** `.p8` private key path. */
    keyPath?: string;
    /** App bundle id — the apns-topic header. */
    bundleId?: string;
    /** Relay base URL. */
    relayUrl?: string;
    /** Per-user bearer token issued by the relay operator. */
    relayToken?: string;
  };
}
declare const Config: z<Schemastery.ObjectS<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  devicesPath: z<string, string, "defined">;
  historyBufferMax: z<number, number, "defined">;
  diagnostics: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    debug: z<boolean, boolean, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    debug: z<boolean, boolean, "defined">;
  }>>>, "volatile-defined">;
  local: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    port: z<number, number, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    port: z<number, number, "defined">;
  }>>>, "volatile-defined">;
  remote: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    provider: z<"tailscale-funnel", "tailscale-funnel", "defined">;
    hostname: z<string, string, "defined">;
    statePath: z<string, string, "defined">;
    helperPath: z<string, string, "defined">;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000, "defined">;
    maxConnectionsPerSource: z<number, number, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    provider: z<"tailscale-funnel", "tailscale-funnel", "defined">;
    hostname: z<string, string, "defined">;
    statePath: z<string, string, "defined">;
    helperPath: z<string, string, "defined">;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000, "defined">;
    maxConnectionsPerSource: z<number, number, "defined">;
  }>>>, "volatile-defined">;
  push: z<Schemastery.ObjectS<NoInfer<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay", "defined">;
    contentMode: z<"generic" | "preview", "generic" | "preview", "defined">;
    teamId: z<string, string, "defined">;
    keyId: z<string, string, "defined">;
    keyPath: z<string, string, "defined">;
    bundleId: z<string, string, "defined">;
    relayUrl: z<string, string, "defined">;
    relayToken: z<string, string, "defined">;
  }>>, Schemastery.ObjectT<NoInfer<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay", "defined">;
    contentMode: z<"generic" | "preview", "generic" | "preview", "defined">;
    teamId: z<string, string, "defined">;
    keyId: z<string, string, "defined">;
    keyPath: z<string, string, "defined">;
    bundleId: z<string, string, "defined">;
    relayUrl: z<string, string, "defined">;
    relayToken: z<string, string, "defined">;
  }>>, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  enabled: z<boolean, boolean, "volatile-defined">;
  devicesPath: z<string, string, "defined">;
  historyBufferMax: z<number, number, "defined">;
  diagnostics: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    debug: z<boolean, boolean, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    debug: z<boolean, boolean, "defined">;
  }>>>, "volatile-defined">;
  local: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    port: z<number, number, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    port: z<number, number, "defined">;
  }>>>, "volatile-defined">;
  remote: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    provider: z<"tailscale-funnel", "tailscale-funnel", "defined">;
    hostname: z<string, string, "defined">;
    statePath: z<string, string, "defined">;
    helperPath: z<string, string, "defined">;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000, "defined">;
    maxConnectionsPerSource: z<number, number, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    provider: z<"tailscale-funnel", "tailscale-funnel", "defined">;
    hostname: z<string, string, "defined">;
    statePath: z<string, string, "defined">;
    helperPath: z<string, string, "defined">;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000, "defined">;
    maxConnectionsPerSource: z<number, number, "defined">;
  }>>>, "volatile-defined">;
  push: z<Schemastery.ObjectS<NoInfer<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay", "defined">;
    contentMode: z<"generic" | "preview", "generic" | "preview", "defined">;
    teamId: z<string, string, "defined">;
    keyId: z<string, string, "defined">;
    keyPath: z<string, string, "defined">;
    bundleId: z<string, string, "defined">;
    relayUrl: z<string, string, "defined">;
    relayToken: z<string, string, "defined">;
  }>>, Schemastery.ObjectT<NoInfer<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay", "defined">;
    contentMode: z<"generic" | "preview", "generic" | "preview", "defined">;
    teamId: z<string, string, "defined">;
    keyId: z<string, string, "defined">;
    keyPath: z<string, string, "defined">;
    bundleId: z<string, string, "defined">;
    relayUrl: z<string, string, "defined">;
    relayToken: z<string, string, "defined">;
  }>>, "defined">;
}>>, "plain">;
//#endregion
//#region src/push-policy.d.ts
/** Prune only when the provider supplies an authoritative token-lifecycle verdict. */
declare function shouldPrunePushToken(outcome: 'sent' | 'invalid-token' | 'failed', reason?: string): boolean;
/** APNs requires both registration and the same content permission as WS. */
declare function mayReceivePush(device: {
  scopes?: readonly string[];
}, notification: unknown): boolean;
/**
 * Zero-touch relay self-heal: HTTP 401 means the relay no longer honors the
 * cached credential. Only auto-enrolled cells with a still-current token may
 * re-derive it; an explicitly configured relay token remains user-owned
 * configuration and is never silently rewritten.
 */
declare function shouldReEnrollRelayToken(transport: 'apns' | 'relay', outcome: 'sent' | 'invalid-token' | 'failed', reason: string | undefined, opts: {
  usedCellToken: boolean;
  hasEnrollKey: boolean;
  tokenStillCurrent: boolean;
}): boolean;
//#endregion
//#region src/index.d.ts
/**
 * dsh-deeppilot — data bridge between the DSH host and DeepPilot
 * clients. Owns independent, narrowly routed LAN (TLS-only, pinned by paired
 * devices) and loopback Funnel-origin listeners. The web UI and the rest of
 * DSH's API are never exposed by these listeners.
 *
 * Data plane: an in-process HostBridge consumes a local adapter over DSH
 * Session/Workspace controllers, mirrors session summaries,
 * tracks pending approvals/questions, and fans projected protocol-v2 pushes
 * out to every connected device.
 *
 * Protocol: PROTOCOL.md is normative; src/protocol.ts and the private app's
 * Swift models mirror that v2 contract.
 */
declare const name = "deeppilot";
/** No web-service requirement: the plugin owns its own transport listeners. */
declare const inject: string[];
declare function apply(ctx: Context, options: unknown): void;
//#endregion
export { Config, HostBridge, apply, inject, mayReceivePush, name, shouldPrunePushToken, shouldReEnrollRelayToken };
//# sourceMappingURL=index.d.ts.map