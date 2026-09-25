/**
 * Adapter for the DSH rc.2 controller API.
 *
 * DeepPilot's phone protocol deliberately speaks one stable in-process
 * `apiProxy` vocabulary. This adapter maps it to the current public
 * Session/Workspace controllers and Gateway-backed Remote Events, keeping
 * the phone protocol isolated from the Host API.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  startDshRemoteInteractions,
  type RemoteApprovalRequest,
  type RemoteQuestionRequest,
} from './dsh-remote-interactions.ts'
import { projectHistory } from './host-event-projection.ts'
import type {
  ApiProxyLike,
  DirectoryListingLike,
  HistoryResult,
  HostSessionModels,
  MuxFrameLike,
  PhoneSessionRow,
  ScheduleHistoryViewLike,
  ScheduleTaskViewLike,
  WorkspaceViewLike,
} from './host-api.ts'

interface RpcOk<T> { ok: true; value: T }
interface RpcErr { ok: false; error: { code: string; message?: string } }
type RpcResult<T> = RpcOk<T> | RpcErr

interface SessionControllerLike {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: readonly unknown[] }>
  inspect(sessionId: string, signal?: AbortSignal): Promise<{ events: readonly unknown[] }>
  create(request: Record<string, unknown>): Promise<{ sessionId: string; agentPreset?: string }>
  fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
  modelCatalog(): Promise<unknown>
  selectModel(request: Record<string, unknown>): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  prompt(request: Record<string, unknown>, signal: AbortSignal): Promise<{ accepted: true }>
  attachment(request: { sessionId: string; attachmentId: string }): Promise<{ attachment: { mediaType?: string }; data: string }>
  cancel(request: { sessionId: string }): { accepted: true }
  /** Non-activating projection baseline for one session. */
  projections(request: { sessionId: string }, signal?: AbortSignal):
    Promise<{ asOfSeq: number; values: Record<string, unknown> } | null>
}

interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: unknown; created: boolean }>
  archiveSession(request: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>
  unarchiveSession(request: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>
  follow(signal: AbortSignal): AsyncIterable<{ type: string; value?: unknown }>
}

interface ScheduleControllerLike {
  list(request: { sessionId: string }): Promise<readonly unknown[]>
  history(request: { sessionId: string; id: string; limit: number; before?: string }): Promise<unknown>
  create(sessionId: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  update(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  delete(request: { sessionId: string; id: string }, signal?: AbortSignal): Promise<unknown>
}

interface DirectoryPickerControllerLike {
  list(path: string | undefined, signal: AbortSignal): Promise<DirectoryListingLike>
  pick(signal: AbortSignal): Promise<string | null>
}

interface DeferredInteraction {
  resolve(value: unknown): void
  /** Convert the stable phone-protocol response into a Host waterfall result. */
  map(value: unknown): unknown
}

/** Which first-answer-wins interaction a phone may surface. */
export type DshInteractionKind = 'approval' | 'question'

export interface DshApiProxyOptions {
  /**
   * Decide whether the resident DeepPilot Remote Client represents a usable
   * phone surface. Returning false delegates only this Client delivery; API
   * Gateway keeps the official Web delivery independent.
   */
  shouldSurfaceInteraction?: (kind: DshInteractionKind) => boolean
}

/** Direct-controller adapter with the shape HostBridge consumes. */
export class DshApiProxy implements ApiProxyLike {
  private readonly session: SessionControllerLike
  private readonly workspaceController: WorkspaceControllerLike | undefined
  private readonly scheduleController: ScheduleControllerLike | undefined
  private readonly directoryPicker: DirectoryPickerControllerLike | undefined
  private readonly interactions = new Map<string, DeferredInteraction>()
  private readonly shouldSurfaceInteraction: (kind: DshInteractionKind) => boolean
  private readonly scheduleApi: ApiProxyLike['schedule']

  constructor(private readonly ctx: Context, options: DshApiProxyOptions = {}) {
    const session = ctx.get('sessionController') as SessionControllerLike | undefined
    if (session === undefined) throw new Error('DSH sessionController is unavailable')
    this.session = session
    this.workspaceController = ctx.get('workspaceController') as WorkspaceControllerLike | undefined
    this.scheduleController = ctx.get('schedule') as ScheduleControllerLike | undefined
    // A profile without the optional workspace service cannot restore a
    // session; keep the phone capability bit honest.
    if (this.workspaceController === undefined) delete this.workspace?.unarchiveSession
    this.directoryPicker = ctx.get('directoryPickerController') as DirectoryPickerControllerLike | undefined
    this.shouldSurfaceInteraction = options.shouldSurfaceInteraction ?? (() => true)
    this.scheduleApi = this.scheduleController === undefined ? undefined : this.createScheduleApi()
  }

  get schedule(): ApiProxyLike['schedule'] {
    return this.scheduleApi
  }

  private createScheduleApi(): NonNullable<ApiProxyLike['schedule']> {
    const controller = this.scheduleController!
    return {
      list: async (request) => this.call(async () => ({
        sessionId: request.payload!.sessionId,
        tasks: (await controller.list({ sessionId: request.payload!.sessionId })).map(toScheduleTask),
      })),
      history: async (request) => this.call(async () => {
        const value = await controller.history({
          sessionId: request.payload!.sessionId,
          id: request.payload!.id,
          limit: request.payload!.limit,
          ...(request.payload!.before !== undefined ? { before: request.payload!.before } : {}),
        }) as Record<string, unknown>
        if (typeof value.code === 'string') {
          throw Object.assign(new Error(String(value.code)), { code: value.code })
        }
        return { sessionId: request.payload!.sessionId, history: toScheduleHistory(value) }
      }),
      create: async (request) => this.call(async () => {
        const { sessionId, ...createRequest } = request.payload!
        return toScheduleTask(await controller.create(sessionId, createRequest))
      }),
      update: async (request) => this.call(async () => {
        const payload = request.payload!
        const result = await controller.update({
          ...payload,
          expected: toScheduleExpected(payload.expected),
        }) as Record<string, unknown>
        return {
          id: String(result.id ?? payload.id),
          updated: result.updated === true,
          ...(result.record !== undefined ? { record: toScheduleTask(result.record) } : {}),
          ...(typeof result.code === 'string' ? { code: result.code } : {}),
        }
      }),
      delete: async (request) => this.call(async () => {
        const result = await controller.delete({ sessionId: request.payload!.sessionId, id: request.payload!.id }) as Record<string, unknown>
        return { id: String(result.id), deleted: result.deleted === true, ...(result.code !== undefined ? { code: String(result.code) } : {}) }
      }),
    }
  }

  /**
   * Decide whether this Gateway Client can surface a phone card. The decision
   * fails open to false so a broken device registry delegates this delivery
   * while the official Web Client remains able to answer.
   */
  private canSurfaceInteraction(kind: DshInteractionKind): boolean {
    try {
      return this.shouldSurfaceInteraction(kind)
    } catch {
      return false
    }
  }

  readonly sessions: ApiProxyLike['sessions'] = {
    list: async () => this.call(async () => {
      const value = await this.session.list({}, new AbortController().signal)
      // Keep worker identity internally so HostBridge can suppress notifications
      // as well as exclude these rows from the phone's session list.
      return { items: value.items.map(toPhoneSessionRow) }
    }),
    history: async (request) => this.call(async () => {
      const sessionId = request.payload!.sessionId
      let inspected: { events: readonly unknown[] }
      try {
        inspected = await this.session.inspect(sessionId)
      } catch (error) {
        // No message data is logged: only the opaque session id and Host's
        // safe error chain, enough to distinguish an unsupported legacy log
        // from a bridge regression.
        console.warn(`[deeppilot] session history unavailable for ${JSON.stringify(sessionId)}: ${toError(error).code}: ${toError(error).message}`)
        throw error
      }
      const before = request.payload?.beforeSeq
      const limit = Math.max(1, request.payload?.maxMessages ?? 100)
      const source = inspected.events
        .filter((event): event is HistoryResult['events'][number]['event'] =>
          typeof event === 'object' && event !== null
          && typeof (event as { type?: unknown }).type === 'string'
          && typeof (event as { seq?: unknown }).seq === 'number')
        .filter(event => before === undefined || event.seq < before)
      let end = source.length
      let events: HistoryResult['events'] = []
      while (end > 0 && projectHistory(events).length < limit) {
        const start = Math.max(0, end - limit)
        events = [
          ...source.slice(start, end).map(event => ({ event })),
          ...events,
        ]
        end = start
      }
      let trimmed = false
      while (events.length > 0 && projectHistory(events).length > limit) {
        events = events.slice(1)
        trimmed = true
      }
      return { events, hasMore: end > 0 || trimmed }
    }),
    prompt: async (request) => this.call(() => this.session.prompt({
      ...request.payload!,
      requestId: request.rpcId ?? randomUUID(),
    }, new AbortController().signal)),
    create: async (request) => this.call(() => this.session.create(request.payload ?? {})),
    fork: async (request) => this.call(() => this.session.fork(request.payload!)),
    models: async (request) => this.call(async () => projectModels(
      await this.session.modelCatalog(),
      String(request.payload?.sessionId ?? ''),
      await this.session.list({}, new AbortController().signal),
    )),
    selectModel: async (request) => this.call(() => this.session.selectModel(request.payload ?? {})),
    rename: async (request) => this.call(() => this.session.rename(request.payload!)),
    cancel: async (request) => this.call(() => this.session.cancel(request.payload!)),
    attachment: async (request) => this.call(() => this.session.attachment(request.payload!)),
    projections: async (request) => this.call(() => this.session.projections(request.payload!)),
  }

  readonly workspace: ApiProxyLike['workspace'] = {
    list: async () => this.call(async () => {
      if (this.workspaceController === undefined) throw unavailable('workspace controller unavailable')
      const baseline = await readWorkspaceBaseline(this.workspaceController)
      return {
        items: baseline.items.map(toWorkspaceView),
        archivedSessionIds: baseline.archivedSessionIds.map(String),
      }
    }),
    create: async (request) => this.call(async () => {
      if (this.workspaceController === undefined) throw unavailable('workspace controller unavailable')
      const value = await this.workspaceController.create(request.payload!)
      return { workspace: toWorkspaceView(value.workspace), created: value.created === true }
    }),
    archiveSession: async (request) => this.call(async () => {
      if (this.workspaceController === undefined) throw unavailable('workspace controller unavailable')
      const value = await this.workspaceController.archiveSession(request.payload!)
      return { archivedSessionIds: [...value.archivedSessionIds] }
    }),
    unarchiveSession: async (request) => this.call(async () => {
      if (this.workspaceController === undefined) throw unavailable('workspace controller unavailable')
      const value = await this.workspaceController.unarchiveSession(request.payload!)
      return { archivedSessionIds: [...value.archivedSessionIds] }
    }),
  }

  readonly host: ApiProxyLike['host'] = {
    listDirectory: async (request, signal) => this.call(async () => {
      if (this.directoryPicker === undefined) throw unavailable('directory picker unavailable')
      return await this.directoryPicker.list(request.payload?.path, signal ?? new AbortController().signal)
    }),
    pickDirectory: async (_request, signal) => this.call(async () => {
      if (this.directoryPicker === undefined) throw unavailable('directory picker unavailable')
      return { path: await this.directoryPicker.pick(signal ?? new AbortController().signal) }
    }),
  }

  readonly events: ApiProxyLike['events'] = {
    mux: (_request, signal) => this.mux(signal),
    host: (_request, signal) => this.hostEvents(signal),
  }

  async respond(message: { type: 'client-response'; rpcId: string; result: RpcResult<unknown> }): Promise<{ accepted: boolean; reason?: string }> {
    const pending = this.interactions.get(message.rpcId)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    if (!message.result.ok) return { accepted: false, reason: 'bad-response' }
    this.interactions.delete(message.rpcId)
    pending.resolve(pending.map(message.result.value))
    return { accepted: true }
  }

  private async *mux(signal: AbortSignal): AsyncIterable<MuxFrameLike> {
    const queue = new AsyncFrameQueue(signal)
    const offEvent = this.ctx.on('session/event' as never, ((session: { id: string; header?: { origin?: string } }, event: unknown) => {
      queue.push({
        type: 'session/event', sessionId: String(session.id),
        // Header origin is available before the next list refresh. A header's
        // parentSession alone is fork lineage, not proof of a worker session.
        isSubagent: session.header?.origin === 'subagent',
        event: event as MuxFrameLike['event'],
      })
    }) as never, { global: true })
    const projections = this.ctx.get('sessionProjections') as {
      onChanged?(listener: (session: { id: string }, key: string, value: unknown) => void): () => void
    } | undefined
    const offProjection = projections?.onChanged?.((session, key, value) => {
      queue.push({ type: 'session/projection', sessionId: String(session.id), key, value })
    })

    let disposeInteractions: (() => Promise<void>) | undefined
    try {
      disposeInteractions = await startDshRemoteInteractions(this.ctx, {
        approval: (sessionId, request, next) => this.answerApproval(queue, sessionId, request, next),
        question: (sessionId, request, next) => this.answerQuestion(queue, sessionId, request, next),
      })
    } catch (error) {
      console.warn(`[deeppilot] DSH Remote interaction client unavailable: ${toError(error).message}`)
    }

    try {
      yield* queue.iterate()
    } finally {
      offEvent()
      offProjection?.()
      await disposeInteractions?.()
      queue.close()
    }
  }

  private answerApproval(
    queue: AsyncFrameQueue,
    sessionId: string,
    request: RemoteApprovalRequest,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!this.canSurfaceInteraction('approval')) return next()
    const rpcId = randomUUID()
    const response = deferred<unknown>()
    const abort = (): void => response.resolve('cancelled')
    request.signal?.addEventListener('abort', abort, { once: true })
    this.interactions.set(rpcId, {
      resolve: response.resolve,
      map: value => {
        const outcome = (value as { outcome?: unknown } | undefined)?.outcome
        return outcome === 'allowed-once' || outcome === 'rejected' ? outcome : 'unavailable'
      },
    })
    queue.push({
      type: 'approval/requested', rpcId, sessionId, approvalId: rpcId,
      toolName: String(request.toolName ?? 'tool'), reason: String(request.reason ?? ''),
      ...(request.callId ? { callId: request.callId } : {}),
    })
    return response.promise.finally(() => {
      request.signal?.removeEventListener('abort', abort)
      this.interactions.delete(rpcId)
      queue.push({ type: 'approval/resolved', approvalId: rpcId })
    })
  }

  private answerQuestion(
    queue: AsyncFrameQueue,
    sessionId: string,
    request: RemoteQuestionRequest,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    if (!this.canSurfaceInteraction('question')) return next()
    const rpcId = randomUUID()
    const response = deferred<unknown>()
    const abort = (): void => response.reject(new Error('question cancelled'))
    request.signal?.addEventListener('abort', abort, { once: true })
    this.interactions.set(rpcId, {
      resolve: response.resolve,
      map: value => (value as { answer?: unknown } | undefined)?.answer ?? value,
    })
    queue.push({ type: 'question/requested', rpcId, sessionId, questions: request.questions ?? [] })
    return response.promise.finally(() => {
      request.signal?.removeEventListener('abort', abort)
      this.interactions.delete(rpcId)
      queue.push({ type: 'question/resolved', questionRpcId: rpcId })
    })
  }

  private async *hostEvents(signal: AbortSignal): AsyncIterable<MuxFrameLike> {
    const queue = new AsyncFrameQueue(signal)
    const listen = (event: string, type: string, project?: (...args: unknown[]) => Record<string, unknown>) =>
      this.ctx.on(event as never, ((...args: unknown[]) => queue.push({ type, ...(project?.(...args) ?? {}) })) as never, { global: true })
    const off = [
      listen('api-session/added', 'host/session-added'),
      listen('api-session/removed', 'host/session-removed'),
      listen('api-session/status', 'host/session-status', (sessionId, running) => ({ sessionId: String(sessionId), running: running === true })),
      listen('api-session/activity', 'host/session-added'),
      listen('schedule/changed', 'host/schedule-changed'),
    ]
    const workspaceAbort = new AbortController()
    const stop = (): void => workspaceAbort.abort()
    signal.addEventListener('abort', stop, { once: true })
    const workspaceTask = this.workspaceController === undefined ? undefined : (async () => {
      try {
        for await (const frame of this.workspaceController!.follow(workspaceAbort.signal)) {
          if (frame.type === 'archived') queue.push({ type: 'host/archived-sessions-changed', archivedSessionIds: (frame as { archivedSessionIds?: unknown }).archivedSessionIds } as MuxFrameLike)
          else if (frame.type !== 'baseline') queue.push({ type: 'host/workspace-changed' })
        }
      } catch { /* Host shutdown / withdrawn controller ends the stream. */ }
    })()
    try {
      yield* queue.iterate()
    } finally {
      for (const dispose of off) dispose()
      signal.removeEventListener('abort', stop)
      workspaceAbort.abort()
      void workspaceTask
      queue.close()
    }
  }

  private async call<T>(invoke: () => T | Promise<T>): Promise<{ result: RpcResult<T> }> {
    try { return { result: { ok: true, value: await invoke() } } }
    catch (error) { return { result: { ok: false, error: toError(error) } } }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

class AsyncFrameQueue {
  private readonly frames: MuxFrameLike[] = []
  private wake: (() => void) | undefined
  private closed = false
  constructor(signal: AbortSignal) {
    signal.addEventListener('abort', () => this.close(), { once: true })
  }
  push(frame: MuxFrameLike): void { if (!this.closed) { this.frames.push(frame); this.wake?.() } }
  close(): void { if (!this.closed) { this.closed = true; this.wake?.() } }
  async *iterate(): AsyncIterable<MuxFrameLike> {
    while (!this.closed) {
      const frame = this.frames.shift()
      if (frame !== undefined) { yield frame; continue }
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

function unavailable(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'directory-picker-unavailable' })
}
function toError(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; message?: unknown }
  return { code: typeof value?.code === 'string' ? value.code : 'internal', message: typeof value?.message === 'string' ? value.message : String(error) }
}
function toPhoneSessionRow(value: unknown): PhoneSessionRow {
  const row = value as Record<string, unknown>
  return {
    sessionId: String(row.sessionId ?? ''), updatedAt: Number(row.updatedAt ?? Date.now()), running: row.running === true,
    ...(row.blank === true ? { blank: true } : {}), ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
    ...(typeof row.origin === 'string' ? { origin: row.origin } : {}), ...(typeof row.parentSessionId === 'string' ? { parentSessionId: row.parentSessionId } : {}),
    ...(row.projections && typeof row.projections === 'object' ? { projections: row.projections as PhoneSessionRow['projections'] } : {}),
  }
}
function toWorkspaceView(value: unknown): WorkspaceViewLike {
  const row = value as Record<string, unknown>
  return { workspaceId: String(row.workspaceId ?? ''), title: String(row.title ?? ''), path: String(row.path ?? ''), sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.map(String) : [] }
}
function toScheduleExpected(value: unknown): Record<string, unknown> {
  const row = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const { state: _state, deliveryMode: _deliveryMode, ...record } = row
  return record
}
function toScheduleTask(value: unknown): ScheduleTaskViewLike {
  const row = value as Record<string, unknown>
  const kind = ['after', 'at', 'every', 'daily', 'weekly', 'cron'].includes(String(row.kind))
    ? String(row.kind) as ScheduleTaskViewLike['kind']
    : 'at'
  const optionalNumber = (key: string): number | undefined => typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] as number : undefined
  return {
    id: String(row.id ?? ''),
    kind,
    title: String(row.title ?? ''),
    prompt: String(row.prompt ?? ''),
    scheduledAt: String(row.scheduledAt ?? ''),
    state: row.state === 'overdue' ? 'overdue' : 'scheduled',
    deliveryMode: 'host',
    ...(optionalNumber('afterSeconds') !== undefined ? { afterSeconds: optionalNumber('afterSeconds')! } : {}),
    ...(optionalNumber('everySeconds') !== undefined ? { everySeconds: optionalNumber('everySeconds')! } : {}),
    ...(typeof row.time === 'string' ? { time: row.time } : {}),
    ...(typeof row.timeZone === 'string' ? { timeZone: row.timeZone } : {}),
    ...(Array.isArray(row.weekdays) ? { weekdays: row.weekdays.filter((day): day is number => typeof day === 'number') } : {}),
    ...(typeof row.expression === 'string' ? { expression: row.expression } : {}),
  }
}
function toScheduleHistory(value: unknown): ScheduleHistoryViewLike {
  const row = value as Record<string, unknown>
  const records = Array.isArray(row.records) ? row.records : []
  return {
    id: String(row.id ?? ''),
    records: records.map((entry) => {
      const item = entry as Record<string, unknown>
      return {
        scheduledAt: String(item.scheduledAt ?? ''),
        deliveredAt: String(item.deliveredAt ?? ''),
        messageId: String(item.messageId ?? ''),
        ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : {}),
      }
    }),
    earlierRecordsUnavailable: row.earlierRecordsUnavailable === true,
    ...(typeof row.earlierRecordsPruned === 'boolean' ? { earlierRecordsPruned: row.earlierRecordsPruned } : {}),
    retention: {
      days: Number((row.retention as { days?: unknown } | undefined)?.days ?? 0),
      records: Number((row.retention as { records?: unknown } | undefined)?.records ?? 0),
    },
    ...(typeof row.nextBefore === 'string' ? { nextBefore: row.nextBefore } : {}),
  }
}
async function readWorkspaceBaseline(controller: WorkspaceControllerLike): Promise<{ items: WorkspaceViewLike[]; archivedSessionIds: string[] }> {
  const abort = new AbortController()
  const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    const baseline = first.value as { type?: string; value?: { items?: unknown[]; archivedSessionIds?: unknown[] } } | undefined
    if (baseline?.type !== 'baseline') throw new Error('workspace follow did not provide a baseline')
    return { items: (baseline.value?.items ?? []).map(toWorkspaceView), archivedSessionIds: (baseline.value?.archivedSessionIds ?? []).map(String) }
  } finally { abort.abort(); await iterator.return?.() }
}
async function projectModels(catalog: unknown, sessionId: string, list: { items: readonly unknown[] }): Promise<HostSessionModels> {
  const value = catalog as { default?: { provider?: string; model?: string; reasoningEffort?: string }; groups?: unknown[]; failures?: unknown[] }
  const row = list.items.map(toPhoneSessionRow).find(item => item.sessionId === sessionId)
  const selected = (row?.projections?.values?.modelSelection as { next?: unknown } | undefined)?.next as { provider?: string; model?: string; reasoningEffort?: string } | undefined
  return {
    current: { provider: String(selected?.provider ?? value.default?.provider ?? ''), model: String(selected?.model ?? value.default?.model ?? ''), ...(typeof selected?.reasoningEffort === 'string' ? { reasoningEffort: selected.reasoningEffort } : {}) },
    routable: true,
    groups: Array.isArray(value.groups) ? value.groups as HostSessionModels['groups'] : [],
    failures: Array.isArray(value.failures) ? value.failures as HostSessionModels['failures'] : [],
  }
}
