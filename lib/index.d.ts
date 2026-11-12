import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
/**
 * 输入框 `@` 引用候选（PROTOCOL.md「输入框引用扩展」）。
 *
 * 数据来源都是 DSH 官方 Remote，经 `typertGateway` 以 owner 身份调用，与 Web 端同一条发现链路：
 * - 文件：`fileReferences/list {agentId, query}` → `[{path, kind}]`，由主机挂载的提供方
 *   （如 `dsh-file-reference-local`）在该会话工作目录里排序给出。只给路径，不读文件内容。
 * - 会话：`sessionReferenceResolver/candidates {agentId, query}` → 带规范 mention
 *   `@[label](dsh-session:…)` 的候选；手机发送时原样放进提示词，主机负责改写与注入快照。
 *
 * 两类服务都是可选挂载（兼容下限 0.2.1-rc.5 没有保证），所以每次按当前服务是否存在判定，
 * 一类缺席不影响另一类。会话候选不下发工作目录，只给 `sameWorkspace`，避免把本机路径带到手机。
 */
interface FileReferenceItem {
  path: string;
  kind: 'file' | 'directory';
}
interface SessionReferenceItem {
  sessionId: string;
  label: string;
  mention: string;
  sameWorkspace: boolean;
}
interface ReferenceSource<T> {
  available: boolean;
  items: T[];
}
interface ReferenceCandidates {
  files: ReferenceSource<FileReferenceItem>;
  sessions: ReferenceSource<SessionReferenceItem>;
}
declare const DEVICE_SCOPES: readonly ['sessions.read', 'prompt.send', 'sessions.manage', 'interactions.respond', 'notifications.register', 'schedule.manage', 'preview.open', 'hostweb.open'];
type DeviceScope = (typeof DEVICE_SCOPES)[number];
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
  readonly E_STEER_UNAVAILABLE: 'queued item can no longer steer the current turn';
  readonly E_TOO_LARGE: 'response exceeds the client frame limit';
};
type WireErrorCode = keyof typeof ERROR_CODES;
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
interface CommandSummary {
  name: string;
  description: string;
  definitionId?: string;
  input?: {
    hint: string;
    attachments?: boolean;
  };
}
interface CommandCatalog {
  commands: CommandSummary[];
  permissions: boolean;
  export: boolean;
}
interface CommandExecution {
  commandId: string;
  result: {
    kind: 'success' | 'error';
    text?: string;
    sourceEventSeq?: number;
  };
}
interface CommandAttachment {
  type: 'image' | 'document';
  name: string;
  mediaType: string;
  data: string;
}
interface PermissionOption {
  value: string;
  name: string;
  description?: string;
  confirmation: boolean;
}
interface PermissionCatalog {
  options: PermissionOption[];
  currentValue?: string;
}
/**
 * `format` 缺省为 `zip`，与扩展出现前的行为逐字节相同；`markdown` 需要
 * `welcome.capabilities.sessionMarkdown`，否则 Bridge 回 E_UNSUPPORTED。
 * 不认识该字段的旧 Bridge 会忽略它并照常返回 ZIP，所以客户端必须先看能力位。
 */
type SessionExportFormat = 'zip' | 'markdown';
/** `at` 的本地日历写法；与 DSH `LocalAtInput` 一一对应。 */
interface HostScheduleLocalAt {
  date: string;
  time: string;
  time_zone: string;
}
type HostScheduleTiming = {
  kind: 'after';
  after_seconds: number;
} | {
  kind: 'at';
  at: string | HostScheduleLocalAt;
} | {
  kind: 'every';
  every_seconds: number;
} | {
  kind: 'daily';
  daily: {
    time: string;
    time_zone: string;
  };
} | {
  kind: 'weekly';
  weekly: {
    time: string;
    time_zone: string;
    weekdays: number[];
  };
} | {
  kind: 'cron';
  cron: {
    expression: string;
    time_zone: string;
  };
} | {
  kind: 'rrule';
  rrule: string;
};
/** `new_once` / `new` 目标建会话时的工作目录与预设（省略用 Host 默认）。 */
interface HostScheduleCreateSpec {
  cwd?: string;
  agentPreset?: string;
}
/**
 * 任务视图里的交付目标。`new_once` 的 `sessionId` 是 Host 创建时预留的会话，
 * 首次投递后目标会转成 `session`。
 */
type HostScheduleTarget = {
  kind: 'session';
  sessionId: string;
} | {
  kind: 'new_once';
  sessionId: string;
  create?: HostScheduleCreateSpec;
} | {
  kind: 'new';
  create?: HostScheduleCreateSpec;
};
/**
 * 创建/编辑请求里客户端可给出的目标：`new_once` 的会话由 Host 预留，客户端不填
 * `sessionId`。
 */
