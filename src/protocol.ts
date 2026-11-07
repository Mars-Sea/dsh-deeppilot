/**
 * DeepPilot Bridge Protocol v2 — shared frame vocabulary (TypeScript face).
 * The normative spec is PROTOCOL.md at the repo root; this module
 * mirrors it for the plugin implementation. The iOS app hand-mirrors the
 * same shapes in Swift.
 */

import type { DeviceScope } from './device-auth.ts'

export const PROTOCOL_VERSION = 2

export interface Envelope {
  v: number
  type: string
  /** Request correlation id; echoes on responses, absent on pushes. */
  id?: string
  /** Sender epoch ms. */
  ts?: number
  /** Server-wide monotonic cursor on s2c pushes only (replay support). */
  seq?: number
  payload?: unknown
}

// ---------- c2s payloads ----------

export interface AuthChallengePayload {
  nonce: string
  audience: string
  issuedAt: number
  expiresAt: number
}

export interface AuthProofPayload extends AuthChallengePayload {
  /** Optional short-lived read-only client, excluded from alert suppression. */
  clientRole?: 'widget'
  deviceId: string
  deviceName: string
  appVersion: string
  signature: string
  resumeCursor?: number
  /** 能力 `sessionInterest`：本机缓存、需保持最新的会话（最多 16 个）。不进签名原文。 */
  watchSessions?: string[]
  /** 能力 `compressedFrames`：可接受的下行压缩编码，目前只有 "deflate-raw"。不进签名原文。 */
  acceptEncoding?: string[]
}

/** Content-free WidgetKit invalidation; never a user-visible alert. */
export interface WidgetPushNotification {
  kind: 'widget'
}

export interface LiveActivityState {
  title: string
  task: string
  done: number
  total: number
  phase: 'running' | 'approval' | 'question' | 'ended' | 'failed' | 'unavailable'
}
export interface LiveActivityPushNotification {
  kind: 'liveactivity'
  event: 'update' | 'end'
  timestamp: number
  contentState: LiveActivityState
}
export interface LiveActivityRegisterPayload extends WidgetPushRegisterPayload {
  activityId: string
  sessionId: string
}
export interface LiveActivityUnregisterPayload { activityId: string }
export type PushDelivery = PushNotification | WidgetPushNotification | LiveActivityPushNotification

export interface SessionOpenPayload { sessionId: string; tailCount?: number }
export interface SessionClosePayload { sessionId: string }
export interface SessionHistoryPayload { sessionId: string; beforeSeq: number; limit: number }
/**
 * `format` 缺省为 `zip`，与扩展出现前的行为逐字节相同；`markdown` 需要
 * `welcome.capabilities.sessionMarkdown`，否则 Bridge 回 E_UNSUPPORTED。
 * 不认识该字段的旧 Bridge 会忽略它并照常返回 ZIP，所以客户端必须先看能力位。
 */
export type SessionExportFormat = 'zip' | 'markdown'
/** `binary: true`（需 welcome.capabilities.binaryFrames）时块改为二进制帧：头部
 *  payload 只有 `{index}`，原始字节在帧尾，每块最多 256 KiB；最终回执不变。 */
export interface SessionExportPayload { sessionId: string; format?: SessionExportFormat; binary?: boolean }

/**
 * 瞬时流式增量：不占 seq、不进重放环、断线不补发。与 `s2c.session.event`
 * 的 message.delta/thinking.delta 是两套语义——后者投影持久事件并占重放序号。
 */
export type SessionDeltaKind = 'stream.start' | 'message.delta' | 'thinking.delta' | 'stream.end'
export type SessionStreamOutcome =
  | { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq: number }
  | { kind: 'abandoned' }
export interface SessionDeltaPayload {
  sessionId: string
  streamId: string
  kind: SessionDeltaKind
  /** 生命周期帧为 ''；文字帧为本窗口内有序拼接的增量。 */
  text: string
  ts: number
  truncated?: boolean
  outcome?: SessionStreamOutcome
}

/** 插件自更新的阶段；rolled-back 表示宿主已自动装回旧版本。 */
export type PluginUpdatePhase =
  | 'preparing'
  | 'installing'
  | 'verifying'
  | 'restart-required'
  | 'done'
  | 'rolled-back'
  | 'failed'

