import { randomUUID } from 'node:crypto'
import type { Envelope, MessageProjection, NotifyCategory, PendingSnapshotPayload, PushNotification, SessionEventKind, SessionSummary, SessionTodoItem, SessionTodoStatus } from './protocol.ts'

/* Minimal structural faces over the host apiProxy service. The real types
 * live in @deepseek-ai/dsh-host-apiproxy; keeping them structural lets this
 * plugin compile and degrade independently of host package versions. */

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
  models?(req: RpcRequestLike<{ sessionId: string }>): Promise<RpcResponseLike<HostSessionModels>>
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
  /** Reads one durable image back after the host verifies the session log references its id. */
  attachment?(req: RpcRequestLike<{ sessionId: string; attachmentId: string }>):
    Promise<RpcResponseLike<{ attachment: { mediaType?: string }; data: string }>>
}

interface WorkspaceApiLike {
  list?(req: RpcRequestLike<Record<string, never>>):
    Promise<RpcResponseLike<{ items: WorkspaceViewLike[]; archivedSessionIds: string[] }>>
  create?(req: RpcRequestLike<{ path: string }>):
    Promise<RpcResponseLike<{ workspace: WorkspaceViewLike; created: boolean }>>
  archiveSession?(req: RpcRequestLike<{ sessionId: string }>):
    Promise<RpcResponseLike<{ archivedSessionIds: string[] }>>
}

interface HostApiLike {
  listDirectory?(req: RpcRequestLike<{ path?: string }>, signal?: AbortSignal):
    Promise<RpcResponseLike<DirectoryListingLike>>
  pickDirectory?(req: RpcRequestLike<Record<string, never>>, signal?: AbortSignal):
    Promise<RpcResponseLike<{ path: string | null }>>
}

interface WorkspaceViewLike {
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

interface HostModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface HostSessionModels {
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

export type ModelBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'unsupported' | 'not-found' | 'busy' | 'unavailable' | 'internal'; message: string }

export type SessionManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'unsupported' | 'not-found' | 'busy' | 'invalid' | 'internal'; message: string }

interface PromptArgs {
  sessionId: string
  mode: 'queue' | 'steer'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
  >
  clientTimeZone?: string
}

interface PhoneSessionRow {
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
 */
function isSubagentRow(row: PhoneSessionRow): boolean {
  return row.origin === 'subagent' ||
    (typeof row.parentSessionId === 'string' && row.parentSessionId.length > 0);
}

interface HistoryResult {
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
  type: string
  rpcId?: string
  payload?: any
  sessionId?: string
  event?: SessionEventLike
  key?: string
  value?: unknown
  approvalId?: string
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
  sessions: SessionsApiLike
  workspace?: WorkspaceApiLike
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
}

/**
 * Offline push fan-out (F-9 离线推送). The bridge forwards every
 * notification-worthy event here; the outlet decides which paired devices
 * (token holders without a live socket) receive an APNs delivery.
 */
export interface PushOutlet {
  fanOut(notification: PushNotification): void
  /**
   * Whether offline push is currently configured and usable. Drives the
   * welcome capability bit: advertising push while no APNs credentials are
   * loaded would make clients suppress their own local banners and lose
   * notifications entirely.
   */
  isAvailable(): boolean
}

interface PendingApproval {
  rpcId: string
  sessionId: string
  toolName: string
  reason: string
}

interface PendingQuestion {
  rpcId: string
  sessionId: string
  questions: unknown
}

const MAX_RING_DEFAULT = 2000;
export const MAX_MESSAGE_PROJECTION_BYTES = 256 * 1024

/**
 * Process-wide bridge state: session mirror, pending approvals/questions,
 * and the per-device replay ring. Consumes the in-process mux/host streams
 * and fans projected pushes out to every registered sink.
 */
let BRIDGE_SEQ = 0;

export class HostBridge {
  readonly id = ++BRIDGE_SEQ;
  private summaries = new Map<string, SessionSummary>()
  private approvals = new Map<string, PendingApproval>()
  private questions = new Map<string, PendingQuestion>()
  private archivedSessionIds = new Set<string>()
  private subagentSessionIds = new Set<string>()
  private sinks = new Set<BridgeSink>()
  private ring: Array<{ seq: number; type: string; payload: unknown }> = []
  private cursor = 0;
  private userReceiptSeq = 0;
  private abort = new AbortController();
  private started = false
  private disposed = false

  constructor(
    private readonly apiProxy: ApiProxyLike,
    private readonly historyBufferMax: number = MAX_RING_DEFAULT,
  ) {}

  private pushOutlet: PushOutlet | undefined;

