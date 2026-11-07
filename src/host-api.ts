import type { SessionExportFormat, SessionSummary } from './protocol.ts'
import type {
  HostSchedulePatch,
  HostScheduleTargetRequest,
  HostScheduleTask,
  HostScheduleTiming,
} from './protocol.ts'
import type { DeviceScope } from './device-auth.ts'
import type { PushNotification } from './protocol.ts'
import type { WireErrorCode } from './wire-errors.ts'
import type { CommandAttachment, CommandCatalog, CommandExecution, PermissionCatalog } from './command-api.ts'
import type { ReferenceCandidates } from './reference-api.ts'

export interface CommandsApiLike {
  list(req: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<CommandCatalog>>
  execute(req: RpcRequestLike<{ sessionId: string; line: string; attachments: CommandAttachment[]; expectedDefinitionId?: string }>): Promise<RpcResponseLike<CommandExecution>>
  permissions(req: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<PermissionCatalog>>
  feedback(req: RpcRequestLike<{ sessionId: string; text: string; category?: string }>): Promise<RpcResponseLike<void>>
  readonly markdownAvailable?: boolean
  export(req: RpcRequestLike<{ sessionId: string; format?: SessionExportFormat }>, signal: AbortSignal): Promise<Response>
}

/** 输入框 `@` 引用候选（文件 + 会话），见 reference-api.ts。 */
export interface ReferencesApiLike {
  list(req: RpcRequestLike<{ sessionId: string; query: string }>, signal?: AbortSignal): Promise<RpcResponseLike<ReferenceCandidates>>
}

/* Stable bridge-facing structural types mapped to rc.2 controllers by
 * DshApiProxy. */

interface RpcOk<T> { ok: true; value: T }
interface RpcErr { ok: false; error: { code: string; message?: string } }
type RpcResult<T> = RpcOk<T> | RpcErr

interface RpcRequestLike<T> { rpcId?: string; payload?: T }
interface RpcResponseLike<T> { result?: RpcResult<T> }

interface SessionsApiLike {
  list(req?: RpcRequestLike<{ cursor?: string }>): Promise<RpcResponseLike<{ items: PhoneSessionRow[] }>>
  history(req: RpcRequestLike<{ sessionId: string; beforeSeq?: number; maxMessages?: number }>):
    Promise<RpcResponseLike<HistoryResult>>
  prompt(req: RpcRequestLike<PromptArgs>): Promise<RpcResponseLike<{ accepted: true }>>
  create(req: RpcRequestLike<{ workspaceId?: string; cwd?: string; agentPreset?: string }>): Promise<RpcResponseLike<{ sessionId: string; agentPreset?: string }>>
  fork?(req: RpcRequestLike<{ sessionId: string; atSeq?: number }>): Promise<RpcResponseLike<{ sessionId: string }>>
  models?(req: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<HostSessionModels>>
  skills?(req: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<{ skills: import('./protocol.ts').SkillSummary[] }>>
  selectModel?(req: RpcRequestLike<{
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  }>): Promise<RpcResponseLike<{ selected: HostModelSelection }>>
  rename?(req: RpcRequestLike<{ sessionId: string; title: string }>):
    Promise<RpcResponseLike<{ title: string; seq: number }>>
  cancel?(req: RpcRequestLike<{ sessionId: string }>):
    Promise<RpcResponseLike<Record<string, unknown> | undefined>>
  /**
   * Reads one durable image back. DSH ≤ 0.2.1 reads `attachmentId` and checks the
   * session log itself; DSH 0.2.2+ reads the full `attachment` reference and no
   * longer checks the session, so HostBridge sends both and only supplies a
   * reference it saw projected in that session.
   */
  attachment?(req: RpcRequestLike<{ sessionId: string; attachmentId: string; attachment?: import('./host-event-projection.ts').HostImageRef }>):
    Promise<RpcResponseLike<{ attachment: { mediaType?: string }; data: string }>>
  /** Remove or steer one pending inbox item. Absent on hosts without the
   * DSH session.updateQueue RPC; the promptQueue capability bit probes it. */
  updateQueue?(req: RpcRequestLike<QueueUpdateArgs>): Promise<RpcResponseLike<{ accepted: true }>>
  /** Complete projection baseline for one session; null when it is gone. */
  projections(req: RpcRequestLike<{ sessionId: string }>):
    Promise<RpcResponseLike<{ asOfSeq: number; values: Record<string, unknown> } | null>>
}

interface WorkspaceApiLike {
  list?(req: RpcRequestLike<Record<string, never>>):
    Promise<RpcResponseLike<{ items: WorkspaceViewLike[]; archivedSessionIds: string[] }>>
  create?(req: RpcRequestLike<{ path: string }>):
    Promise<RpcResponseLike<{ workspace: WorkspaceViewLike; created: boolean }>>
  archiveSession?(req: RpcRequestLike<{ sessionId: string }>):
    Promise<RpcResponseLike<{ archivedSessionIds: string[] }>>
  unarchiveSession?(req: RpcRequestLike<{ sessionId: string }>):
    Promise<RpcResponseLike<{ archivedSessionIds: string[] }>>
}

/* ---------- Schedule：会话级（legacy）与宿主级（host）双形态 ----------
 *
 * DSH 0.2.2-alpha.3 把 `@deepseek-ai/dsh-schedule` 从 per-session 模型改成宿主级
 * 模型（任务带交付 target；没有 update/delete，只有 edit；list 返回分页对象）。
 * 插件必须双形态共存，因此 `ApiProxyLike.schedule` 是一个带判别位的联合：缺省
 * `mode` 表示会话级（旧宿主与既有假 service 都是这个形状），`mode: 'host'` 表示
 * 下面这套宿主级接口。Bridge 只认这两个分支，不再按版本号字符串猜测。
 */

export type ScheduleKind = 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron'

export interface ScheduleTaskViewLike {
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

export interface ScheduleHistoryViewLike {
  id: string
  records: Array<{
    scheduledAt: string
    deliveredAt: string
    messageId: string
    prompt?: string
  }>
  earlierRecordsUnavailable: boolean
  earlierRecordsPruned?: boolean
  retention: { days: number; records: number }
  nextBefore?: string
}

/** 会话级 Schedule 服务（DSH ≤ 0.2.2-alpha.2）：任务绑定单一 Session。 */
export interface LegacyScheduleApiLike {
  /** 判别位缺省即 legacy：旧宿主与既有测试夹具不必补字段。 */
  readonly mode?: 'legacy'
  list(req: RpcRequestLike<{ sessionId: string }>):
    Promise<RpcResponseLike<{ sessionId: string; tasks: ScheduleTaskViewLike[] }>>
  history(req: RpcRequestLike<{ sessionId: string; id: string; limit: number; before?: string }>):
    Promise<RpcResponseLike<{ sessionId: string; history: ScheduleHistoryViewLike }>>
  create(req: RpcRequestLike<{ sessionId: string; title: string; prompt: string; [key: string]: unknown }>):
    Promise<RpcResponseLike<ScheduleTaskViewLike>>
  update(req: RpcRequestLike<{ sessionId: string; id: string; expected: unknown; title?: string; prompt?: string; change?: unknown }>):
    Promise<RpcResponseLike<{ id: string; updated: boolean; record?: ScheduleTaskViewLike; code?: string }>>
  delete(req: RpcRequestLike<{ sessionId: string; id: string }>):
    Promise<RpcResponseLike<{ id: string; deleted: boolean; code?: string }>>
}

/** 宿主级任务视图：与 wire 的 `HostScheduleTask` 同一形状（Bridge 直接透传）。 */
export type HostScheduleTaskView = HostScheduleTask

export interface HostScheduleListRequestLike {
  /** true 只列运行中；false 只列暂停/结束；省略列全部。 */
  active?: boolean
  limit?: number
  offset?: number
}

export interface HostScheduleListResultLike {
  tasks: HostScheduleTaskView[]
  shown: number
  total: number
  limit: number
  offset: number
}

/** 查看结果：命中或非变更 miss（Host 用 code 表示 miss，不是抛错）。 */
export type HostScheduleViewOutcome =
  | { kind: 'task'; task: HostScheduleTaskView }
  | { kind: 'not-found'; id: string }

/** 编辑结果：更新后的任务、已删除、miss，或乐观锁冲突（wire 上回 E_BUSY）。 */
export type HostScheduleEditOutcome =
  | { kind: 'task'; task: HostScheduleTaskView }
  | { kind: 'deleted'; id: string }
  | { kind: 'not-found'; id: string }
  | { kind: 'conflict'; id: string }

/** 手动执行结果：已投递、已有执行在进行中（E_BUSY），或目标已不存在。 */
export type HostScheduleRunOutcome =
  | { kind: 'task'; task: HostScheduleTaskView }
  | { kind: 'pending'; id: string }
  | { kind: 'not-found'; id: string }

/** 清理已结束任务的结果：删除的条数（宿主上没有已结束任务时为 0）。 */
export interface HostScheduleDeleteEndedResult {
  deleted: number
}

export interface HostScheduleLimitsView {
  /** 以新建会话方式投递的最小间隔秒数；客户端只展示，不自行节流。 */
  newSessionIntervalSeconds: number
}

export interface HostScheduleCreateRequestLike {
  title: string
  prompt: string
  timing: HostScheduleTiming
  /** 省略时由 Host 默认：首次投递新建并复用会话。 */
  target?: HostScheduleTargetRequest
}

export type HostScheduleEditRequestLike =
  | { id: string; action: 'update'; patch: HostSchedulePatch; expectedUpdatedAt?: string | null }
  | { id: string; action: 'delete'; expectedUpdatedAt?: string | null }

/**
 * 宿主级 Schedule 服务（DSH 0.2.2-alpha.3 起）。
 *
 * 探测只看形状：`edit` 存在且 `update` 不存在。`remoteXxx` 是同一服务的
 * 「人类 Remote 调用」变体（不记录 acting Session）；Bridge 就是人类 Remote
 * 调用方，因此直接用公开方法并省略 actorSessionId。
 */
export interface HostScheduleApiLike {
  readonly mode: 'host'
  list(req: RpcRequestLike<HostScheduleListRequestLike>):
    Promise<RpcResponseLike<HostScheduleListResultLike>>
  view(req: RpcRequestLike<{ id: string }>): Promise<RpcResponseLike<HostScheduleViewOutcome>>
  create(req: RpcRequestLike<HostScheduleCreateRequestLike>):
    Promise<RpcResponseLike<HostScheduleTaskView>>
  edit(req: RpcRequestLike<HostScheduleEditRequestLike>):
    Promise<RpcResponseLike<HostScheduleEditOutcome>>
  run(req: RpcRequestLike<{ id: string }>): Promise<RpcResponseLike<HostScheduleRunOutcome>>
  history(req: RpcRequestLike<{ id: string; limit: number; before?: string }>):
    Promise<RpcResponseLike<ScheduleHistoryViewLike>>
  limits(req: RpcRequestLike<Record<string, never>>):
    Promise<RpcResponseLike<HostScheduleLimitsView>>
  /** 删除宿主上全部 `status="ended"` 的任务；进行中与暂停的任务不受影响。 */
  deleteEnded(req: RpcRequestLike<Record<string, never>>):
    Promise<RpcResponseLike<HostScheduleDeleteEndedResult>>
}

export type ScheduleApiLike = LegacyScheduleApiLike | HostScheduleApiLike

interface HostApiLike {
  listDirectory?(req: RpcRequestLike<{ path?: string }>, signal?: AbortSignal):
    Promise<RpcResponseLike<DirectoryListingLike>>
  pickDirectory?(req: RpcRequestLike<Record<string, never>>, signal?: AbortSignal):
    Promise<RpcResponseLike<{ path: string | null }>>
}

export interface WorkspaceViewLike {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt?: string
  updatedAt?: string
}

export interface DirectoryEntryLike {
  name: string
  path: string
  hidden: boolean
}

export interface DirectoryListingLike {
  path: string
  home: string
  crumbs: DirectoryEntryLike[]
  entries: DirectoryEntryLike[]
  truncated: boolean
}

export interface HostModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface HostSessionModels {
  current: HostModelSelection
  routable: boolean
  groups: Array<{
    id: string
    name: string
    models: Array<{
      id: string
      name: string
      description?: string
      reasoning?: {
        efforts: Array<{ id: string; name: string; description?: string }>
        defaultEffort?: string
      }
    }>
  }>
  failures: Array<{ id: string; name: string; message: string }>
}

/**
 * Bridge 方法的结果。失败直接携带 wire 错误码（error vocabulary 见
 * wire-errors.ts）：调用方（wire-registry 的行）原样透给手机，不再经过
 * kind 中间层翻译。
 */
export type ModelBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: WireErrorCode; message: string }

export type SessionManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: WireErrorCode; message: string }

export interface PromptArgs {
  sessionId: string
  mode: 'queue' | 'steer'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
  >
  clientTimeZone?: string
}

/** DSH session.updateQueue request; `edit` is reserved on the wire and never sent. */
export interface QueueUpdateArgs {
  sessionId: string
  itemId: string
  action: { kind: 'remove' } | { kind: 'steer' }
}

export interface PhoneSessionRow {
  sessionId: string
  updatedAt: number
  running: boolean
  /** Host marks never-prompted sessions as blank; informational only — the
   * summary projects them as idle (see toSummary) so phones can send. */
  blank?: boolean
  cwd?: string
  origin?: string
  parentSessionId?: string
  projections?: { asOfSeq?: number; values?: Record<string, unknown> }
}

/**
 * Subagent sessions are host-internal workers of a parent conversation.
 * They must never surface on the phone: not in the project/session list,
 * and not as turn-completion pushes for a session the device cannot open.
 *
 * `parentSessionId` alone is NOT a subagent signal: a session forked from
 * another one (c2s.session.fork) also carries it, as fork lineage, while
 * being an ordinary top-level session the phone must show. Only the host's
 * explicit `origin` marks a worker — mirror the same rule already used for
 * the live mux stream (see dsh-api-proxy.ts's `isSubagent` derivation).
 */
export function isSubagentRow(row: PhoneSessionRow): boolean {
  return row.origin === 'subagent';
}

export interface HistoryResult {
  events: Array<{ event: SessionEventLike; view?: unknown }>
  hasMore: boolean
  projections?: { values?: Record<string, unknown> }
}

export interface SessionEventLike {
  type: string
  seq: number
  time?: number
  data?: unknown
}

export interface MuxFrameLike {
  /** Internal Host identity hint; never serialized into the phone protocol. */
  isSubagent?: boolean
  type: string
  rpcId?: string
  payload?: any
  sessionId?: string
  event?: SessionEventLike
  key?: string
  value?: unknown
  approvalId?: string
  callId?: string
  toolName?: string
  reason?: string
  questions?: unknown
  questionRpcId?: string
  running?: boolean
}

/**
 * apiProxy stream items are server-request envelopes: the frame lives in
 * `payload`, while the stable request id used to answer approval/question
 * waits lives beside it. Flattening only `payload` loses that id and makes
 * both interactions silently disappear.
 */
export interface ApiStreamItemLike {
  rpcId?: string
  payload: MuxFrameLike
}

export function unwrapStreamItem(item: MuxFrameLike | ApiStreamItemLike): MuxFrameLike {
  const nested = item.payload
  if (nested && typeof nested === 'object' && typeof nested.type === 'string') {
    // The envelope id identifies the server request that must be answered.
    // Preserve it even if a future nested payload happens to carry another id.
    return item.rpcId ? { ...nested, rpcId: item.rpcId } : nested
  }
  return item as MuxFrameLike
}

export interface ApiProxyLike {
  /** 真实宿主反射声明了助手流帧时才为 true；旧代理缺省关闭。 */
  readonly assistantStreamAvailable?: boolean
  commands?: CommandsApiLike
  /** 主机挂载了文件引用或会话引用服务之一时存在；两者都缺席为 undefined。 */
  references?: ReferencesApiLike
  sessions: SessionsApiLike
  workspace?: WorkspaceApiLike
  schedule?: ScheduleApiLike
  host?: HostApiLike
  respond(message: { type: 'client-response'; rpcId: string; result: RpcResult<unknown> }):
    Promise<{ accepted: boolean; reason?: string }>
  events: {
    mux(req: RpcRequestLike<Record<string, never>>, signal: AbortSignal): AsyncIterable<MuxFrameLike | ApiStreamItemLike>
    host(req: RpcRequestLike<Record<string, never>>, signal: AbortSignal): AsyncIterable<MuxFrameLike | ApiStreamItemLike>
  }
}

/**
 * Outcome of answering a pending approval/question. The host distinguishes
 * "never/no longer pending" from "payload rejected", and collapsing both into
 * a boolean made every rejection read as `question not pending` on the phone.
 */
export type PendingResponseOutcome =
  | { ok: true }
  | { ok: false; reason: 'not-pending' | 'bad-response' | 'transport' }

/** Downward sink every connected phone registers (one per WebSocket). */
export interface BridgeSink {
  push(type: string, payload: unknown, seq?: number): void
  lastCursor(): number
  replay(entries: Array<{ seq: number; type: string; payload: unknown }>): void
  replayDone(): void
  resync(): void
  /**
   * S→C permission gate (R1/P2): whether this sink may receive broadcast or
   * replayed frames that require `scope`. The bridge consults this before
   * every push/replay delivery; unknown broadcast types are denied.
   */
  canReceive(scope: DeviceScope): boolean
  /**
   * Interest filter (capability `sessionInterest`): whether this sink wants a
   * frame it is already permitted to receive. Connections that declared an
   * interest set drop other sessions' events here. Absent ⇒ wants everything.
   * The bridge consults it when sizing a replay window; sinks apply it again
   * on every push.
   */
  accepts?(type: string, payload: unknown): boolean
}

/**
 * Offline push fan-out (F-9 离线推送). The bridge forwards every
 * notification-worthy event here; the outlet decides which paired devices
 * (token holders without a live socket) receive an APNs delivery.
 */
export interface PushOutlet {
  fanOut(notification: PushNotification): void
  widgetChanged?(): void
  liveActivityChanged?(sessions: SessionSummary[]): void
  /**
   * Whether offline push is currently configured and usable. Drives the
   * welcome capability bit: advertising push while no APNs credentials are
   * loaded would make clients suppress their own local banners and lose
   * notifications entirely.
   */
  isAvailable(): boolean
}