/** 重启安全日志：保留最近一次结果，供热替换断线后的客户端核对；新请求覆盖。 */
export interface PluginUpdateJournal {
  clientRequestId: string
  fromVersion: string
  toVersion: string
  phase: PluginUpdatePhase
  startedAt: number
  message?: string
}

export interface PluginUpdateVersionEntry {
  version: string
  /** 宿主对 DSH 兼容性的判断（listVersions 给出）。 */
  compatible: boolean
  /** 目标包 package.json 的 deepPilot.protocolVersion；缺失则该版本不可选。 */
  protocolVersion?: number
}

export interface PluginUpdateStatusPayload {
  currentVersion: string
  protocolVersion: number
  latestVersion: string | null
  updateAvailable: boolean
  compatible: boolean
  protocolCompatible: boolean
  versions: PluginUpdateVersionEntry[]
  checkedAt: number
  /** 读取失败时的人类可读原因；离线是常态，不抛错。 */
  reason?: string
  journal?: PluginUpdateJournal
}

export interface PluginUpdateApplyPayload { version: string; clientRequestId: string }

export interface PluginUpdateProgressPayload {
  clientRequestId: string
  phase: PluginUpdatePhase
  percent?: number
  message?: string
}
export interface SessionModelsRequestPayload { sessionId: string }
export interface SessionSelectModelPayload extends ModelSelection { sessionId: string }
export interface SessionRenamePayload { sessionId: string; title: string }
export interface SessionArchivePayload { sessionId: string }
export interface SessionCancelPayload { sessionId: string }
export interface SessionCreatePayload { workspaceId?: string; cwd?: string }
export interface SessionForkPayload { clientRequestId: string; sessionId: string; atSeq?: number }
export interface SessionForkedPayload { clientRequestId: string; sourceSessionId: string; sessionId: string; atSeq?: number; replayed?: boolean }
export type ScheduleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron'
export interface ScheduleTaskView {
  id: string
  kind: ScheduleKind
  title: string
  prompt: string
  scheduledAt: string
  state: 'scheduled' | 'overdue'
  deliveryMode: 'host'
  afterSeconds?: number
  everySeconds?: number
  time?: string
  timeZone?: string
  weekdays?: number[]
  expression?: string
}
export interface ScheduleListPayload { sessionId: string }
export interface ScheduleHistoryPayload { sessionId: string; id: string; limit: number; before?: string }
export interface ScheduleCreatePayload {
  clientRequestId: string
  sessionId: string
  title: string
  prompt: string
  after_seconds?: number
  at?: string | { date: string; time: string; time_zone: string }
  every_seconds?: number
  daily?: { time: string; time_zone: string }
  weekly?: { time: string; time_zone: string; weekdays: number[] }
  cron?: { expression: string; time_zone: string }
}
export interface ScheduleUpdatePayload {
  clientRequestId: string
  sessionId: string
  id: string
  expected: ScheduleTaskView
  title?: string
  prompt?: string
  change?: { kind: 'at' | 'every' | 'daily' | 'weekly' | 'cron'; [key: string]: unknown }
}
export interface ScheduleDeletePayload { clientRequestId: string; sessionId: string; id: string }
export interface ScheduleSnapshotPayload { sessionId: string; tasks: ScheduleTaskView[] }
export interface ScheduleHistoryRecord {
  scheduledAt: string
  deliveredAt: string
  messageId: string
  prompt?: string
}
export interface ScheduleHistoryPayloadResult {
  sessionId: string
  history: {
    id: string
    records: ScheduleHistoryRecord[]
    earlierRecordsUnavailable: boolean
    earlierRecordsPruned?: boolean
    retention: { days: number; records: number }
    nextBefore?: string
  }
}
export interface ScheduleUpdatedPayload {
  clientRequestId: string
  sessionId: string
  task?: ScheduleTaskView
  deleted?: boolean
  replayed?: boolean
}
/* ---------- 宿主级计划任务（DSH 0.2.2-alpha.3 起，可选 v2 扩展） ----------
 *
 * 与上面的会话级 `ScheduleTaskView` 并存：旧宿主仍是 per-session 模型，新宿主把
 * 任务提升为宿主级（每个任务带一个交付 `target` 与 `active/paused/ended` 状态）。
 * PROTOCOL.md「Schedule 宿主级任务扩展」是这些形状的唯一来源；Bridge 用
 * `welcome.capabilities.schedulesHost` 告知新帧是否可用，旧帧在宿主级模型上
 * 由 Bridge 反向投影（旧 App 不需要升级）。
 */