  /**
   * Wire the offline-push fan-out. Present ⇒ welcome advertises the `push`
   * capability and notify-worthy events are mirrored to APNs.
   */
  setPushOutlet(outlet: PushOutlet | undefined): void {
    this.pushOutlet = outlet;
  }

  get capabilities() {
    return {
      historyPaging: true,
      replay: true,
      approvals: true,
      questions: true,
      pendingSnapshot: true,
      models: typeof this.apiProxy.sessions.models === 'function' &&
        typeof this.apiProxy.sessions.selectModel === 'function',
      sessionManagement: typeof this.apiProxy.sessions.rename === 'function' &&
        typeof this.apiProxy.workspace?.archiveSession === 'function',
      projectSelection: typeof this.apiProxy.workspace?.list === 'function' &&
        typeof this.apiProxy.workspace?.create === 'function',
      push: this.pushOutlet?.isAvailable() === true,
    };
  }

  diagnostic(message: string): void {
    console.log('[deeppilot] ' + message);
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
  }

  dropSinkSessions(sink: BridgeSink): void {
    this.sinkSessions.delete(sink);
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
    body: string
    notificationId: string
  }): void {
    if (this.subagentSessionIds.has(args.sessionId)) return;
    const body = args.body.length > 120 ? args.body.slice(0, 119) + '…' : args.body;
    this.record(
      's2c.notify',
      {
        notificationId: args.notificationId,
        category: args.category,
        sessionId: args.sessionId,
        title: args.title,
        body,
        ts: Date.now(),
      },
      (sink) => this.isViewedBy(sink, args.sessionId),
    );
    this.fanOutPush({
      notificationId: args.notificationId,
      category: args.category,
      sessionId: args.sessionId,
      title: args.title,
      body,
    });
  }

