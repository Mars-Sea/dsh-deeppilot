import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/protocol.d.ts
type SessionStatus = "running" | "idle" | "error" | "unknown";
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
  pendingApproval: boolean;
  pendingQuestion: boolean;
  workspaceLabel: string | null;
  workspaceId?: string | null;
  workspacePath?: string | null;
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
type ModelBridgeResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  kind: 'unsupported' | 'not-found' | 'busy' | 'unavailable' | 'internal';
  message: string;
};
type SessionManagementResult<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  kind: 'unsupported' | 'not-found' | 'busy' | 'invalid' | 'internal';
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
  type: string;
  rpcId?: string;
  payload?: any;
  sessionId?: string;
  event?: SessionEventLike;
  key?: string;
  value?: unknown;
  approvalId?: string;
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
}
/**
 * Offline push fan-out (F-9 离线推送). The bridge forwards every
 * notification-worthy event here; the outlet decides which paired devices
 * (token holders without a live socket) receive an APNs delivery.
 */
interface PushOutlet {
  fanOut(notification: PushNotification): void;
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
declare class HostBridge {
  private readonly apiProxy;
  private readonly historyBufferMax;
  readonly id: number;
  private summaries;
  private approvals;
  private questions;
  private archivedSessionIds;
  private subagentSessionIds;
  private sinks;
  private ring;
  private cursor;
  private userReceiptSeq;
  private abort;
  private started;
  private disposed;
  constructor(apiProxy: ApiProxyLike, historyBufferMax?: number);
  private pushOutlet;
  /**
   * Wire the offline-push fan-out. Present ⇒ welcome advertises the `push`
   * capability and notify-worthy events are mirrored to APNs.
   */
  setPushOutlet(outlet: PushOutlet | undefined): void;
  get capabilities(): {
    historyPaging: boolean;
    replay: boolean;
    approvals: boolean;
    questions: boolean;
    pendingSnapshot: boolean;
    notifyAllCategories: boolean;
    models: boolean;
    sessionManagement: boolean;
    projectSelection: boolean;
    push: boolean;
  };
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
   */
  resumeFrom(cursor: number, target?: BridgeSink): boolean;
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
  private noteActivity;
  private applyProjection;
  private bumpPendingFlags;
  private pushSummary;
  listSessions(): SessionSummary[];
  /**
   * Complete transient interaction state. Unlike the replay ring, this remains
   * authoritative after a long disconnect and is rehydrated by apiProxy's mux
   * stream when the bridge itself restarts.
   */
  pendingSnapshot(): PendingSnapshotPayload;
  /** Tail history for an opened session; pushes s2c.session.tail to the sink. */
  openSession(sink: BridgeSink, sessionId: string, tailCount: number): Promise<boolean>;
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
  /** Verbose per-frame diagnostics (never prints token or message bodies). */
  debug?: boolean;
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
declare const Config: z<Schemastery.ObjectS<{
  enabled: z<boolean, boolean>;
  devicesPath: z<string, string>;
  historyBufferMax: z<number, number>;
  debug: z<boolean, boolean>;
  remote: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    provider: z<"tailscale-funnel", "tailscale-funnel">;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000>;
    maxConnectionsPerSource: z<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    provider: z<"tailscale-funnel", "tailscale-funnel">;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000>;
    maxConnectionsPerSource: z<number, number>;
  }>>;
  push: z<Schemastery.ObjectS<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay">;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>, Schemastery.ObjectT<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay">;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>>;
}>, Schemastery.ObjectT<{
  enabled: z<boolean, boolean>;
  devicesPath: z<string, string>;
  historyBufferMax: z<number, number>;
  debug: z<boolean, boolean>;
  remote: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    provider: z<"tailscale-funnel", "tailscale-funnel">;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000>;
    maxConnectionsPerSource: z<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    provider: z<"tailscale-funnel", "tailscale-funnel">;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<443 | 8443 | 10000, 443 | 8443 | 10000>;
    maxConnectionsPerSource: z<number, number>;
  }>>;
  push: z<Schemastery.ObjectS<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay">;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>, Schemastery.ObjectT<{
    provider: z<"apns" | "none" | "relay", "apns" | "none" | "relay">;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>>;
}>>;
//#endregion
//#region src/push-policy.d.ts
/** Prune only when the provider supplies an authoritative token-lifecycle verdict. */
declare function shouldPrunePushToken(outcome: 'sent' | 'invalid-token' | 'failed', reason?: string): boolean;
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
 * clients. Registers exactly one WebSocket upgrade route (/phone) plus an
 * optional health probe (/phone/health) on the existing web server. The web
 * UI is never touched.
 *
 * Data plane: an in-process HostBridge consumes a local compatibility façade
 * over DSH 0.1.2 Session/Workspace controllers, mirrors session summaries,
 * tracks pending approvals/questions, and fans projected protocol-v2 pushes
 * out to every connected device.
 *
 * Protocol: PROTOCOL.md is normative; src/protocol.ts and the private app's
 * Swift models mirror that v2 contract.
 */
declare const name = "deeppilot";
/** No eager service requirement: profiles without a web stack simply skip. */
declare const inject: string[];
declare function apply(ctx: Context, options: unknown): void;
//#endregion
export { Config, HostBridge, apply, inject, name, shouldPrunePushToken, shouldReEnrollRelayToken };
//# sourceMappingURL=index.d.ts.map