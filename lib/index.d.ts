import { IncomingMessage } from "node:http";
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
//#region src/host-bridge.d.ts
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
  blank: boolean;
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
  private abort;
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
  historyPage(sink: BridgeSink, sessionId: string, beforeSeq: number, limit: number): Promise<boolean>;
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
  }>): Promise<SessionManagementResult<number>>;
  respondApproval(requestId: string, decision: 'allow' | 'deny', reason?: string): Promise<PendingResponseOutcome>;
  respondQuestion(requestId: string, answers: unknown): Promise<PendingResponseOutcome>;
}
//#endregion
//#region src/index.d.ts
/**
 * dsh-deeppilot — data bridge between the DSH host and DeepPilot
 * clients. Registers exactly one WebSocket upgrade route (/phone) plus an
 * optional health probe (/phone/health) on the existing web server. The web
 * UI is never touched.
 *
 * Data plane: an in-process HostBridge consumes apiProxy.events.mux()/host()
 * streams, mirrors session summaries, tracks pending approvals/questions,
 * and fans projected protocol-v1 pushes out to every connected device.
 *
 * Protocol: src/protocol.ts, v1. The private app repository carries the
 * matching normative document and Swift models.
 */
declare const name = "deeppilot";
/** No eager service requirement: profiles without a web stack simply skip. */
declare const inject: string[];
interface Config {
  /** Master switch; when false the plugin activates and does nothing. */
  enabled?: boolean;
  /** Pairing token file (0600); generated on first boot when missing. */
  authTokenPath?: string;
  /** Paired-device registry JSON path. */
  devicesPath?: string;
  /** Replay ring buffer bound (frames) per deployment. */
  historyBufferMax?: number;
  /** Verbose per-frame diagnostics (never prints token or message bodies). */
  debug?: boolean;
  /** Optional embedded remote transport. Reconciled when settings change. */
  remote?: {
    enabled?: boolean;
    provider?: string;
    hostname?: string;
    statePath?: string;
    helperPath?: string;
    funnelPort?: number;
  };
  /**
   * Offline push (F-9). provider 'apns' sends direct Apple Push Notification
   * deliveries from this Mac — outbound-only, no relay server, requires the
   * user's own Apple developer credentials. provider 'relay' forwards notify
   * projections to an operator-run relay (relay/server.js) holding the
   * distributor's key — used when the App ships via TestFlight/App Store.
   *
   * Deliberately NO environment knob here: each device reports its own
   * environment when registering (derived from its build kind), and
   * deliveries route per device — mixed dev/TestFlight phones coexist.
   */
  push?: {
    /** 'none' (default) | 'apns' | 'relay'. */
    provider?: string;
    /** Apple Developer team id (JWT iss claim). */
    teamId?: string;
    /** APNs auth key id (JWT kid header). */
    keyId?: string;
    /** .p8 private key path; generated keys live under the bridge data dir. */
    keyPath?: string;
    /** App bundle id — the apns-topic header. */
    bundleId?: string;
    /** Relay base URL (https). See relay/README.md. */
    relayUrl?: string;
    /** Per-user bearer token issued by the relay operator. */
    relayToken?: string;
  };
}
declare const Config: z<Schemastery.ObjectS<{
  enabled: z<boolean, boolean>;
  authTokenPath: z<string, string>;
  devicesPath: z<string, string>;
  historyBufferMax: z<number, number>;
  debug: z<boolean, boolean>;
  remote: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    provider: z<string, string>;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    provider: z<string, string>;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<number, number>;
  }>>;
  push: z<Schemastery.ObjectS<{
    provider: z<string, string>;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>, Schemastery.ObjectT<{
    provider: z<string, string>;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>>;
}>, Schemastery.ObjectT<{
  enabled: z<boolean, boolean>;
  authTokenPath: z<string, string>;
  devicesPath: z<string, string>;
  historyBufferMax: z<number, number>;
  debug: z<boolean, boolean>;
  remote: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    provider: z<string, string>;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<number, number>;
  }>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    provider: z<string, string>;
    hostname: z<string, string>;
    statePath: z<string, string>;
    helperPath: z<string, string>;
    funnelPort: z<number, number>;
  }>>;
  push: z<Schemastery.ObjectS<{
    provider: z<string, string>;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>, Schemastery.ObjectT<{
    provider: z<string, string>;
    teamId: z<string, string>;
    keyId: z<string, string>;
    keyPath: z<string, string>;
    bundleId: z<string, string>;
    relayUrl: z<string, string>;
    relayToken: z<string, string>;
  }>>;
}>>;
/** Authorization is preferred; the query form remains for older app builds. */
declare function requestToken(req: Pick<IncomingMessage, 'url' | 'headers'>): string | null;
declare function apply(ctx: Context, options: unknown): void;
//#endregion
export { Config, HostBridge, apply, inject, name, requestToken };
//# sourceMappingURL=index.d.ts.map