  /** F-9: when a turn completes, notify every device not viewing the session. */
  private emitTurnCompletedNotify(sessionId: string, ok: boolean): void {
    if (this.subagentSessionIds.has(sessionId)) return;

    const row = this.summaries.get(sessionId);
    const title = ok ? '任务完成' : '任务异常结束';
    const body = this.lastAssistantText.get(sessionId) ?? row?.title ?? '';
    this.emitNotify({
      sessionId,
      category: ok ? 'turn.completed' : 'session.error',
      title,
      body,
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


  /** Remember the latest assistant text so notifications can quote it. */
  private captureAssistantText(sessionId: string, event: SessionEventLike): void {

    if (event.type !== 'assistant/message') return;

    const text = messageText(event.data).trim();

    if (text.length > 0) this.lastAssistantText.set(sessionId, text.slice(-160));
  }

  /**
   * Replay buffered pushes after the given cursor; false when the gap is
   * unrecoverable. Frames go to `target` only — replaying into every sink
   * duplicated the whole window onto devices that never asked for it.
   */
  resumeFrom(cursor: number, target?: BridgeSink): boolean {
    const oldest = this.ring.length > 0 ? this.ring[0]!.seq : this.cursor + 1;
    if (cursor + 1 < oldest) return false;
    const receivers = target !== undefined ? [target] : [...this.sinks];
    for (const entry of this.ring) {
      if (entry.seq > cursor) {
        for (const sink of receivers) sink.replay([entry]);
      }
    }
    for (const sink of receivers) sink.replayDone();
    return true;
  }

  private record(type: string, payload: unknown, except?: (sink: BridgeSink) => boolean): void {
    if (this.disposed) return
    this.cursor += 1;
    const entry = { seq: this.cursor, type, payload };
    this.ring.push(entry);
    if (this.ring.length > this.historyBufferMax) {
      this.ring.splice(0, this.ring.length - this.historyBufferMax);
    }
    for (const sink of this.sinks) {
      if (except && except(sink)) continue;
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

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort();
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
      case 'host/session-status': {
        const p = frame as { sessionId?: string; running?: boolean };
        const row = this.summaries.get(String(p.sessionId));
        if (row && typeof p?.running === 'boolean') {
          row.status = p.running ? 'running' : 'idle';
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
      case 'session/event': {
        const event = frame.event as SessionEventLike | undefined;
        const sessionId = String(frame.sessionId ?? '');
        if (!event || !sessionId) break;
        this.noteActivity(sessionId, event);
        this.captureAssistantText(sessionId, event);
        const projection = projectEvent(sessionId, event);
        if (projection) {
          this.record('s2c.session.event', { sessionId, kind: projection.kind, seq: event.seq, data: projection.data });
        }
        if (projection?.kind === 'turn.end') {
          this.emitTurnCompletedNotify(sessionId, projection.data.ok === true);
        }
        break;
      }
      case 'session/projection': {
        const p = frame as { sessionId?: string; key?: string; value?: unknown };
        if (!p.sessionId) break;
        this.applyProjection(p.sessionId, String(p.key ?? ''), p.value);
        break;
      }
      case 'approval/requested': {
        const p = frame as { sessionId?: string; approvalId?: string; toolName?: string; reason?: string };
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
        this.emitNotify({
          sessionId,
          category: 'approval.required',
          title: '需要批准',
          body: toolName + ': ' + summary,
          notificationId: 'apr-' + p.approvalId,
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
      const subagentIds = new Set<string>();
      for (const row of response.result.value.items ?? []) {
        if (this.archivedSessionIds.has(row.sessionId)) continue
        if (isSubagentRow(row)) {
          subagentIds.add(row.sessionId);
          continue;
        }
        next.set(row.sessionId, toSummary(row, this.approvals, this.questions, workspaceBySession.get(row.sessionId)));
      }
      this.subagentSessionIds = subagentIds;
      this.summaries = next;
      const removedIds = [...previousIds].filter((id) => !next.has(id))
      // sessions.list is authoritative. This also removes assistant snippets
      // captured for child/subagent event streams that never enter summaries.
      for (const id of this.lastAssistantText.keys()) {
        if (!next.has(id)) this.lastAssistantText.delete(id)
      }
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

  private applyProjection(sessionId: string, key: string, value: unknown): void {
    const row = this.summaries.get(sessionId);
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
    this.record('s2c.sessions.delta', { upserted: [row], removedIds: [] });
  }

  listSessions(): SessionSummary[] {
    return [...this.summaries.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
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

  // ---------- data operations ----------

  /** Tail history for an opened session; pushes s2c.session.tail to the sink. */
  async openSession(sink: BridgeSink, sessionId: string, tailCount: number): Promise<boolean> {
    try {
      const response = await this.apiProxy.sessions.history({
        rpcId: randomUUID(),
        payload: { sessionId, maxMessages: clampTail(tailCount) },
      });
      if (!response.result || !response.result.ok) return false;
      const result = response.result.value;
      const messages = projectHistory(result.events ?? []);
      const oldestSeq = messages.length > 0 ? messages[0]!.seq : 0;
      sink.push('s2c.session.tail', {
        sessionId,
        messages,
        oldestSeq,
        hasMore: Boolean(result.hasMore),
      });
      this.deriveTitleFallback(sessionId, messages);
      return true;
    } catch {
      return false;
    }
  }

  async historyPage(sink: BridgeSink, sessionId: string, beforeSeq: number, limit: number): Promise<boolean> {
    try {
      const response = await this.apiProxy.sessions.history({
        rpcId: randomUUID(),
        payload: { sessionId, beforeSeq, maxMessages: clampTail(limit) },
      });
      if (!response.result || !response.result.ok) return false;
      const result = response.result.value;
      const messages = projectHistory(result.events ?? []);
      sink.push('s2c.history.page', { sessionId, messages, hasMore: Boolean(result.hasMore) });
      return true;
    } catch {
      return false;
    }
  }

  /** Result of one attachment read-back for the phone. */
  async attachmentData(
    sessionId: string,
    attachmentId: string,
  ): Promise<{ mediaType?: string; data: string } | null> {
    const read = this.apiProxy.sessions.attachment
    if (typeof read !== 'function') return null;
    try {
      const response = await read.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId, attachmentId },
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

  async sessionModels(sessionId: string): Promise<ModelBridgeResult<HostSessionModels>> {
    const models = this.apiProxy.sessions.models
    if (typeof models !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'model catalog unavailable on this host version' }
    }
    try {
      const response = await models.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId },
      })
      if (!response.result) return { ok: false, kind: 'internal', message: 'model catalog returned no result' }
      if (!response.result.ok) return hostModelError(response.result.error)
      return { ok: true, value: projectSessionModels(response.result.value) }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async selectSessionModel(
    sessionId: string,
    selection: HostModelSelection,
  ): Promise<ModelBridgeResult<HostModelSelection>> {
    const selectModel = this.apiProxy.sessions.selectModel
    if (typeof selectModel !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'model selection unavailable on this host version' }
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
      if (!response.result) return { ok: false, kind: 'internal', message: 'model selection returned no result' }
      if (!response.result.ok) return hostModelError(response.result.error)
      return { ok: true, value: { ...response.result.value.selected } }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async renameSession(sessionId: string, title: string): Promise<SessionManagementResult<string>> {
    const rename = this.apiProxy.sessions.rename
    if (typeof rename !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'session rename unavailable on this host version' }
    }
    try {
      const response = await rename.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId, title },
      })
      if (!response.result) return { ok: false, kind: 'internal', message: 'session rename returned no result' }
      if (!response.result.ok) return hostSessionManagementError(response.result.error)
      const acceptedTitle = String(response.result.value.title)
      const row = this.summaries.get(sessionId)
      if (row) {
        row.title = acceptedTitle
        this.pushSummary(row)
      }
      return { ok: true, value: acceptedTitle }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async archiveSession(sessionId: string): Promise<SessionManagementResult<true>> {
    const archive = this.apiProxy.workspace?.archiveSession
    if (typeof archive !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'session archive unavailable on this host version' }
    }
    try {
      const response = await archive.call(this.apiProxy.workspace, {
        rpcId: randomUUID(),
        payload: { sessionId },
      })
      if (!response.result) return { ok: false, kind: 'internal', message: 'session archive returned no result' }
      if (!response.result.ok) return hostSessionManagementError(response.result.error)
      this.archivedSessionIds = new Set(
        (response.result.value.archivedSessionIds ?? []).map(String),
      )
      this.summaries.delete(sessionId)
      this.lastAssistantText.delete(sessionId)
      this.record('s2c.sessions.delta', { upserted: [], removedIds: [sessionId] })
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async cancelSession(sessionId: string): Promise<SessionManagementResult<true>> {
    const cancel = this.apiProxy.sessions.cancel
    if (typeof cancel !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'session cancel unavailable on this host version' }
    }
    try {
      const response = await cancel.call(this.apiProxy.sessions, {
        rpcId: randomUUID(),
        payload: { sessionId },
      })
      if (!response.result) return { ok: false, kind: 'internal', message: 'session cancel returned no result' }
      if (!response.result.ok) return hostSessionManagementError(response.result.error)
      return { ok: true, value: true }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async listWorkspaces(): Promise<SessionManagementResult<Array<{
    id: string; title: string; path: string; sessionIds: string[]
  }>>> {
    const list = this.apiProxy.workspace?.list
    if (typeof list !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'workspace list unavailable on this host version' }
    }
    try {
      const response = await list.call(this.apiProxy.workspace, { rpcId: randomUUID(), payload: {} })
      if (!response.result) return { ok: false, kind: 'internal', message: 'workspace list returned no result' }
      if (!response.result.ok) return hostSessionManagementError(response.result.error)
      return { ok: true, value: (response.result.value.items ?? []).map(projectWorkspace) }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async createWorkspace(path: string): Promise<SessionManagementResult<{
    workspace: { id: string; title: string; path: string; sessionIds: string[] }; created: boolean
  }>> {
    const create = this.apiProxy.workspace?.create
    if (typeof create !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'workspace create unavailable on this host version' }
    }
    try {
      const response = await create.call(this.apiProxy.workspace, {
        rpcId: randomUUID(),
        payload: { path },
      })
      if (!response.result) return { ok: false, kind: 'internal', message: 'workspace create returned no result' }
      if (!response.result.ok) return hostSessionManagementError(response.result.error)
      await this.refreshSummaries()
      return {
        ok: true,
        value: { workspace: projectWorkspace(response.result.value.workspace), created: response.result.value.created === true },
      }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async listDirectory(path?: string): Promise<SessionManagementResult<DirectoryListingLike>> {
    const list = this.apiProxy.host?.listDirectory
    if (typeof list !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'directory browsing unavailable on this host version' }
    }
    try {
      const response = await list.call(this.apiProxy.host, {
        rpcId: randomUUID(),
        payload: path && path.trim().length > 0 ? { path } : {},
      }, this.abort.signal)
      if (!response.result) return { ok: false, kind: 'internal', message: 'directory list returned no result' }
      if (!response.result.ok) return hostSessionManagementError(response.result.error)
      return { ok: true, value: response.result.value }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
    }
  }

  async pickDirectory(): Promise<SessionManagementResult<string | null>> {
    const pick = this.apiProxy.host?.pickDirectory
    if (typeof pick !== 'function') {
      return { ok: false, kind: 'unsupported', message: 'native directory picker unavailable on this host version' }
    }
    try {
      const response = await pick.call(this.apiProxy.host, {
        rpcId: randomUUID(),
        payload: {},
      }, this.abort.signal)
      if (!response.result) return { ok: false, kind: 'internal', message: 'directory picker returned no result' }
      if (!response.result.ok) return hostSessionManagementError(response.result.error)
      return { ok: true, value: response.result.value.path }
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) }
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

  async sendPrompt(
    sessionId: string,
    text: string,
    images: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }> = [],
  ): Promise<SessionManagementResult<number>> {
    try {
      const content: PromptArgs['content'] = [];
      if (text.trim().length > 0) content.push({ type: 'text', text });
      for (const image of images) content.push({ type: 'image', ...image });
      const response = await this.apiProxy.sessions.prompt({
        rpcId: randomUUID(),
        payload: {
          sessionId,
          mode: 'queue',
          content,
          clientTimeZone: localTimeZone(),
        },
      });
      if (!response.result) return { ok: false, kind: 'internal', message: 'prompt returned no result' };
      // Preserve the host's error kind so the phone can tell "retry later"
      // (E_BUSY) from "session is gone" (E_NOT_FOUND) instead of mapping
      // every failure onto E_BUSY.
      if (!response.result.ok) return hostSessionManagementError(response.result.error);
      const row = this.summaries.get(sessionId);
      if (row) {
        row.lastActivityTs = Date.now();
        this.pushSummary(row);
      }
      this.userReceiptSeq += 1;
      return { ok: true, value: this.userReceiptSeq };
    } catch (error) {
      return { ok: false, kind: 'internal', message: String(error) };
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
            // PROTOCOL v1: a deny may carry the user's explanation so the
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

function clampTail(n: number): number {
  if (!Number.isFinite(n)) return 100;
  return Math.max(10, Math.min(500, Math.floor(n)));
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

/** Project one raw session event into a protocol push, when it maps to one. */
export function projectEvent(sessionId: string, event: SessionEventLike): { kind: SessionEventKind; data: Record<string, unknown> } | null {
  switch (event.type) {
    case 'turn/start':
      return { kind: 'turn.start', data: {} };
    case 'turn/end': {
      const data = event.data as { reason?: { kind?: string } } | undefined;
      return { kind: 'turn.end', data: { ok: data?.reason?.kind === 'completed' } };
    }
    case 'user/message':
      return {
        kind: 'message.final',
        data: { ...limitMessageProjection({
          seq: event.seq,
          role: userRoleOf(event.data),
          text: messageText(event.data),
          ...attachmentProjection(event.data),
          ...(contextProjectionOf(event.data)),
          ts: tsOf(event),
        }) },
      };
    case 'assistant/chunk': {
      if (chunkTypeOf(event.data) === 'reasoning-delta') {
        return { kind: 'thinking.delta', data: limitRealtimeText({ text: chunkText(event.data), ts: tsOf(event) }) };
      }
      return { kind: 'message.delta', data: limitRealtimeText({ text: chunkText(event.data), ts: tsOf(event) }) };
    }
    case 'assistant/message': {
      const text = messageText(event.data);
      const thinking = messageThinking(event.data);
      // Pure-reasoning or tool-only steps carry no visible answer; emitting
      // them produced empty bubbles on the phone.
      if (!text.trim() && !thinking.trim()) return null;
      return {
        kind: 'message.final',
        data: { ...limitMessageProjection({ seq: event.seq, role: 'assistant', text, ...(thinking ? { thinking } : {}), ts: tsOf(event) }) },
      };
    }
    case 'tool/call': {
      const data = event.data as { name?: string; arguments?: string; callId?: string } | undefined;
      return {
        kind: 'tool.start',
        data: {
          seq: event.seq,
          role: 'tool',
          tool: {
            name: String(data?.name ?? 'tool'),
            state: 'running',
            summary: summarizeArgs(data?.arguments),
            // Echo the invocation id so clients can pair the later result with
            // this exact row instead of guessing.
            ...(data?.callId ? { callId: String(data.callId) } : {}),
          },
          ts: tsOf(event)
        }
      };
    }
    case 'tool/result': {
      const data = event.data as { callId?: string; error?: unknown } | undefined;
      return {
        kind: 'tool.end',
        data: {
          seq: event.seq,
          role: 'tool',
          ok: !event.data || data?.error === undefined,
          // The seq above identifies this result event; callId is what ties it
          // back to the originating tool/call row on the client.
          ...(data?.callId ? { callId: String(data.callId) } : {}),
          ts: tsOf(event)
        }
      };
    }
    default:
      return null;
  }
}

function tsOf(event: SessionEventLike): number {
  return typeof event.time === 'number' ? event.time : Date.now();
}

// ---------- user-role source classification ----------
//
// The DSH host logs every model-visible user-role message as `user/message`,
// but only some of them are human prompts: synthetic `agent.inject()` context
// (runtime-context snapshots, background-job notices, workspace instructions,
// skill content, …) rides the same event type. The durable message carries a
// `source` whose `kind` tells them apart, and the host's own trajectory view
// renders only `source.kind === 'user'` as a human prompt — everything else is
// injected context. The bridge mirrors that classification so the phone can
// keep the two apart instead of guessing from text shapes.

/** Read the durable message source off one user/message payload. Handles both
 * bare-message payloads and older `{message: {...}}` wrappers; undefined when
 * the shape carries no readable source (legacy hosts). */
function userMessageSource(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const obj = data as { source?: unknown; message?: { source?: unknown } };
  if (obj.source && typeof obj.source === 'object') {
    return obj.source as Record<string, unknown>;
  }
  if (obj.message && typeof obj.message === 'object' &&
      obj.message.source && typeof obj.message.source === 'object') {
    return obj.message.source as Record<string, unknown>;
  }
  return undefined;
}

/** Wire role for one user/message payload. A payload without any readable
 * source degrades to 'user' so history written by older hosts stays visible;
 * a present source follows the host's own trajectory rule — anything whose
 * `kind` is not 'user' is injected context and projects as 'system'. */
function userRoleOf(data: unknown): 'user' | 'system' {
  const source = userMessageSource(data);
  if (!source) return 'user';
  return source.kind === 'user' ? 'user' : 'system';
}

/** Producer name of one injected-context source, mirroring how the DSH client
 * runtime derives its trajectory label: plugin name, skill name, instruction
 * paths, session-reference labels, or the raw kind as fallback. */
function contextLabelOf(source: Record<string, unknown>): string | undefined {
  const kind = typeof source.kind === 'string' ? source.kind : '';
  const joined = (member: string): string | undefined => {
    const list = source[member];
    if (!Array.isArray(list)) return undefined;
    const names = list.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      return [typeof record.label === 'string' ? record.label :
        (typeof record.path === 'string' ? record.path : '')];
    }).filter((name) => name.length > 0);
    return names.length > 0 ? names.join(', ') : undefined;
  };
  switch (kind) {
    case 'session-reference':
      return joined('references') ?? (kind || undefined);
    case 'agent-instructions':
      return joined('changes') ?? (kind || undefined);
    case 'plugin':
      return typeof source.plugin === 'string' && source.plugin.length > 0 ? source.plugin : kind || undefined;
    case 'skill-invocation':
      return typeof source.name === 'string' && source.name.length > 0 ? source.name : kind || undefined;
    default:
      return kind || undefined;
  }
}

/** Semantic ContextForm declared by the producer ('snapshot', 'notice', …);
 * anything unrecognized stays undefined so clients render it opaque. */
function contextFormOf(source: Record<string, unknown>): string | undefined {
  if (typeof source.form !== 'string' || source.form.length === 0) return undefined;
  // Same known-vocabulary guard as the host's trajectory UI.
  const known = ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'];
  return known.includes(source.form) ? source.form : undefined;
}

/** Optional `context` metadata for one system row; {} on user rows. */
function contextProjectionOf(data: unknown): { context?: { label?: string; form?: string } } {
  if (userRoleOf(data) !== 'system') return {};
  const source = userMessageSource(data);
  if (!source) return {};
  const label = contextLabelOf(source);
  const form = contextFormOf(source);
  if (!label && !form) return {};
  return { context: { ...(label ? { label } : {}), ...(form ? { form } : {}) } };
}

/** Extract plain text from user/assistant message payloads across shapes. */
function messageText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const obj = data as { content?: unknown; text?: unknown; message?: unknown };
  if (typeof obj.text === 'string') return obj.text;
  // Session events wrap the message: {turn, step, message: {role, content}}
  if (obj.message && typeof obj.message === 'object') return messageText(obj.message);
  return contentText(obj.content);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const piece = part as { type?: string; text?: string };
        if (piece.type === 'text' && typeof piece.text === 'string') return piece.text;
      }
      return '';
    }).join('');
  }
  return '';
}

function messageAttachments(data: unknown): Array<{
  kind: 'image'
  name?: string
  mediaType?: string
  attachmentId?: string
  width?: number
  height?: number
}> {
  if (!data || typeof data !== 'object') return [];
  const obj = data as { content?: unknown; message?: unknown };
  if (obj.message && typeof obj.message === 'object') return messageAttachments(obj.message);
  if (!Array.isArray(obj.content)) return [];
  return obj.content.flatMap(part => {
    if (!part || typeof part !== 'object') return [];
    // The host normalizes uploaded bytes into an ImageAttachmentRef
    // (attachmentId/mediaType/bytes/width/height...); the id is what clients
    // need to read the image back through c2s.session.attachment.
    const block = part as {
      type?: string
      attachment?: {
        name?: unknown
        mediaType?: unknown
        attachmentId?: unknown
        width?: unknown
        height?: unknown
      }
    };
    if (block.type !== 'image' || !block.attachment) return [];
    const attachmentId = typeof block.attachment.attachmentId === 'string' && block.attachment.attachmentId.length > 0
      ? block.attachment.attachmentId
      : undefined;
    const width = typeof block.attachment.width === 'number' && Number.isFinite(block.attachment.width)
      ? block.attachment.width
      : undefined;
    const height = typeof block.attachment.height === 'number' && Number.isFinite(block.attachment.height)
      ? block.attachment.height
      : undefined;
    return [{
      kind: 'image' as const,
      ...(typeof block.attachment.name === 'string' ? { name: block.attachment.name } : {}),
      ...(typeof block.attachment.mediaType === 'string' ? { mediaType: block.attachment.mediaType } : {}),
      ...(attachmentId ? { attachmentId } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }];
  });
}

function attachmentProjection(data: unknown): { attachments?: ReturnType<typeof messageAttachments> } {
  const attachments = messageAttachments(data);
  return attachments.length > 0 ? { attachments } : {};
}

/** Extract reasoning ("thinking") text from assistant message payloads. */
function messageThinking(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as { content?: unknown; message?: unknown };
  // Session events wrap the message: {turn, step, message: {role, content}}
  if (obj.message && typeof obj.message === 'object') return messageThinking(obj.message);
  return reasoningContent(obj.content);
}

function reasoningContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (part && typeof part === 'object') {
      const piece = part as { type?: string; text?: string };
      if (piece.type === 'reasoning' && typeof piece.text === 'string') return piece.text;
    }
    return '';
  }).join('');
}

/** Stream chunk type of an assistant/chunk payload ('' when unwrapped). */
function chunkTypeOf(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as { chunk?: unknown };
  if (obj.chunk && typeof obj.chunk === 'object') {
    return String((obj.chunk as { type?: unknown }).type ?? '');
  }
  // Unwrapped payloads carry plain text deltas.
  return 'text-delta';
}

function chunkText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  // StreamChunk shape: {turn, step, chunk: {type: 'text-delta'|'reasoning-delta', text}}
  const obj = data as { chunk?: unknown };
  if (obj.chunk && typeof obj.chunk === 'object') {
    const inner = obj.chunk as { type?: string; text?: string };
    if ((inner.type === 'text-delta' || inner.type === 'reasoning-delta') && typeof inner.text === 'string') {
      return inner.text;
    }
    return '';
  }
  const direct = data as { text?: unknown };
  return typeof direct.text === 'string' ? direct.text : '';
}

function summarizeArgs(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') parts.push(key + '=' + truncate(value.replace(/\s+/g, ' '), 60));
    }
    return truncate(parts.join(' '), 90);
  } catch {
    return truncate(raw, 90);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function hostModelError(error: { code: string; message?: string }): ModelBridgeResult<never> {
  const message = error.message ?? error.code
  switch (error.code) {
    case 'session-not-found':
      return { ok: false, kind: 'not-found', message }
    case 'agent-busy':
    case 'session-conflict':
      return { ok: false, kind: 'busy', message }
    case 'model-unavailable':
      return { ok: false, kind: 'unavailable', message }
    default:
      return { ok: false, kind: 'internal', message }
  }
}

function hostSessionManagementError(
  error: { code: string; message?: string },
): SessionManagementResult<never> {
  const message = error.message ?? error.code
  switch (error.code) {
    case 'session-not-found':
      return { ok: false, kind: 'not-found', message }
    case 'agent-busy':
    case 'session-conflict':
      return { ok: false, kind: 'busy', message }
    case 'title-invalid':
    case 'workspace-invalid-path':
    case 'workspace-name-conflict':
    case 'directory-unreadable':
    case 'directory-exists':
    case 'directory-create-failed':
      return { ok: false, kind: 'invalid', message }
    case 'directory-picker-unavailable':
      return { ok: false, kind: 'unsupported', message }
    case 'workspace-not-found':
      return { ok: false, kind: 'not-found', message }
    default:
      return { ok: false, kind: 'internal', message }
  }
}

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
export function projectHistory(events: Array<{ event: SessionEventLike; view?: unknown }>): MessageProjection[] {
  const messages: MessageProjection[] = [];
  const toolByCall = new Map<string, MessageProjection>();
  for (const entry of events) {
    const event = entry.event;
    const base = { seq: event.seq, ts: tsOf(event) };
    switch (event.type) {
      case 'user/message':
        messages.push({
          ...base,
          role: userRoleOf(event.data),
          text: messageText(event.data),
          ...attachmentProjection(event.data),
          ...(contextProjectionOf(event.data)),
        });
        break;
      case 'assistant/message': {
        const text = messageText(event.data);
        const thinking = messageThinking(event.data);
        if (!text.trim() && !thinking.trim()) break;
        messages.push({ ...base, role: 'assistant', text, ...(thinking ? { thinking } : {}) });
        break;
      }
      case 'tool/call': {
        const data = event.data as { name?: string; arguments?: string; callId?: string } | undefined;
        const row: MessageProjection = {
          ...base,
          role: 'tool',
          tool: { name: String(data?.name ?? 'tool'), state: 'running', summary: summarizeArgs(data?.arguments) },
        };
        messages.push(row);
        if (data?.callId) toolByCall.set(String(data.callId), row);
        break;
      }
      case 'tool/result': {
        const data = event.data as { callId?: string; message?: { content?: unknown }; error?: unknown } | undefined;
        const callId = data?.callId ? String(data.callId) : undefined;
        const target = callId ? toolByCall.get(callId) : undefined;
        const failed = data?.error !== undefined;
        const summary = failed ? '失败' : summarizeResult(data?.message?.content);
        if (target?.tool) {
          target.tool = { ...target.tool, state: failed ? 'error' : 'ok', summary };
        } else {
          messages.push({ ...base, role: 'tool', tool: { name: 'result', state: failed ? 'error' : 'ok', summary } });
        }
        break;
      }
      default:
        break;
    }
  }
  return messages
    .sort((a, b) => a.seq - b.seq)
    .map(limitMessageProjection);
}

/**
 * Enforce PROTOCOL.md's per-message 256 KB ceiling by UTF-8 JSON byte size.
 * Keep structural identity and attachment references intact; progressively
 * shorten human-readable fields until the serialized projection fits.
 */
export function limitMessageProjection(message: MessageProjection): MessageProjection {
  if (jsonBytes(message) <= MAX_MESSAGE_PROJECTION_BYTES) return message
  const next: MessageProjection = {
    ...message,
    ...(message.tool ? {
      tool: {
        ...message.tool,
        name: truncateUtf8(message.tool.name, 4 * 1024),
        summary: truncateUtf8(message.tool.summary, 64 * 1024),
      },
    } : {}),
    ...(message.attachments ? {
      attachments: message.attachments.slice(0, 16).map((attachment) => ({
        ...attachment,
        ...(attachment.name ? { name: truncateUtf8(attachment.name, 4 * 1024) } : {}),
        ...(attachment.mediaType ? { mediaType: truncateUtf8(attachment.mediaType, 256) } : {}),
        ...(attachment.attachmentId ? { attachmentId: truncateUtf8(attachment.attachmentId, 4 * 1024) } : {}),
      })),
    } : {}),
    ...(message.context ? {
      context: {
        ...(message.context.label ? { label: truncateUtf8(message.context.label, 8 * 1024) } : {}),
        ...(message.context.form ? { form: truncateUtf8(message.context.form, 256) } : {}),
      },
    } : {}),
    truncated: true,
  }

  const textFields: Array<{
    get: () => string
    set: (value: string) => void
  }> = []
  if (typeof next.text === 'string') textFields.push({
    get: () => next.text ?? '',
    set: (value) => { next.text = value },
  })
  if (typeof next.thinking === 'string') textFields.push({
    get: () => next.thinking ?? '',
    set: (value) => { next.thinking = value },
  })
  if (next.tool) textFields.push({
    get: () => next.tool?.summary ?? '',
    set: (value) => { if (next.tool) next.tool.summary = value },
  })
  if (next.context?.label) textFields.push({
    get: () => next.context?.label ?? '',
    set: (value) => { if (next.context) next.context.label = value },
  })

  while (jsonBytes(next) > MAX_MESSAGE_PROJECTION_BYTES) {
    const largest = textFields
      .map((field) => ({ field, bytes: Buffer.byteLength(field.get(), 'utf8') }))
      .sort((a, b) => b.bytes - a.bytes)[0]
    if (largest && largest.bytes > 0) {
      largest.field.set(truncateUtf8(largest.field.get(), Math.floor(largest.bytes / 2)))
      continue
    }
    if (next.attachments && next.attachments.length > 0) {
      next.attachments = next.attachments.slice(0, -1)
      continue
    }
    break
  }
  return next
}

function limitRealtimeText(data: { text: string; ts: number }): Record<string, unknown> {
  if (jsonBytes(data) <= MAX_MESSAGE_PROJECTION_BYTES) return data
  let text = data.text
  const next: Record<string, unknown> = { ...data, truncated: true }
  while (jsonBytes(next) > MAX_MESSAGE_PROJECTION_BYTES && text.length > 0) {
    text = truncateUtf8(text, Math.floor(Buffer.byteLength(text, 'utf8') / 2))
    next.text = text
  }
  return next
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = value.slice(0, mid)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  let end = low
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1
  return value.slice(0, end)
}

function summarizeResult(content: unknown): string {
  const text = contentText(content).replace(/\s+/g, ' ').trim();
  return truncate(text, 90);
}