type HostScheduleTargetRequest = {
  kind: 'session';
  sessionId: string;
} | {
  kind: 'new_once';
  create?: HostScheduleCreateSpec;
} | {
  kind: 'new';
  create?: HostScheduleCreateSpec;
};
/** 最近一次已确认投递的回执；不含 prompt 正文。 */
interface HostScheduleDeliveryReceipt {
  scheduledAt: string;
  deliveredAt: string;
  messageId: string;
  targetSessionId: string;
}
/**
 * 宿主级任务视图。可选字段（createdAt/updatedAt/executionActive/
 * deliveryFloorEndsAt/lastDelivery）客户端不得依赖；`involvedSessionIds` 是
 * Host 内部字段，Bridge 不返回。
 */
interface HostScheduleTask {
  id: string;
  title: string;
  prompt: string;
  timing: HostScheduleTiming;
  target: HostScheduleTarget;
  status: 'active' | 'paused' | 'ended';
  scheduledAt: string;
  createdAt?: string;
  updatedAt?: string;
  executionActive?: boolean;
  deliveryFloorEndsAt?: string;
  lastDelivery?: HostScheduleDeliveryReceipt;
}
/** 编辑补丁：至少一个字段；省略的字段保持原值。 */
interface HostSchedulePatch {
  title?: string;
  prompt?: string;
  timing?: HostScheduleTiming;
  target?: HostScheduleTargetRequest;
  /** false 暂停、true 恢复。 */
  active?: boolean;
}
interface WelcomeCapabilities {
  /** Authoritative goal summaries and goal-scoped Live Activities. Missing/false means unsupported. */
  goalView?: boolean;
  /** Goal completion notices and c2s.push.register preferences are implemented by this bridge. */
  goalNotifications?: boolean;
  /** 会话命令目录、执行、权限与原生日志导出入口。缺省不支持。 */
  commands?: boolean;
  /** 输入框 `@` 引用候选：c2s.session.references 可用（文件或会话引用至少一类）。缺省不支持。 */
  references?: boolean;
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
  /** Session-scoped user-invocable skill metadata and invalidation notices. */
  skills?: boolean;
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
  /** 宿主级计划任务模型（DSH 0.2.2-alpha.3 起）：true 时
   * 「Schedule 宿主级任务扩展」帧可用，schedulesHost=false/缺失时客户端只能
   * 使用会话级 schedule 帧。与 `schedules` 相互独立（后者只表示服务存在）。 */
  schedulesHost?: boolean;
  /** Bridge has APNs configured; clients may send c2s.push.register. */
  push?: boolean;
  widgetPush?: boolean;
  liveActivityPush?: boolean;
  /** Bridge accepts c2s.device.revoke, letting a client unbind itself before
   * deleting its local credentials. Absent on older bridges; older clients
   * ignore the extra field. */
  deviceRevoke?: boolean;
  /** Host exposes DSH session.updateQueue and the inbox projection: running
   * sessions accept mode:"steer", s2c.session.queue snapshots are pushed and
   * c2s.session.queue.update is served. Absent ⇒ running sessions only stop. */
  promptQueue?: boolean;
  /** Bridge pushes s2c.session.delta while a turn runs: transient assistant and
   * reasoning increments that never occupy a replay seq. Absent ⇒ the client
   * keeps the old "text appears when the step lands" rendering. */
  assistantStream?: boolean;
  /** Bridge serves c2s.session.export with format:"markdown" (the host's
   * /api/session.markdown route). Absent ⇒ only the ZIP archive is available. */
  sessionMarkdown?: boolean;
  /** Bridge serves c2s.plugin.update.check / c2s.plugin.update.apply, letting
   * the phone replace this plugin with a published version. Absent ⇒ the phone
   * can only link out to npm. */
  pluginUpdate?: boolean;
  /** Bridge answers c2s.session.export / c2s.session.attachment requests that
   * carry `binary: true` with binary frames (raw bytes after a JSON header,
   * see binary-frame.ts). Plugin-level, independent of the host. Absent ⇒ the
   * client must keep requesting base64 text frames. */
  binaryFrames?: boolean;
  /** Bridge honours `watchSessions` on c2s.auth.prove and c2s.session.watch:
   * a connection that declared an interest set only receives
   * s2c.session.event / s2c.session.queue (live and replayed) for sessions it
   * opened or watches. Plugin-level. Absent ⇒ the client gets every
   * session's events, as before. */
  sessionInterest?: boolean;
  /** Bridge compresses downlink frames over 8 KB as binary format 2
   * (`[2][deflate-raw(envelope JSON)]`) once the client listed "deflate-raw"
   * in `acceptEncoding` on c2s.auth.prove. Plugin-level. Absent ⇒ the field is
   * ignored and every JSON frame stays a text frame. */
  compressedFrames?: boolean;
  /** Bridge answers c2s.session.open carrying `sinceSeq` with an incremental
   * tail (`incremental: true`) holding only rows changed after that seq, or
   * with a full tail when it cannot prove the delta complete. Plugin-level. */
  incrementalTail?: boolean;
  /** Bridge includes `routes` (current LAN endpoints with their certificate
   * fingerprint, and the public Funnel URL) in s2c.welcome so the client can
   * prefer the LAN on the same network and fall back to Funnel elsewhere.
   * Plugin-level. */
  routeHints?: boolean;
  /** Bridge accepts a `clientRole: "preview"` connection and the c2s.preview.*
   * frames that tunnel the phone's loopback TCP connections to the computer's
   * loopback address (PROTOCOL.md「本机预览扩展」). Plugin-level; stays true
   * when the settings switch is off (requests then fail with reason
   * "disabled"). */
  localPreview?: boolean;
  /** Bridge accepts c2s.preview.hostWeb on a preview connection: it returns a
   * one-time login URL for the DSH Web UI on the computer's loopback address,
   * so the phone can open the whole Web UI (third-party plugin pages
   * included) through the preview tunnel (PROTOCOL.md「电脑端网页」).
   * Plugin-level; stays true when the settings switch is off (requests then
   * fail with reason "hostweb-disabled"). */
  hostWeb?: boolean;
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
interface SessionGoal {
  id: string;
  revision: number;
  objective: string;
  phase: 'active' | 'paused' | 'blocked' | 'complete';
  /** Process-local eligibility, independent of durable phase or session running status. */
  activation?: 'armed' | 'disarmed';
  roundsStarted: number;
  maxGoalRounds: number;
  createdAt: number;
  updatedAt: number;
  blockedReason?: {
    code: string;
    message: string;
  };
}
/**
 * Context-window occupancy mirrored from the Host's `contextPressure` and
 * `contextBreakdown` projections (dsh-token-meter). Every field is optional:
 * a value is present only when the Host reported it, and an absent value is
 * unknown, never zero. Only sessions the Bridge has opened or seen change
 * carry it — the session list itself does not include these projections.
 */
interface SessionContextUsage {
  /** Provider-reported prompt size of the most recent request. */
  pressureTokens?: number;
  /** Host estimate of the next request's prompt size. */
  projectedTokens?: number;
  /** Newest recorded route capacity. */
  contextWindow?: number;
  /** Heuristic composition of the next request. The three figures do not sum
   * to `projectedTokens` and must be presented as approximate shares only. */
  breakdown?: {
    systemTokens: number;
    toolsTokens: number;
    messageTokens: number;
  };
  /** True when the capacity changed after the last usage sample (typically a
   * model switch): the sample and the capacity belong to different routes, so
   * clients must not derive an occupancy ratio from them. */
  capacityChanged?: boolean;
}
interface SessionSummary {
  /** Omitted when unsupported/unknown; null explicitly clears a previously projected goal. */
  goal?: SessionGoal | null;
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
  /** Optional context-window occupancy (see SessionContextUsage). Absent for
   * hosts without the token-meter projections and for sessions the Bridge has
   * not opened; clients must tolerate its absence. */
  context?: SessionContextUsage | null;
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
/**
 * 文件编辑类工具调用的改动内容（v2 追加式扩展，见 PROTOCOL.md「工具改动对比」）。
 * Bridge 把宿主 `edit`（old_string/new_string）、`write`（content）与 `str_replace_editor`
 * （old_str/new_str/file_text/insert_line）的参数名归一化成这里的字段，手机端不依赖宿主工具参数命名。`oldText` / `newText` 各自超过
 * 16 KiB（UTF-8）时都不发，只带 `truncated: true`。
 */
interface ToolEditProjection {
  path: string;
  operation: 'replace' | 'create' | 'insert';
  oldText?: string;
  newText?: string;
  /** `insert` 专用：在该行之后插入，0 表示文件开头。 */
  insertLine?: number;
  truncated?: boolean;
}
/**
 * 工具调用的操作对象（v2 追加式扩展，见 PROTOCOL.md「Message 投影 · tool.target」）。
 * Bridge 从宿主工具参数里挑出「对什么做」：文件路径、命令、搜索式、网址或其他对象名，
 * 参数名不外泄。工具结果合并回调用行后 `summary` 会被结果摘要替换，`target` 保留，
 * 客户端据此在调用完成后仍能显示「读取 A.swift」而不是文件正文片段。
 * `kind` 是开放词表：客户端遇到未知值按 `text` 处理。
 */
interface ToolTargetProjection {
  kind: 'path' | 'command' | 'pattern' | 'url' | 'text';
  /** 主值；UTF-8 上限 1 KiB。路径超长时砍开头（保留文件名），其余砍结尾加「…」。 */
  value: string;
  /** 范围：搜索所在目录（`pattern` 专用）；UTF-8 上限 1 KiB，规则同路径。 */
  scope?: string;
  /** 宿主给的人类可读说明（如 bash 的 description）；UTF-8 上限 256 B。 */
  label?: string;
}
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
    edit?: ToolEditProjection;
    target?: ToolTargetProjection;
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
/** Metadata only: loading instructions remains the Host's responsibility. */
interface SkillSummary {
  name: string;
  description: string;
  modelInvocable: boolean;
}
type NotifyCategory = 'turn.completed' | 'goal.completed' | 'approval.required' | 'question.asked' | 'session.error';
/**
 * One offline-push-worthy event (same facts as s2c.notify / pending frames,
 * projected for APNs). The bridge fans these out to paired devices that hold
 * an APNs token and no live WebSocket.
 */
interface PushNotification {
  /** Absent preserves legacy default sound; false omits aps.sound in either transport. */
  soundEnabled?: boolean;
  hostAudience?: string;
  notificationId: string;
  category: NotifyCategory;
  sessionId: string;
  title: string;
  body: string;
  /** Same optional approval-only fields as NotifyPayload; dropped in `generic` content mode. */
  toolName?: string;
  detail?: string;
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
/**
 * 宿主持久化图片引用（ImageAttachmentRef）的原样对象。
 *
 * 只要求 `attachmentId`；其余字段（mediaType/bytes/width/height/name/
 * originalDimensions…）由宿主生成、由宿主读取时自行核对，这里原样保留、不做
 * 字段裁剪，免得宿主以后新增必填字段时被插件悄悄丢掉。
 */
type HostImageRef = Readonly<Record<string, unknown> & {
  attachmentId: string;
}>;
interface CommandsApiLike {
  list(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<CommandCatalog>>;
  execute(req: RpcRequestLike<{
    sessionId: string;
    line: string;
    attachments: CommandAttachment[];
    expectedDefinitionId?: string;
  }>): Promise<RpcResponseLike<CommandExecution>>;
  permissions(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<PermissionCatalog>>;
  feedback(req: RpcRequestLike<{
    sessionId: string;
    text: string;
    category?: string;
  }>): Promise<RpcResponseLike<void>>;
  readonly markdownAvailable?: boolean;
  export(req: RpcRequestLike<{
    sessionId: string;
    format?: SessionExportFormat;
  }>, signal: AbortSignal): Promise<Response>;
}
/** 输入框 `@` 引用候选（文件 + 会话），见 reference-api.ts。 */
interface ReferencesApiLike {
  list(req: RpcRequestLike<{
    sessionId: string;
    query: string;
  }>, signal?: AbortSignal): Promise<RpcResponseLike<ReferenceCandidates>>;
}
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
  skills?(req: RpcRequestLike<{
    sessionId: string;
  }>): Promise<RpcResponseLike<{
    skills: SkillSummary[];
  }>>;
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
  /**
   * Reads one durable image back. DSH ≤ 0.2.1 reads `attachmentId` and checks the
   * session log itself; DSH 0.2.2+ reads the full `attachment` reference and no
   * longer checks the session, so HostBridge sends both and only supplies a
   * reference it saw projected in that session.
   */
  attachment?(req: RpcRequestLike<{
    sessionId: string;
    attachmentId: string;
    attachment?: HostImageRef;
  }>): Promise<RpcResponseLike<{
    attachment: {
      mediaType?: string;
    };
    data: string;
  }>>;
  /** Remove or steer one pending inbox item. Absent on hosts without the
   * DSH session.updateQueue RPC; the promptQueue capability bit probes it. */
  updateQueue?(req: RpcRequestLike<QueueUpdateArgs>): Promise<RpcResponseLike<{
    accepted: true;
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
/** 会话级 Schedule 服务（DSH ≤ 0.2.2-alpha.2）：任务绑定单一 Session。 */
interface LegacyScheduleApiLike {
  /** 判别位缺省即 legacy：旧宿主与既有测试夹具不必补字段。 */
  readonly mode?: 'legacy';
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
/** 宿主级任务视图：与 wire 的 `HostScheduleTask` 同一形状（Bridge 直接透传）。 */
type HostScheduleTaskView = HostScheduleTask;
interface HostScheduleListRequestLike {
  /** true 只列运行中；false 只列暂停/结束；省略列全部。 */
  active?: boolean;
  limit?: number;
  offset?: number;
}
interface HostScheduleListResultLike {
  tasks: HostScheduleTaskView[];
  shown: number;
  total: number;
  limit: number;
  offset: number;
}
/** 查看结果：命中或非变更 miss（Host 用 code 表示 miss，不是抛错）。 */
type HostScheduleViewOutcome = {
  kind: 'task';
  task: HostScheduleTaskView;
} | {
  kind: 'not-found';
  id: string;
};
/** 编辑结果：更新后的任务、已删除、miss，或乐观锁冲突（wire 上回 E_BUSY）。 */
type HostScheduleEditOutcome = {
  kind: 'task';
  task: HostScheduleTaskView;
} | {
  kind: 'deleted';
  id: string;
} | {
  kind: 'not-found';
  id: string;
} | {
  kind: 'conflict';
  id: string;
};
/** 手动执行结果：已投递、已有执行在进行中（E_BUSY），或目标已不存在。 */
type HostScheduleRunOutcome = {
  kind: 'task';
  task: HostScheduleTaskView;
} | {
  kind: 'pending';
  id: string;
} | {
  kind: 'not-found';
  id: string;
};
/** 清理已结束任务的结果：删除的条数（宿主上没有已结束任务时为 0）。 */
interface HostScheduleDeleteEndedResult {
  deleted: number;
}
interface HostScheduleLimitsView {
  /** 以新建会话方式投递的最小间隔秒数；客户端只展示，不自行节流。 */
  newSessionIntervalSeconds: number;
}
interface HostScheduleCreateRequestLike {
  title: string;
  prompt: string;
  timing: HostScheduleTiming;
  /** 省略时由 Host 默认：首次投递新建并复用会话。 */
  target?: HostScheduleTargetRequest;
}
type HostScheduleEditRequestLike = {
  id: string;
  action: 'update';
  patch: HostSchedulePatch;
  expectedUpdatedAt?: string | null;
} | {
  id: string;
  action: 'delete';
  expectedUpdatedAt?: string | null;
};
/**
 * 宿主级 Schedule 服务（DSH 0.2.2-alpha.3 起）。
 *
 * 探测只看形状：`edit` 存在且 `update` 不存在。`remoteXxx` 是同一服务的
 * 「人类 Remote 调用」变体（不记录 acting Session）；Bridge 就是人类 Remote
 * 调用方，因此直接用公开方法并省略 actorSessionId。
 */
interface HostScheduleApiLike {
  readonly mode: 'host';
  list(req: RpcRequestLike<HostScheduleListRequestLike>): Promise<RpcResponseLike<HostScheduleListResultLike>>;
  view(req: RpcRequestLike<{
    id: string;
  }>): Promise<RpcResponseLike<HostScheduleViewOutcome>>;
  create(req: RpcRequestLike<HostScheduleCreateRequestLike>): Promise<RpcResponseLike<HostScheduleTaskView>>;
  edit(req: RpcRequestLike<HostScheduleEditRequestLike>): Promise<RpcResponseLike<HostScheduleEditOutcome>>;
  run(req: RpcRequestLike<{
    id: string;
  }>): Promise<RpcResponseLike<HostScheduleRunOutcome>>;
  history(req: RpcRequestLike<{
    id: string;
    limit: number;
    before?: string;
  }>): Promise<RpcResponseLike<ScheduleHistoryViewLike>>;
  limits(req: RpcRequestLike<Record<string, never>>): Promise<RpcResponseLike<HostScheduleLimitsView>>;
  /** 删除宿主上全部 `status="ended"` 的任务；进行中与暂停的任务不受影响。 */
  deleteEnded(req: RpcRequestLike<Record<string, never>>): Promise<RpcResponseLike<HostScheduleDeleteEndedResult>>;
}
type ScheduleApiLike = LegacyScheduleApiLike | HostScheduleApiLike;
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
/** DSH session.updateQueue request; `edit` is reserved on the wire and never sent. */
interface QueueUpdateArgs {
  sessionId: string;
  itemId: string;
  action: {
    kind: 'remove';
  } | {
    kind: 'steer';
  };
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
  /** Host projection watermark for ordering live changes against asynchronous baselines. */
  seq?: number;
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
  /** Host has registered the goal summary projection and its passive baseline/live feed. */
  readonly goalViewAvailable?: boolean;
  /** 真实宿主反射声明了助手流帧时才为 true；旧代理缺省关闭。 */
  readonly assistantStreamAvailable?: boolean;
  commands?: CommandsApiLike;
  /** 主机挂载了文件引用或会话引用服务之一时存在；两者都缺席为 undefined。 */
  references?: ReferencesApiLike;
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
  /**
   * Interest filter (capability `sessionInterest`): whether this sink wants a
   * frame it is already permitted to receive. Connections that declared an
   * interest set drop other sessions' events here. Absent ⇒ wants everything.
   * The bridge consults it when sizing a replay window; sinks apply it again
   * on every push.
   */
  accepts?(type: string, payload: unknown): boolean;
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
interface QuietCompletionResult {
  suppressed: boolean;
  note?: string;
}
interface TurnVerdict {
  /** 本轮最近一条驱动消息是计划任务投递（且其后没有用户消息）。 */
  scheduled: boolean;
  /** 本轮 `turn/start` 的轮次号；日志里读不到时为 undefined。 */
  turn?: number;
}
declare class QuietCompletionTracker {
  /**
   * 判定过计划任务轮次的会话。粘性集合：加入后不再移除，工具不按轮出现或消失。
   * 宿主每次工具列表变化都会往会话追加一条工具增减消息并让提示词缓存失效，
   * 按轮开关会让同一会话反复产生这类消息。
   */
  private readonly scheduleSessions;
  private readonly quiet;
  /** 启动时用宿主任务列表里的投递目标会话预热，避免重启后工具先消失再出现。 */
  seed(sessionIds: Iterable<string>): void;
  isScheduleSession(sessionId: string): boolean;
  /** 加入粘性集合；返回是否为新加入（调用方据此记一次日志）。 */
  markScheduleSession(sessionId: string): boolean;
  /** 工具执行：只在计划任务轮次内生效。 */
  requestQuiet(sessionId: string | undefined, verdict: TurnVerdict, seq: number): QuietCompletionResult;
  /**
   * 桥接层观察到 user/message：用户在请求静默之后插话（日志位置更晚）就撤销静默，
   * 本轮照常提醒。计划任务与注入上下文不影响。
   */
  noteUserMessage(sessionId: string, sourceKind: string | undefined, seq: number | undefined): void;
  /**
   * turn.end 时调用。返回 true 表示本轮完成通知应被抑制：成功结束、且本轮请求过静默。
   * 轮次号能对上时按轮次号判定；迟到的上一轮 turn.end 保留本轮的请求。
   */
  consumeTurnEnd(sessionId: string, ok: boolean, turn: number | undefined, seq: number | undefined): boolean;
}
interface PromptDocument {
  name: string;
  mediaType: string;
  text: string;
  truncated?: boolean;
}
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
/**
 * 宿主级编辑（update / delete 合一的 `edit`）的 Bridge 结果值。
 *
 * 与 legacy 的 updated/deleted 两个独立帧结果分开表达，wire handler 用
 * `'deleted' in value` 落成 `deleted:true` 或 `task`。
 */
type HostScheduleEditValue = {
  task: HostScheduleTaskView;
} | {
  deleted: true;
  id: string;
};
export declare class HostBridge {
  private readonly apiProxy;
  private readonly historyBufferMax;
  /** 三个 journal 的落盘失败诊断输出；缺省即静默。不打任何消息体。 */
  private readonly log?;
  readonly id: number;
  private summaries;
  private readonly goals;
  /** 上下文占用不在会话列表的投影里，只来自单会话基线和实时变化；列表刷新会重建摘要，
   * 所以单独记住，重建后再挂回去。 */
  private readonly contexts;
  /**
   * 列表推送节流（连接传输第二批 P5）。每个会话最近一次推出去的摘要指纹，
   * 用来丢掉内容完全相同的重复推送；只改了 `stats` 的变化按 SUMMARY_STATS_THROTTLE_MS
   * 合并，状态、标题、任务清单、待处理标记、活动描述的变化照旧立即推。
   */
  private readonly summaryPushed;
  private readonly summaryStatsTimers;
  private activeTools;
  /** 会话在 llm/retry 退避等待期间的重试描述；新一轮、重试启动或新消息/工具到达时清除。 */
  private retryActivities;
  /** 最近一轮以非 completed 异常结束的会话；保持 status='error' 直到下一轮开始，防止随后的 running=false 覆盖回 idle。 */
  private failedSessionIds;
  private approvals;
  private questions;
  private archivedSessionIds;
  /** Mirrors archived rows from the last sessions.list so the phone can browse
   * and restore them. Excluded from `summaries` and from the live broadcast. */
  private archivedSummaries;
  private subagentSessionIds;
  /** 计划任务按需完成通知（quiet-completion.ts）：index.ts 用它注册 Agent 工具。 */
  readonly quietCompletion: QuietCompletionTracker;
  /**
   * 每个会话最近一次已知的队列（inbox 投影的折叠结果）及其指纹。来源是实时
   * 投影通知或打开会话时读到的基线；指纹用来丢掉内容没变的重复通知。
   */
  private queues;
  private sinks;
  private readonly assistantStream;
  private ring;
  private cursor;
  private userReceiptSeq;
  private abort;
  private started;
  private disposed;
  /** attachmentId → 宿主完整图片引用，供 attachmentData 补全 DSH 0.2.2+ 的读图参数。 */
  private readonly imageRefs;
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
  private hasStreamViewer;
  /** Instant publications bypass record(): no cursor, ring, notification or push side effect. */
  private pushAssistantDelta;
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
  /**
   * Remember the latest assistant text so notifications can quote it. 存完整原文：
   * 按字符数截尾会从链接地址中间切开（横幅只剩 URL 编码的路径），段落选择与
   * Markdown 清洗统一留到 emitNotify。条目随 sessions.list / 归档清理。
   */
  private captureAssistantText;
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
  resumeFrom(cursor: number, target?: BridgeSink): boolean;
  refreshLiveActivities(): void;
  private record;
  /** Start consuming host + mux streams. Idempotent; aborts on dispose(). */
  start(): void;
  /**
   * 用宿主任务列表里的投递目标会话预热计划任务会话集合，避免插件重启后工具
   * 先消失、等下一次投递再出现（每次变化都会给会话追加工具增减消息）。
   * `new` 目标没有固定会话，只能从最近一次投递回执里取。失败只记日志：集合仍会
   * 在下一次投递时补上。由 index.ts 在 schedule 服务就绪、注册工具时调用。
   */
  seedQuietCompletionSessions(): Promise<void>;
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
  /**
   * 折叠一次 inbox 投影。只有实时变化才广播 s2c.session.queue；基线只补缓存，
   * 打开会话的那台设备另由 pushQueueSnapshot 点对点拿到快照。
   *
   * 基线只补缺不覆盖：实时通知带的是完整投影值，收到过就以它为准；基线读取与
   * 实时变化并发时，较早算出的基线不得盖掉较新的实时值。
   */
  private applyInbox;
  /**
   * 打开会话时补发的快照：不占 seq，与 tail 同属打开响应。还没读到过该会话的
   * 投影（基线失败、Host 不提供或子代理会话）时不发，因为未知不等于空队列。
   */
  private pushQueueSnapshot;
  private applyProjection;
  private bumpPendingFlags;
  private pushSummary;
  private noteSummaryPushed;
  private forgetSummaryPush;
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
  openSession(sink: BridgeSink, sessionId: string, tailCount: number, sinceSeq?: number): Promise<boolean>;
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
  /**
   * 宿主调用抛出的意外错误。原文可能带着电脑上的路径或堆栈，只进电脑端日志；
   * 手机只收到一句固定文案（宿主以结果形式返回的业务错误另走 wireErrorOf，不经这里）。
   */
  private internalFailure;
  /**
   * 本机预览准入（PROTOCOL.md「本机预览扩展」）：会话最近 `maxMessages` 条消息里是否
   * 出现过 `needle`（形如 `127.0.0.1:4720`）。
   *
   * 直接在宿主原始事件的 JSON 上找子串，而不是在手机投影上找：链接可能出现在助手正文、
   * 工具输出或命令参数里，投影会裁剪其中一部分。`needle` 只含数字、点、冒号、方括号与
   * 字母，JSON 序列化不会转义它们。读取失败或会话不存在时返回 null（对应 reason
   * `session-not-found`），由调用方决定文案。
   */
  sessionMentions(sessionId: string, needle: string, maxMessages?: number): Promise<boolean | null>;
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
  attachmentData(sessionId: string, attachmentId: string): Promise<{
    mediaType?: string;
    data: string;
  } | null>;
  /** 图片引用回查用的原始历史页：只取事件，不投影、不推给手机。 */
  private readHistoryEvents;
  commandOperation(operation: 'list' | 'execute' | 'permissions' | 'feedback', payload: Record<string, unknown>): Promise<SessionManagementResult<unknown>>;
  /**
   * 输入框 `@` 引用候选。两类候选的单类失败已在 reference-api 内吸收为空列表，
   * 这里只处理「两类都不可用」与代理层意外异常。
   */
  referenceCandidates(sessionId: string, query: string, signal?: AbortSignal): Promise<SessionManagementResult<ReferenceCandidates>>;
  exportSession(sessionId: string, signal: AbortSignal, format?: SessionExportFormat): Promise<Response>;
  /** 由会话目录决定技能可见性；不读取正文，也不把本机路径发给移动端。 */
  sessionSkills(sessionId: string): Promise<SessionManagementResult<{
    skills: SkillSummary[];
  }>>;
  sessionModels(sessionId: string): Promise<ModelBridgeResult<HostSessionModels>>;
  selectSessionModel(sessionId: string, selection: HostModelSelection): Promise<ModelBridgeResult<HostModelSelection>>;
  renameSession(sessionId: string, title: string): Promise<SessionManagementResult<string>>;
  archiveSession(sessionId: string): Promise<SessionManagementResult<true>>;
  unarchiveSession(sessionId: string): Promise<SessionManagementResult<true>>;
  /**
   * 删除或转向一条排队项。ack 只表示 Host 已提交变更，真实状态以随后的
   * s2c.session.queue 为准；不做幂等，项已消失时 Host 回 queue-item-not-found。
   */
  updateQueue(sessionId: string, itemId: string, action: 'remove' | 'steer'): Promise<SessionManagementResult<{
    sessionId: string;
    itemId: string;
  }>>;
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
  /**
   * 当前 adapter 是否宿主级计划任务模型。
   *
   * 能力位 `schedulesHost`（host-capabilities.ts）与新帧、旧帧映射全部读这一个
   * 判别位：探测只发生一次（DshApiProxy.resolveSchedule），这里不再看控制器
   * 方法，也不看版本号字符串。
   */
  private get hostSchedule();
  listSchedules(sessionId: string): Promise<ScheduleBridgeResult<ScheduleTaskViewLike[]>>;
  /** 宿主级列表 -> 旧会话级视图：过滤 session 目标、丢弃 ended、按 scheduledAt 升序。 */
  private listHostSchedulesAsLegacy;
  listHostSchedules(request?: HostScheduleListRequestLike): Promise<ScheduleBridgeResult<HostScheduleListResultLike>>;
  viewHostSchedule(id: string): Promise<ScheduleBridgeResult<HostScheduleTaskView>>;
  createHostSchedule(deviceId: string, payload: Record<string, unknown> & {
    clientRequestId: string;
    title: string;
    prompt: string;
    timing: unknown;
    target?: unknown;
  }): Promise<ScheduleBridgeResult<HostScheduleTaskView>>;
  editHostSchedule(deviceId: string, payload: Record<string, unknown> & {
    clientRequestId: string;
    id: string;
    action: 'update' | 'delete';
    expectedUpdatedAt?: string | null;
    patch?: unknown;
  }): Promise<ScheduleBridgeResult<HostScheduleEditValue>>;
  runHostSchedule(deviceId: string, payload: {
    clientRequestId: string;
    id: string;
  }): Promise<ScheduleBridgeResult<HostScheduleTaskView>>;
  /**
   * 删除宿主上全部已结束（`status="ended"`）的任务，返回删除条数。
   *
   * 与其他变更帧共用 scheduleMutations journal：同一 clientRequestId 重放时直接回放
   * 首次结果，不会再删一次。成功后广播 `s2c.schedule.changed`；失败时同样广播——上游
   * 文档说明失败的批次无法确定哪些行已删除，客户端应重新读取列表。
   */
  deleteEndedHostSchedules(deviceId: string, payload: {
    clientRequestId: string;
  }): Promise<ScheduleBridgeResult<{
    deleted?: number;
  }>>;
  scheduleLimits(): Promise<ScheduleBridgeResult<{
    newSessionIntervalSeconds: number;
  }>>;
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
  }>, documents?: PromptDocument[], options?: {
    mode?: 'queue' | 'steer';
    clientSendId?: string;
  }): Promise<SessionManagementResult<number>>;
  respondApproval(requestId: string, decision: 'allow' | 'deny', reason?: string): Promise<PendingResponseOutcome>;
  respondQuestion(requestId: string, answers: unknown): Promise<PendingResponseOutcome>;
}
export interface Config {
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
  /**
   * 本机预览（能力 localPreview）：允许已配对手机经预览连接查看电脑回环地址上、
   * 且在会话消息里出现过的网页。默认开启；关闭后新请求回 reason "disabled"。
   */
  preview?: {
    enabled?: boolean;
    /**
     * 电脑端网页（能力 hostWeb）：允许已配对手机经预览连接打开电脑上的 DSH 网页端
     * （所有者权限，含第三方插件页面），并打开网页里出现的其他本机端口。默认关闭；
     * 还要求 `enabled` 为 true。关闭后请求回 reason "hostweb-disabled"，已开通道随即断开。
     */
    hostWeb?: boolean;
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
   * Offline push (F-9). `apns` sends directly from the computer with the user's
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
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
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
  preview: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    hostWeb: z<boolean, boolean, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    hostWeb: z<boolean, boolean, "defined">;
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
  preview: z<NoInfer<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    hostWeb: z<boolean, boolean, "defined">;
  }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    hostWeb: z<boolean, boolean, "defined">;
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
/** Prune only when the provider supplies an authoritative token-lifecycle verdict. */
export declare function shouldPrunePushToken(outcome: 'sent' | 'invalid-token' | 'failed', reason?: string): boolean;
/** APNs requires both registration and the same content permission as WS. */
export declare function mayReceivePush(device: {
  scopes?: readonly string[];
}, notification: unknown): boolean;
/**
 * Zero-touch relay self-heal: HTTP 401 means the relay no longer honors the
 * cached credential. Only auto-enrolled cells with a still-current token may
 * re-derive it; an explicitly configured relay token remains user-owned
 * configuration and is never silently rewritten.
 */
export declare function shouldReEnrollRelayToken(transport: 'apns' | 'relay', outcome: 'sent' | 'invalid-token' | 'failed', reason: string | undefined, opts: {
  usedCellToken: boolean;
  hasEnrollKey: boolean;
  tokenStillCurrent: boolean;
}): boolean;
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
export declare const name = "deeppilot";
/** No web-service requirement: the plugin owns its own transport listeners. */
export declare const inject: string[];
export declare function apply(ctx: Context, options: unknown): void;
export {};
//# sourceMappingURL=index.d.ts.map