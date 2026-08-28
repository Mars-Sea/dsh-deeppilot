import type { PushNotification } from './protocol.ts'

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

export type ModelBridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'unsupported' | 'not-found' | 'busy' | 'unavailable' | 'internal'; message: string }

export type SessionManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'unsupported' | 'not-found' | 'busy' | 'invalid' | 'internal'; message: string }

export interface PromptArgs {
  sessionId: string
  mode: 'queue' | 'steer'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string }
  >
  clientTimeZone?: string
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
 */
export function isSubagentRow(row: PhoneSessionRow): boolean {
  return row.origin === 'subagent' ||
    (typeof row.parentSessionId === 'string' && row.parentSessionId.length > 0);
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
