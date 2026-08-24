/**
 * DeepPilot Bridge Protocol v1 — shared frame vocabulary (TypeScript face).
 * The normative spec is protocol/PROTOCOL.md at the repo root; this module
 * mirrors it for the plugin implementation. The iOS app hand-mirrors the
 * same shapes in Swift.
 */

export const PROTOCOL_VERSION = 1

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

export interface HelloAuthPayload {
  /** Optional after Bearer authentication; required for an unauthenticated upgrade. */
  token?: string
  deviceId: string
  deviceName: string
  appVersion: string
  resumeCursor?: number
}

export interface SessionOpenPayload { sessionId: string; tailCount?: number }
export interface SessionClosePayload { sessionId: string }
export interface SessionHistoryPayload { sessionId: string; beforeSeq: number; limit: number }
export interface SessionModelsRequestPayload { sessionId: string }
export interface SessionSelectModelPayload extends ModelSelection { sessionId: string }
export interface SessionRenamePayload { sessionId: string; title: string }
export interface SessionArchivePayload { sessionId: string }
export interface SessionCancelPayload { sessionId: string }
export interface SessionCreatePayload { workspaceId?: string; cwd?: string }
export interface DirectoryListPayload { path?: string }
export interface WorkspaceCreatePayload { path: string }
export interface PromptImagePayload { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
export interface SendPromptPayload { sessionId: string; text: string; images?: PromptImagePayload[] }
export interface ApprovalRespondPayload { requestId: string; decision: "allow" | "deny"; reason?: string }
export interface QuestionAnswer { id: string; selected: string[]; custom: string }
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

// ---------- s2c payloads ----------

export interface WelcomeCapabilities {
  historyPaging: boolean
  replay: boolean
  approvals: boolean
  questions: boolean
  models: boolean
  sessionManagement: boolean
  projectSelection: boolean
  /** Bridge has APNs configured; clients may send c2s.push.register. */
  push?: boolean
}

export interface WelcomePayload {
  protocolVersion: number
  serverVersion: string
  capabilities: WelcomeCapabilities
  cursor: number
  resumed: boolean
}

export type SessionStatus = "running" | "idle" | "error" | "unknown"

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
  pendingApproval: boolean
  pendingQuestion: boolean
  workspaceLabel: string | null
  workspaceId?: string | null
  workspacePath?: string | null
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

/** One image carried by a user message. `attachmentId` keys the read-back RPC
 * (c2s.session.attachment); width/height let clients reserve layout space. */
export interface MessageAttachment {
  kind: 'image'
  name?: string
  mediaType?: string
  attachmentId?: string
  width?: number
  height?: number
}

export interface MessageProjection {
  seq: number
  role: MessageRole
  text?: string
  /** Reasoning ("thinking") text accompanying the answer, when present. */
  thinking?: string
  streaming?: boolean
  tool?: { name: string; state: ToolState; summary: string }
  attachments?: MessageAttachment[]
  ts: number
  truncated?: boolean
}

/** Payload of c2s.session.attachment: read one durable image back. */
export interface SessionAttachmentPayload {
  sessionId: string
  attachmentId: string
}

export interface SessionTailPayload {
  sessionId: string
  messages: MessageProjection[]
  oldestSeq: number
  hasMore: boolean
}

export interface HistoryPagePayload {
  sessionId: string
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
  text?: string
  ok?: boolean
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
  notificationId: string
  category: NotifyCategory
  sessionId: string
  title: string
  body: string
  ts: number
}

/**
 * One offline-push-worthy event (same facts as s2c.notify / pending frames,
 * projected for APNs). The bridge fans these out to paired devices that hold
 * an APNs token and no live WebSocket.
 */
export interface PushNotification {
  notificationId: string
  category: NotifyCategory
  sessionId: string
  title: string
  body: string
}

export interface PendingApprovalPayload {
  requestId: string
  sessionId: string
  toolName: string
  summary: string
  riskLevel: 'read' | 'write' | 'destructive'
}

export interface PendingQuestionOption { label: string; description?: string }
export interface PendingQuestionItem {
  id: string
  question: string
  multiSelect: boolean
  options: PendingQuestionOption[]
}
export interface PendingQuestionPayload {
  requestId: string
  sessionId: string
  questions: PendingQuestionItem[]
}
export interface PendingClearedPayload { requestId: string }
export interface ResyncPayload { reason: "gap" }
export interface ErrorPayload { code: string; message: string }

export const ERROR_CODES = {
  E_AUTH: 'token missing or invalid',
  E_PROTOCOL: 'unknown type or malformed payload',
  E_NOT_FOUND: 'session or request not found',
  E_BUSY: 'session is busy',
  E_UNSUPPORTED: 'protocol version or capability unsupported',
  E_INTERNAL: 'internal error',
} as const