/** 宿主级 timing 的判别 kind；比会话级多一个 `rrule`。 */
export type HostScheduleTimingKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule'

/** `at` 的本地日历写法；与 DSH `LocalAtInput` 一一对应。 */
export interface HostScheduleLocalAt { date: string; time: string; time_zone: string }

export type HostScheduleTiming =
  | { kind: 'after'; after_seconds: number }
  | { kind: 'at'; at: string | HostScheduleLocalAt }
  | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } }
  | { kind: 'rrule'; rrule: string }

/** `new_once` / `new` 目标建会话时的工作目录与预设（省略用 Host 默认）。 */
export interface HostScheduleCreateSpec { cwd?: string; agentPreset?: string }

/**
 * 任务视图里的交付目标。`new_once` 的 `sessionId` 是 Host 创建时预留的会话，
 * 首次投递后目标会转成 `session`。
 */
export type HostScheduleTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; sessionId: string; create?: HostScheduleCreateSpec }
  | { kind: 'new'; create?: HostScheduleCreateSpec }
/**
 * 创建/编辑请求里客户端可给出的目标：`new_once` 的会话由 Host 预留，客户端不填
 * `sessionId`。
 */
export type HostScheduleTargetRequest =
  | { kind: 'session'; sessionId: string }
  | { kind: 'new_once'; create?: HostScheduleCreateSpec }
  | { kind: 'new'; create?: HostScheduleCreateSpec }

/** 最近一次已确认投递的回执；不含 prompt 正文。 */
export interface HostScheduleDeliveryReceipt {
  scheduledAt: string
  deliveredAt: string
  messageId: string
  targetSessionId: string
}

/**
 * 宿主级任务视图。可选字段（createdAt/updatedAt/executionActive/
 * deliveryFloorEndsAt/lastDelivery）客户端不得依赖；`involvedSessionIds` 是
 * Host 内部字段，Bridge 不返回。
 */
export interface HostScheduleTask {
  id: string
  title: string
  prompt: string
  timing: HostScheduleTiming
  target: HostScheduleTarget
  status: 'active' | 'paused' | 'ended'
  scheduledAt: string
  createdAt?: string
  updatedAt?: string
  executionActive?: boolean
  deliveryFloorEndsAt?: string
  lastDelivery?: HostScheduleDeliveryReceipt
}

export interface HostScheduleListPayload { active?: boolean; limit?: number; offset?: number }
export interface HostScheduleSnapshotPayload {
  tasks: HostScheduleTask[]
  shown: number
  total: number
  limit: number
  offset: number
}
export interface HostScheduleViewPayload { id: string }
export interface HostScheduleTaskPayload { task: HostScheduleTask }
export interface HostScheduleCreatePayload {
  clientRequestId: string
  title: string
  prompt: string
  timing: HostScheduleTiming
  /** 省略时按 Host 默认：首次投递新建会话并复用。 */
  target?: HostScheduleTargetRequest
}
/** 编辑补丁：至少一个字段；省略的字段保持原值。 */
export interface HostSchedulePatch {
  title?: string
  prompt?: string
  timing?: HostScheduleTiming
  target?: HostScheduleTargetRequest
  /** false 暂停、true 恢复。 */
  active?: boolean
}
export interface HostScheduleEditPayload {
  clientRequestId: string
  id: string
  /** 可选乐观锁：等于最近读取的 updatedAt 才写入，不等回 E_BUSY。 */
  expectedUpdatedAt?: string | null
  action: 'update' | 'delete'
  /** `action="update"` 时必须提供且至少一个字段。 */
  patch?: HostSchedulePatch
}
export interface HostScheduleRunPayload { clientRequestId: string; id: string }
/** 清理宿主上全部已结束任务；按 clientRequestId 幂等。 */
export interface HostScheduleDeleteEndedPayload { clientRequestId: string }
export interface HostScheduleLimitsPayload { newSessionIntervalSeconds: number }
/** 宿主级变更成功回执：不带 sessionId（任务不再属于单一会话）。 */
export interface HostScheduleUpdatedPayload {
  clientRequestId: string
  task?: HostScheduleTask
  deleted?: boolean
  /** `c2s.schedule.host.deleteEnded` 的回执：删除的已结束任务条数；重放（replayed）时省略。 */
  deletedEnded?: number
  replayed?: boolean
}

export interface DirectoryListPayload { path?: string }
export interface WorkspaceCreatePayload { path: string }
export interface PromptImagePayload { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
export interface PromptDocumentPayload { mediaType: string; name: string; text: string; truncated?: boolean }
export interface SendPromptPayload { clientSendId?: string; sessionId: string; text: string; images?: PromptImagePayload[]; documents?: PromptDocumentPayload[] }
export interface ApprovalRespondPayload { requestId: string; decision: "allow" | "deny"; reason?: string }
export interface QuestionAnswer {
  id: string
  /** Selected option labels (labels, not separate ids). */
  selected: string[]
  /**
   * Free-text answer. MUST be omitted unless the user actually typed a
   * non-blank custom answer: the host rejects present-but-empty values, and
   * single-select questions reject `custom` combined with a selection.
   */
  custom?: string
}
export interface QuestionRespondPayload { requestId: string; answers: QuestionAnswer[] }
export interface ResumePayload { cursor: number }

/**
 * c2s.push.register payload (F-9 离线推送). Sent by the app after APNs grants
 * a device token, and re-sent on every handshake so the bridge always holds a
 * fresh token plus the device's current per-category notification switches.
 */
export interface PushRegisterPayload {
  /** Hex APNs device token (32–512 hex chars). */
  deviceToken: string
  /** Token environment; must match the bridge's configured APNs environment. */
  environment: 'development' | 'production'
  /** Per-category opt-out mirror so server pushes respect in-app switches. */
  categories?: Record<string, boolean>
  /**
   * Distributor's shared enrollment secret, baked into distributed builds.
   * When present on an otherwise-unconfigured bridge, enables relay push
   * mode and auto-enrollment (zero-touch setup for end users).
   */
  enrollKey?: string
}

/** c2s.widget.push.register. Uses a separate WidgetKit token, not the alert token. */
export type WidgetPushRegisterPayload = Omit<PushRegisterPayload, 'categories'>

// ---------- s2c payloads ----------

export interface WelcomeCapabilities {
  /** 会话命令目录、执行、权限与原生日志导出入口。缺省不支持。 */
  commands?: boolean
  /** 输入框 `@` 引用候选：c2s.session.references 可用（文件或会话引用至少一类）。缺省不支持。 */
  references?: boolean
  historyPaging: boolean
  replay: boolean
  approvals: boolean
  questions: boolean
  /** Client can request the complete currently-pending approval/question set. */
  pendingSnapshot?: boolean
  promptDelivery?: boolean
  /** Bridge emits s2c.notify for all four notification categories. */
  notifyAllCategories?: boolean
  models: boolean
  /** Session-scoped user-invocable skill metadata and invalidation notices. */
  skills?: boolean
  sessionManagement: boolean
  /** Bridge can fork a session at an exact event boundary. */
  sessionFork?: boolean
  /** Bridge can list archived sessions and restore them
   * (c2s.sessions.archived / c2s.session.unarchive). Absent on hosts whose
   * workspace controller predates unarchiveSession. */
  sessionRestore?: boolean
  projectSelection: boolean
  /** Host exposes the optional DSH Schedule service. */
  schedules?: boolean
  /** 宿主级计划任务模型（DSH 0.2.2-alpha.3 起）：true 时
   * 「Schedule 宿主级任务扩展」帧可用，schedulesHost=false/缺失时客户端只能
   * 使用会话级 schedule 帧。与 `schedules` 相互独立（后者只表示服务存在）。 */
  schedulesHost?: boolean
  /** Bridge has APNs configured; clients may send c2s.push.register. */
  push?: boolean
  widgetPush?: boolean
  liveActivityPush?: boolean
  /** Bridge accepts c2s.device.revoke, letting a client unbind itself before
   * deleting its local credentials. Absent on older bridges; older clients
   * ignore the extra field. */
  deviceRevoke?: boolean
  /** Host exposes DSH session.updateQueue and the inbox projection: running
   * sessions accept mode:"steer", s2c.session.queue snapshots are pushed and
   * c2s.session.queue.update is served. Absent ⇒ running sessions only stop. */
  promptQueue?: boolean
  /** Bridge pushes s2c.session.delta while a turn runs: transient assistant and
   * reasoning increments that never occupy a replay seq. Absent ⇒ the client
   * keeps the old "text appears when the step lands" rendering. */
  assistantStream?: boolean
  /** Bridge serves c2s.session.export with format:"markdown" (the host's
   * /api/session.markdown route). Absent ⇒ only the ZIP archive is available. */
  sessionMarkdown?: boolean
  /** Bridge serves c2s.plugin.update.check / c2s.plugin.update.apply, letting
   * the phone replace this plugin with a published version. Absent ⇒ the phone
   * can only link out to npm. */
  pluginUpdate?: boolean
  /** Bridge answers c2s.session.export / c2s.session.attachment requests that
   * carry `binary: true` with binary frames (raw bytes after a JSON header,
   * see binary-frame.ts). Plugin-level, independent of the host. Absent ⇒ the
   * client must keep requesting base64 text frames. */
  binaryFrames?: boolean
  /** Bridge honours `watchSessions` on c2s.auth.prove and c2s.session.watch:
   * a connection that declared an interest set only receives
   * s2c.session.event / s2c.session.queue (live and replayed) for sessions it
   * opened or watches. Plugin-level. Absent ⇒ the client gets every
   * session's events, as before. */
  sessionInterest?: boolean
  /** Bridge compresses downlink frames over 8 KB as binary format 2
   * (`[2][deflate-raw(envelope JSON)]`) once the client listed "deflate-raw"
   * in `acceptEncoding` on c2s.auth.prove. Plugin-level. Absent ⇒ the field is
   * ignored and every JSON frame stays a text frame. */
  compressedFrames?: boolean
  /** Bridge answers c2s.session.open carrying `sinceSeq` with an incremental
   * tail (`incremental: true`) holding only rows changed after that seq, or
   * with a full tail when it cannot prove the delta complete. Plugin-level. */
  incrementalTail?: boolean
  /** Bridge includes `routes` (current LAN endpoints with their certificate
   * fingerprint, and the public Funnel URL) in s2c.welcome so the client can
   * prefer the LAN on the same network and fall back to Funnel elsewhere.
   * Plugin-level. */
  routeHints?: boolean
}

export interface WelcomePayload {
  protocolVersion: number
  serverVersion: string
  deviceId: string
  scopes: DeviceScope[]
  capabilities: WelcomeCapabilities
  cursor: number
  resumed: boolean
  /** 能力 `routeHints`：本主机当前可用的连接地址，客户端据此自动选路。 */
  routes?: WelcomeRoutes
}

/**
 * 可用线路（PROTOCOL.md s2c.welcome `routes`）。地址形如配对信息里的 `host`
 * （`https://…`，不带路径）。只在已认证的连接上下发，局域网仍按指纹校验证书。
 */
export interface WelcomeRoutes {
  /** 局域网监听在线时出现；地址按物理网卡优先排序，客户端按顺序尝试。 */
  lan?: { urls: string[]; tlsFingerprint: string }
  /** Funnel 在线时出现。 */
  remote?: { url: string }
}

export type SessionStatus = "running" | "idle" | "error" | "unknown"

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
export interface SessionUsageStats {
  turns: number
  steps: number
  /** Summed model wall time in ms. */
  llmMs: number
  /** Summed tool wall time in ms. */
  toolMs: number
  /** Summed first-token latency in ms over ttftSteps. */
  ttftMs: number
  /** Steps that recorded a first token. */
  ttftSteps: number
  /** Summed decode wall time in ms over the decode-timed steps. */
  decodeMs: number
  /** Provider output tokens over the same decode-timed steps. */
  decodeTokens: number
  /** Provider-reported uncached prompt tokens. */
  inputTokens: number
  /** Provider-reported output tokens (reasoning included). */
  outputTokens: number
  /** Prompt tokens served from the provider cache. */
  cacheReadTokens: number
  /** Prompt tokens written to the provider cache. */
  cacheWriteTokens: number
}

export type SessionTodoStatus = "pending" | "in_progress" | "completed"

/** One checklist entry of the session todo projection. */
export interface SessionTodoItem {
  content: string
  status: SessionTodoStatus
}

export interface SessionSummary {
  id: string
  title: string
  status: SessionStatus
  lastActivityTs: number
  todos: { done: number; total: number } | null
  /** Full checklist so a conversation view can render progress, not just counts. Absent/null when the session has none. */
  todoItems?: SessionTodoItem[] | null
  /** Current tool operation, bounded to 160 Unicode code points. */
  activity?: string | null
  pendingApproval: boolean
  pendingQuestion: boolean
  /** Optional cumulative usage stats (see SessionUsageStats); hosts without
   * the stats projections omit it, and clients must tolerate its absence. */
  stats?: SessionUsageStats | null
  workspaceLabel: string | null
  workspaceId?: string | null
  workspacePath?: string | null
  /** Present only on rows served by `c2s.sessions.archived`; the live session
   * list never contains archived rows. Clients restore one with
   * `c2s.session.unarchive`. */
  archived?: boolean
}

export interface WorkspaceSummary {
  id: string
  title: string
  path: string
  sessionIds: string[]
}

export interface WorkspacesSnapshotPayload { workspaces: WorkspaceSummary[] }

export interface DirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

export interface DirectoryListingPayload {
  path: string
  home: string
  crumbs: DirectoryEntry[]
  entries: DirectoryEntry[]
  truncated: boolean
}

export interface SessionsSnapshotPayload { full: boolean; sessions: SessionSummary[] }
export interface SessionsDeltaPayload { upserted: SessionSummary[]; removedIds: string[] }

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system' | 'error'
export type ToolState = 'running' | 'ok' | 'error'

/**
 * 文件编辑类工具调用的改动内容（v2 追加式扩展，见 PROTOCOL.md「工具改动对比」）。
 * Bridge 把宿主 `edit`（old_string/new_string）、`write`（content）与 `str_replace_editor`
 * （old_str/new_str/file_text/insert_line）的参数名归一化成这里的字段，手机端不依赖宿主工具参数命名。`oldText` / `newText` 各自超过
 * 16 KiB（UTF-8）时都不发，只带 `truncated: true`。
 */
export interface ToolEditProjection {
  path: string
  operation: 'replace' | 'create' | 'insert'
  oldText?: string
  newText?: string
  /** `insert` 专用：在该行之后插入，0 表示文件开头。 */
  insertLine?: number
  truncated?: boolean
}

/**
 * 工具调用的操作对象（v2 追加式扩展，见 PROTOCOL.md「Message 投影 · tool.target」）。
 * Bridge 从宿主工具参数里挑出「对什么做」：文件路径、命令、搜索式、网址或其他对象名，
 * 参数名不外泄。工具结果合并回调用行后 `summary` 会被结果摘要替换，`target` 保留，
 * 客户端据此在调用完成后仍能显示「读取 A.swift」而不是文件正文片段。
 * `kind` 是开放词表：客户端遇到未知值按 `text` 处理。
 */
export interface ToolTargetProjection {
  kind: 'path' | 'command' | 'pattern' | 'url' | 'text'
  /** 主值；UTF-8 上限 1 KiB。路径超长时砍开头（保留文件名），其余砍结尾加「…」。 */
  value: string
  /** 范围：搜索所在目录（`pattern` 专用）；UTF-8 上限 1 KiB，规则同路径。 */
  scope?: string
  /** 宿主给的人类可读说明（如 bash 的 description）；UTF-8 上限 256 B。 */
  label?: string
}

/** Provenance of host-injected context; present only on `role: "system"` rows.
 * Mirrors the durable DSH message source (`dsh-llm` MessageSource): `label`
 * names the producer (plugin name, skill name, instruction paths…), `form` is
 * the semantic ContextForm vocabulary ('instructions' | 'catalog' | 'snapshot'
 * | 'notice' | 'relay' | 'recall'). Both degrade gracefully — clients must
 * tolerate absent fields and unknown values. */
export interface MessageContextInfo {
  label?: string
  form?: string
}

/** One image carried by a user message. `attachmentId` keys the read-back RPC
 * (c2s.session.attachment); width/height let clients reserve layout space. */
export interface MessageAttachment {
  kind: 'image' | 'document'
  name?: string
  mediaType?: string
  attachmentId?: string
  width?: number
  height?: number
  truncated?: boolean
}

export interface MessageProjection {
  /** Durable row identity; unique within one session/page. */
  seq: number
  role: MessageRole
  text?: string
  /** Reasoning ("thinking") text accompanying the answer, when present. */
  thinking?: string
  streaming?: boolean
  tool?: { name: string; state: ToolState; summary: string; edit?: ToolEditProjection; target?: ToolTargetProjection }
  attachments?: MessageAttachment[]
  /** Present only on system rows: provenance of the injected context.
   * The DSH host logs synthetic agent.inject() content (runtime-context
   * snapshots, background-job notices, workspace instructions…) as user-role
   * messages whose `source.kind` is not 'user'; those project here as
   * `role: "system"` so clients never show them as human prompts. */
  context?: MessageContextInfo
  ts: number
  truncated?: boolean
}

/** Payload of c2s.session.attachment: read one durable image back. */
export interface SessionAttachmentPayload {
  sessionId: string
  attachmentId: string
  /** 客户端能收的单帧字节上限；缺省按旧 App 的 1 MiB 处理，超出回 E_TOO_LARGE。 */
  maxFrameBytes?: number
  /** 需 welcome.capabilities.binaryFrames。为 true 时图片按二进制分块下发
   *  （s2c.session.attachment.chunk，头部 `{index}`），最终 s2c.ack 为
   *  {@link SessionAttachmentBinaryAck}；此时 maxFrameBytes 不参与判断。 */
  binary?: boolean
}

/** 二进制模式的附件最终回执：只核对块数与总字节，图片本身已在块里。 */
export interface SessionAttachmentBinaryAck { mediaType?: string; chunks: number; bytes: number }

export interface SessionTailPayload {
  sessionId: string
  /** Aggregate JSON array is bounded to 900 KB; hasMore covers any dropped prefix. */
  messages: MessageProjection[]
  oldestSeq: number
  hasMore: boolean
  /** 能力 `incrementalTail`：本帧只含 sinceSeq 之后改动过的行，客户端按增量合并。 */
  incremental?: true
  sinceSeq?: number
}

export interface HistoryPagePayload {
  sessionId: string
  /** Response envelope echoes the c2s.session.history id; array is bounded to 900 KB. */
  messages: MessageProjection[]
  hasMore: boolean
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: { efforts: ModelReasoningEffort[]; defaultEffort?: string }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface ModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** Metadata only: loading instructions remains the Host's responsibility. */
export interface SkillSummary {
  name: string
  description: string
  modelInvocable: boolean
}

export interface SessionSkillsPayload {
  sessionId: string
  skills: SkillSummary[]
}

export interface SessionModelsPayload {
  sessionId: string
  current: ModelSelection
  routable: boolean
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}

export interface SessionModelSelectedPayload {
  sessionId: string
  selected: ModelSelection
}

export type SessionEventKind =
  | 'message.start'
  | 'message.delta'
  | 'thinking.delta'
  | 'message.final'
  | 'tool.start'
  | 'tool.end'
  | 'turn.start'
  | 'turn.end'
  | 'projection'
  | 'error'

export interface SessionEventData {
  /** 正式 assistant 消息关联的瞬时流；客户端用其替换相同流的临时行。 */
  streamId?: string
  text?: string
  ok?: boolean
  /** tool.end only: host invocation id pairing the result with its call row. */
  callId?: string
  /** tool.end: bounded result summary and durable attachment metadata. */
  summary?: string
  attachments?: MessageProjection['attachments']
  key?: string
  value?: unknown
  [k: string]: unknown
}

export interface SessionEventPayload {
  sessionId: string
  kind: SessionEventKind
  seq: number
  data: SessionEventData
}

export type NotifyCategory = 'turn.completed' | 'approval.required' | 'question.asked' | 'session.error'

export interface NotifyPayload {
  /** Stable paired Host audience, absent on older bridges. */
  hostAudience?: string
  notificationId: string
  category: NotifyCategory
  sessionId: string
  title: string
  body: string
  /** Only for `approval.required`: tool name and the Host's reason/summary, for the expanded notification view. */
  toolName?: string
  detail?: string
  ts: number
}

/**
 * One offline-push-worthy event (same facts as s2c.notify / pending frames,
 * projected for APNs). The bridge fans these out to paired devices that hold
 * an APNs token and no live WebSocket.
 */
export interface PushNotification {
  hostAudience?: string
  notificationId: string
  category: NotifyCategory
  sessionId: string
  title: string
  body: string
  /** Same optional approval-only fields as NotifyPayload; dropped in `generic` content mode. */
  toolName?: string
  detail?: string
}

export interface PendingApprovalPayload {
  requestId: string
  sessionId: string
  toolName: string
  summary: string
  toolArguments?: string
  riskLevel: 'read' | 'write' | 'destructive'
}

export interface PendingQuestionOption { label: string; description?: string }
export interface PendingQuestionItem {
  id: string
  question: string
  multiSelect?: boolean
  options?: PendingQuestionOption[]
}
export interface PendingQuestionPayload {
  requestId: string
  sessionId: string
  questions: PendingQuestionItem[]
}
export interface PendingSnapshotPayload {
  approvals: PendingApprovalPayload[]
  questions: PendingQuestionPayload[]
}
export interface PendingClearedPayload { requestId: string }
export interface ResyncPayload { reason: "gap" }
export interface ErrorPayload { code: string; message: string }

/** wire 错误码表由 wire-errors.ts 属主；此处为本 mirror 的读者再出口。 */
export { ERROR_CODES, type WireErrorCode } from './wire-errors.ts'

export interface PromptDeliveryPayload { sessionId: string; clientSendId: string }

/** 运行中排队与转向扩展（promptQueue 能力）。 */
export interface SessionQueueItem {
  /** Host MessageId；c2s.session.queue.update 用它定位。 */
  itemId: string
  /** queued = Host next-turn（下一轮）；steering = Host next-step（下一个步骤边界）。 */
  placement: "queued" | "steering"
  /** 用户正文，不含文档正文块；最多 4096 个码点。 */
  text: string
  truncated?: true
  imageCount: number
  documentCount: number
  /** 由 DeepPilot 客户端经 clientSendId 发送时出现；所有设备收到的快照相同。 */
  clientSendId?: string
}
/** 整表快照：客户端整体替换，并按 itemId 跨 placement 跟踪。 */
export interface SessionQueuePayload { sessionId: string; items: SessionQueueItem[] }
export interface SessionQueueUpdatePayload { sessionId: string; itemId: string; action: "remove" | "steer" }
export interface SessionQueueUpdateAck { sessionId: string; itemId: string }
export type { DeliveryReceipt } from "./dispatch-journal.ts"

export type { CommandSummary, CommandCatalog, CommandAttachment, CommandExecution, PermissionCatalog, PermissionOption } from './command-api.ts'
export type { FileReferenceItem, SessionReferenceItem, ReferenceSource, ReferenceCandidates } from './reference-api.ts'
/** c2s.session.references 请求：`query` 是 `@` 之后已键入的文字（可为空，最长 1024 字符）。 */
export interface SessionReferencesRequest { sessionId: string; query: string }
/** s2c.session.references 响应：原样回带 `query`，客户端据此丢弃过期结果。 */
export type SessionReferencesPayload = import('./reference-api.ts').ReferenceCandidates & { sessionId: string; query: string }

/** 模型选择变化只投影公开路由字段；缺少 current 时重新读取当前会话。 */
export interface ModelsChangedPayload { sessionId: string; current?: { provider: string; model: string; reasoningEffort?: string } }
