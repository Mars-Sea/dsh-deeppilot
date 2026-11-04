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
import { historyWindow, normalizePageLimit } from './host-event-projection.ts'
import { DshCommandApi } from './command-api.ts'
import type { CommandsApiLike } from './host-api.ts'
import type {
  ApiProxyLike,
  DirectoryListingLike,
  HistoryResult,
  HostScheduleCreateRequestLike,
  HostScheduleDeleteEndedResult,
  HostScheduleEditOutcome,
  HostScheduleEditRequestLike,
  HostScheduleLimitsView,
  HostScheduleListResultLike,
  HostScheduleRunOutcome,
  HostScheduleTaskView,
  HostScheduleViewOutcome,
  HostSessionModels,
  LegacyScheduleApiLike,
  MuxFrameLike,
  PhoneSessionRow,
  ScheduleHistoryViewLike,
  ScheduleTaskViewLike,
  SessionEventLike,
  WorkspaceViewLike,
} from './host-api.ts'
import type {
  HostScheduleCreateSpec,
  HostScheduleDeliveryReceipt,
  HostSchedulePatch,
  HostScheduleTarget,
  HostScheduleTargetRequest,
  HostScheduleTiming,
} from './protocol.ts'

interface RpcOk<T> { ok: true; value: T }
interface RpcErr { ok: false; error: { code: string; message?: string } }
type RpcResult<T> = RpcOk<T> | RpcErr

interface SessionControllerLike {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: readonly unknown[] }>
  /**
   * Whole-log read used by `sessions.history`.
   *
   * DSH 0.2.2-alpha.2 removed this method in favour of `page`. The seven earlier
   * admitted hosts still have it and cannot be served by `page` instead: their
   * `SessionPageRequest.throughSeq` is mandatory and validated, while this
   * adapter has no log cursor to pass. `sessions.history` therefore branches on
   * the presence of `inspect` rather than switching every host to one path.
   */
  inspect?(sessionId: string, signal?: AbortSignal): Promise<{ events: readonly unknown[] }>
  /**
   * One message-aligned history page; present on every admitted host.
   *
   * Its `beforeSeq` is a log offset, not the seq the phone sends, so a backward
   * cut has to travel as the inclusive `throughSeq` instead.
   */
  page?(request: {
    address: { kind: 'session'; sessionId: string }
    throughSeq?: number
    maxMessages?: number
  }, signal: AbortSignal): Promise<{ records: readonly unknown[]; hasMore: boolean }>
  create(request: Record<string, unknown>): Promise<{ sessionId: string; agentPreset?: string }>
  fork(request: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>
  modelCatalog(): Promise<unknown>
  selectModel(request: Record<string, unknown>): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  prompt(request: Record<string, unknown>, signal: AbortSignal): Promise<{ accepted: true }>
  attachment(request: { sessionId: string; attachmentId: string }): Promise<{ attachment: { mediaType?: string }; data: string }>
  cancel(request: { sessionId: string }): { accepted: true }
  /** Absent on hosts that predate DSH's pending-queue RPC. */
  updateQueue?(request: { sessionId: string; itemId: string; action: { kind: string } }): Promise<{ accepted: true }>
  /**
   * Non-activating projection baseline for one session.
   *
   * The signal is mandatory: DSH 0.2.1-alpha.2 aborts before it reads anything,
   * so a caller that omits it gets no baseline at all. The bridge's refresh is
   * fire-and-forget and has no lifetime of its own, so callers pass a signal
   * that never aborts.
   */
  projections(request: { sessionId: string }, signal: AbortSignal):
    Promise<{ asOfSeq: number; values: Record<string, unknown> } | null>
}

interface WorkspaceControllerLike {
  create(request: { path: string }): Promise<{ workspace: unknown; created: boolean }>
  archiveSession(request: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>
  unarchiveSession(request: { sessionId: string }): Promise<{ archivedSessionIds: readonly string[] }>
  follow(signal: AbortSignal): AsyncIterable<{ type: string; value?: unknown }>
}

/** 会话级 Schedule 控制器（DSH ≤ 0.2.2-alpha.2）：任务绑定单一 Session。 */
interface LegacyScheduleControllerLike {
  list(request: { sessionId: string }): Promise<readonly unknown[]>
  history(request: { sessionId: string; id: string; limit: number; before?: string }): Promise<unknown>
  create(sessionId: string, request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  update(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  delete(request: { sessionId: string; id: string }, signal?: AbortSignal): Promise<unknown>
}

/**
 * 宿主级 Schedule 控制器（DSH 0.2.2-alpha.3 起）。
 *
 * 方法按真实服务面声明：`list` 返回分页对象、`view` 返回任务或 miss 结果、
 * `create/edit/run` 返回任务/删除/冲突/进行中等结果对象，`edit` 取代了
 * update/delete，`deliveryLimits` 是同步读取。返回值保持 unknown：适配层负责
 * 形状归一化，控制器细节不外泄给 Bridge。
 */
interface HostScheduleControllerLike {
  list(request?: { active?: boolean; limit?: number; offset?: number }): Promise<unknown>
  view(request: { id: string }): Promise<unknown>
  create(request: Record<string, unknown>, actorSessionId?: unknown, signal?: AbortSignal): Promise<unknown>
  edit(request: Record<string, unknown>, actorSessionId?: unknown, signal?: AbortSignal): Promise<unknown>
  run(request: { id: string }, signal?: AbortSignal): Promise<unknown>
  history(request: { id: string; limit: number; before?: string }): Promise<unknown>
  deliveryLimits(): unknown
  /** 上游名沿用 alpha.2 的 inactive，alpha.3 实际删除的是 `status="ended"` 的任务。 */
  deleteInactive(): Promise<unknown>
}

type ScheduleControllerLike = LegacyScheduleControllerLike | HostScheduleControllerLike

/**
 * 形状探测：宿主级模型只有 `edit`（没有 `update`）。不按版本号字符串判断——
 * 版本号无法说明 Schedule bundle 是否挂载、也无法覆盖回退组合。
 */
function isHostScheduleController(controller: ScheduleControllerLike): controller is HostScheduleControllerLike {
  const value = controller as { edit?: unknown; update?: unknown }
  return typeof value.edit === 'function' && typeof value.update !== 'function'
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
  /** Probe the Host's generated reflection, not this adapter's listener registration. */
  get assistantStreamAvailable(): boolean {
    const typert = this.ctx.get('typert') as {
      getPackage?(name: string, face: 'host'): {
        model?: { services?: Array<{ key?: string; types?: Array<{ name?: string }> }> }
      } | undefined
    } | undefined
    try {
      return typert?.getPackage?.('@deepseek-ai/dsh-api-session-controller', 'host')?.model?.services
        ?.some(service => service.key === 'sessionController' &&
          service.types?.some(type => type.name === 'SessionAssistantStreamFrame')) === true
    } catch {
      // 可选反射尚未注册时只关闭流能力，不让 welcome 握手随它失败。
      return false
    }
  }

  private readonly commandApi: DshCommandApi
  get commands(): CommandsApiLike | undefined {
    if (!this.commandApi.available) return undefined
    return {
      list: request => this.call(() => this.commandApi.list(request.payload!.sessionId)),
      execute: request => this.call(() => this.commandApi.execute(request.payload!.sessionId, request.payload!.line, request.payload!.attachments, request.payload!.expectedDefinitionId)),
      permissions: request => this.call(() => this.commandApi.permissions(request.payload!.sessionId)),
      feedback: request => this.call(() => this.commandApi.feedback(request.payload!.sessionId, request.payload!.text, request.payload!.category)),
      markdownAvailable: this.commandApi.markdownAvailable,
      export: (request, signal) => this.commandApi.export(request.payload!.sessionId, signal, request.payload!.format),
    }
  }
  private readonly session: SessionControllerLike
  private readonly workspaceController: WorkspaceControllerLike | undefined
  private scheduleController: ScheduleControllerLike | undefined
  private scheduleApi: ApiProxyLike['schedule'] | undefined
  private readonly directoryPicker: DirectoryPickerControllerLike | undefined
  private readonly interactions = new Map<string, DeferredInteraction>()
  private readonly shouldSurfaceInteraction: (kind: DshInteractionKind) => boolean

  constructor(private readonly ctx: Context, options: DshApiProxyOptions = {}) {
    this.commandApi = new DshCommandApi(ctx)
    const session = ctx.get('sessionController') as SessionControllerLike | undefined
    if (session === undefined) throw new Error('DSH sessionController is unavailable')
    this.session = session
    this.workspaceController = ctx.get('workspaceController') as WorkspaceControllerLike | undefined
    // A profile without the optional workspace service cannot restore a
    // session; keep the phone capability bit honest.
    if (this.workspaceController === undefined) delete this.workspace?.unarchiveSession
    // 同理：Host 没有 updateQueue 时撤掉入口，promptQueue 能力位随之为 false。
    if (typeof this.session.updateQueue !== 'function') delete this.sessions.updateQueue
    this.directoryPicker = ctx.get('directoryPickerController') as DirectoryPickerControllerLike | undefined
    this.shouldSurfaceInteraction = options.shouldSurfaceInteraction ?? (() => true)
    this.resolveSchedule()
    // 技能服务可能晚于桥接层挂载；能力探测与请求都读取当前服务，不缓存缺席。
    Object.defineProperty(this.sessions, 'skills', { get: () => {
      const catalog = ctx.get('sessionSkillCatalog') as {
        list(request: { sessionId: string }, signal: AbortSignal): Promise<{ skills: import('./protocol.ts').SkillSummary[] }>
      } | undefined
      if (typeof catalog?.list !== 'function') return undefined
      const read: NonNullable<ApiProxyLike['sessions']['skills']> = async (request) =>
        this.call(() => catalog.list({ sessionId: request.payload!.sessionId }, new AbortController().signal))
      return read
    } })
  }

  /**
   * Resolve the optional Schedule service lazily, on every read.
   *
   * The bridge is built from a `ctx.inject` on sessionController / connection
   * / typertGateway, and `schedule` is deliberately NOT in that list: it is a
   * capability the host composition may or may not mount. On a DSH 0.2.0 host
   * those three services become ready well before ScheduleService finishes its
   * own async init, so a value captured in the constructor stayed `undefined`
   * for the bridge's whole lifetime and welcome advertised `schedules=false`
   * even with the service mounted.
   *
   * Once resolved the controller is kept: services are not torn down and
   * rebuilt underneath a live bridge, so re-resolving per call would be pure
   * overhead.
   */
  private resolveSchedule(): void {
    if (this.scheduleController !== undefined) return
    const controller = this.ctx.get('schedule') as ScheduleControllerLike | undefined
    if (controller === undefined) return
    this.scheduleController = controller
    this.scheduleApi = isHostScheduleController(controller)
      ? this.createHostScheduleApi(controller)
      : this.createLegacyScheduleApi(controller)
  }

  get schedule(): ApiProxyLike['schedule'] {
    this.resolveSchedule()
    return this.scheduleApi
  }

  /** 会话级适配器：行为与宿主级扩展加入前逐字节一致，只多一个判别位。 */
  private createLegacyScheduleApi(controller: LegacyScheduleControllerLike): LegacyScheduleApiLike {
    return {
      mode: 'legacy',
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
   * 宿主级适配器：把 DSH `ScheduleService` 的分页列表/结果对象归一化成 Bridge
   * 消费的稳定视图。
   *
   * 失败分两类：`view/edit/run/history` 的「找不到」是**结果对象**里的 code
   * （非变更 miss，不抛错），这里翻译成 outcome 或带 code 的 Error；
   * `create/edit/run` 的输入非法与目标已归档是 RemoteError 抛出，由
   * `this.call` 收成 `{code}`，再由 Bridge 按错误词表映射。
   */
  private createHostScheduleApi(controller: HostScheduleControllerLike): NonNullable<ApiProxyLike['schedule']> {
    return {
      mode: 'host',
      list: async (request) => this.call(async () => {
        const payload = request.payload ?? {}
        const value = await controller.list({
          ...(payload.active !== undefined ? { active: payload.active } : {}),
          ...(payload.limit !== undefined ? { limit: payload.limit } : {}),
          ...(payload.offset !== undefined ? { offset: payload.offset } : {}),
        }) as Record<string, unknown>
        const items = Array.isArray(value.items) ? value.items : []
        return {
          tasks: items.map(toHostScheduleTask),
          shown: finiteCount(value.shown, items.length),
          total: finiteCount(value.total, items.length),
          limit: finiteCount(value.limit, payload.limit ?? 100),
          offset: finiteCount(value.offset, payload.offset ?? 0),
        } satisfies HostScheduleListResultLike
      }),
      view: async (request) => this.call(async () => {
        const value = await controller.view({ id: request.payload!.id }) as Record<string, unknown>
        return toHostScheduleViewOutcome(value, request.payload!.id)
      }),
      create: async (request) => this.call(async () => {
        const payload = request.payload!
        const created = await controller.create({
          title: payload.title,
          prompt: payload.prompt,
          timing: payload.timing,
          ...(payload.target !== undefined ? { target: normalizeTargetRequest(payload.target) } : {}),
        } satisfies HostScheduleCreateRequestLike)
        return toHostScheduleTask(created)
      }),
      edit: async (request) => this.call(async () => {
        const payload = request.payload!
        const expected = payload.expectedUpdatedAt !== undefined
          ? { expectedUpdatedAt: payload.expectedUpdatedAt }
          : {}
        const edit: HostScheduleEditRequestLike = payload.action === 'update'
          ? { id: payload.id, action: 'update', patch: normalizeHostPatch(payload.patch), ...expected }
          : { id: payload.id, action: 'delete', ...expected }
        const value = await controller.edit(edit) as Record<string, unknown>
        return toHostScheduleEditOutcome(value, payload.id)
      }),
      run: async (request) => this.call(async () => {
        const value = await controller.run({ id: request.payload!.id }) as Record<string, unknown>
        return toHostScheduleRunOutcome(value, request.payload!.id)
      }),
      history: async (request) => this.call(async () => {
        const value = await controller.history({
          id: request.payload!.id,
          limit: request.payload!.limit,
          ...(request.payload!.before !== undefined ? { before: request.payload!.before } : {}),
        }) as Record<string, unknown>
        if (typeof value.code === 'string') {
          throw Object.assign(new Error(String(value.code)), { code: value.code })
        }
        return toScheduleHistory(value)
      }),
      limits: async () => this.call(async () => {
        const value = controller.deliveryLimits() as { newSessionIntervalSeconds?: unknown } | undefined
        return {
          newSessionIntervalSeconds: Math.max(0, Math.trunc(Number(value?.newSessionIntervalSeconds) || 0)),
        } satisfies HostScheduleLimitsView
      }),
      deleteEnded: async () => this.call(async () => {
        const value = await controller.deleteInactive() as { deleted?: unknown } | undefined
        return {
          deleted: Math.max(0, Math.trunc(Number(value?.deleted) || 0)),
        } satisfies HostScheduleDeleteEndedResult
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
      const beforeSeq = request.payload?.beforeSeq
      const limit = normalizePageLimit(request.payload?.maxMessages)
      const inspect = this.session.inspect
      // DSH 0.2.2-alpha.2 dropped `inspect`; the host's own `page` covers the same
      // read with message-aligned windowing. Keep the old path for every host that
      // still has it, because those hosts' `page` demands a log cursor.
      if (inspect === undefined) {
        const page = await this.session.page!({
          address: { kind: 'session', sessionId },
          // `beforeSeq` is exclusive and expressed in seqs; `throughSeq` is an
          // inclusive seq cut, so shift by one. -1 is the host's empty page.
          ...(beforeSeq === undefined ? {} : { throughSeq: beforeSeq - 1 }),
          maxMessages: limit,
        }, new AbortController().signal)
        // Records are `{type:'event', event}` envelopes; the bridge contract is
        // `{event}`. host-bridge re-checks the seq boundary itself, so the
        // inclusive cut cannot make a client loop on the same page.
        return {
          events: page.records.map((record) => ({
            event: (record as { event: SessionEventLike }).event,
          })),
          hasMore: page.hasMore,
        }
      }
      let inspected: { events: readonly unknown[] }
      try {
        inspected = await inspect.call(this.session, sessionId)
      } catch (error) {
        // No message data is logged: only the opaque session id and Host's
        // safe error chain, enough to distinguish an unsupported legacy log
        // from a bridge regression.
        console.warn(`[deeppilot] session history unavailable for ${JSON.stringify(sessionId)}: ${toError(error).code}: ${toError(error).message}`)
        throw error
      }
      // 分页窗口的策略住在 host-event-projection（与它依赖的投影规则同处）；
      // 适配器只负责拉全量事件、把窗口映射成 HistoryResult。
      const window = historyWindow(inspected.events, {
        beforeSeq,
        limit,
      })
      return { events: window.events as HistoryResult['events'], hasMore: window.hasMore }
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
    updateQueue: async (request) => this.call(() => this.session.updateQueue!(request.payload!)),
    attachment: async (request) => this.call(() => this.session.attachment(request.payload!)),
    projections: async (request) => this.call(() => this.session.projections(request.payload!, new AbortController().signal)),
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
    // This is an agent-scoped publication with ONE payload argument. Reading
    // `(session, frame)` here silently loses every real Host stream frame.
    const offAssistantStream = this.ctx.on('agent/assistant-stream' as never, (({ agent, frame }: {
      agent: { session: { id: string; header?: { origin?: string } } }; frame: unknown
    }) => {
      queue.push({ type: 'session/assistant-stream', sessionId: String(agent.session.id),
        isSubagent: agent.session.header?.origin === 'subagent', value: frame })
    }) as never, { global: true })
    const offAgentDisposed = this.ctx.on('agent/disposed' as never, (({ agent }: {
      agent: { session: { id: string } }
    }) => queue.push({ type: 'session/assistant-stream-disposed', sessionId: String(agent.session.id) })) as never, { global: true })
    const projections = this.ctx.get('sessionProjections') as {
      onChanged?(listener: (session: { id: string }, key: string, value: unknown) => void): () => void
    } | undefined
    const offProjection = projections?.onChanged?.((session, key, value) => {
      queue.push({ type: 'session/projection', sessionId: String(session.id), key, value })
    })
    const offSkills = this.ctx.on('skills/change' as never, (() => {
      queue.push({ type: 'skills/changed' })
    }) as never, { global: true })
    const offCommands = ['commands/change', 'permission-presets/catalog-changed'].map(event =>
      this.ctx.on(event as never, (() => queue.push({ type: 'commands/changed' })) as never, { global: true }))

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
      offAssistantStream()
      offAgentDisposed()
      offProjection?.()
      offSkills()
      offCommands.forEach(dispose => dispose())
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
/* ---------- 宿主级 Schedule 的形状归一化 ---------- */

/**
 * 请求侧 target：`new_once`/`new` 的会话由 Host 预留或新建，客户端若把查看结果
 * 里的 `sessionId` 原样回传，不向上游透传（Host 的创建/编辑请求没有这个字段）。
 */
function normalizeTargetRequest(value: HostScheduleTargetRequest): HostScheduleTargetRequest {
  if (value.kind === 'session') {
    return { kind: 'session', sessionId: String(value.sessionId ?? '') }
  }
  const create = toHostScheduleCreateSpec(value.create)
  return { kind: value.kind, ...(create !== undefined ? { create } : {}) }
}

/** 编辑补丁归一化：字段按契约逐个透传，target 走请求侧投影。 */
function normalizeHostPatch(value: HostSchedulePatch): HostSchedulePatch {
  return {
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(value.prompt !== undefined ? { prompt: value.prompt } : {}),
    ...(value.timing !== undefined ? { timing: value.timing } : {}),
    ...(value.target !== undefined ? { target: normalizeTargetRequest(value.target) } : {}),
    ...(value.active !== undefined ? { active: value.active } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** 非负安全整数；形状不符时退回 fallback（分页字段只用于展示）。 */
function finiteCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function positiveSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function hostResultCode(value: Record<string, unknown>): string | undefined {
  return typeof value.code === 'string' ? value.code : undefined
}

/** 结果对象里的「非变更 miss」不是抛错，这里翻译成 outcome 或带 code 的 Error。 */
function throwHostResultCode(code: string): never {
  throw Object.assign(new Error(code), { code })
}

function toHostScheduleCreateSpec(value: unknown): HostScheduleCreateSpec | undefined {
  const row = toRecord(value)
  const spec: HostScheduleCreateSpec = {
    ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
    ...(typeof row.agentPreset === 'string' ? { agentPreset: row.agentPreset } : {}),
  }
  return Object.keys(spec).length > 0 ? spec : undefined
}

/**
 * 交付目标投影。`session` 与 `new_once` 带 sessionId（后者是创建时 Host 预留
 * 的会话）；`new` 每次投递新建会话。`create` 省略时按 Host 默认。
 */
function toHostScheduleTarget(value: unknown): HostScheduleTarget {
  const target = toRecord(value)
  const create = toHostScheduleCreateSpec(target.create)
  if (target.kind === 'session') {
    return { kind: 'session', sessionId: String(target.sessionId ?? '') }
  }
  if (target.kind === 'new_once') {
    return {
      kind: 'new_once',
      sessionId: String(target.sessionId ?? ''),
      ...(create !== undefined ? { create } : {}),
    }
  }
  return { kind: 'new', ...(create !== undefined ? { create } : {}) }
}

function toHostScheduleReceipt(value: unknown): HostScheduleDeliveryReceipt {
  const row = toRecord(value)
  return {
    scheduledAt: String(row.scheduledAt ?? ''),
    deliveredAt: String(row.deliveredAt ?? ''),
    messageId: String(row.messageId ?? ''),
    targetSessionId: String(row.targetSessionId ?? ''),
  }
}

/**
 * timing 反向投影：DSH 存储记录用 camelCase（`afterSeconds`/`timeZone`），wire
 * 用 PROTOCOL.md 的 snake_case 嵌套结构。
 *
 * `at` 存储后只剩 `scheduledAt`（原始绝对时刻不是独立字段），因此用排定时刻
 * 回填——对 active 的一次性任务它就是目标时刻。
 */
function toHostScheduleTiming(row: Record<string, unknown>): HostScheduleTiming {
  switch (row.kind) {
    case 'after':
      return { kind: 'after', after_seconds: positiveSeconds(row.afterSeconds) }
    case 'every':
      return { kind: 'every', every_seconds: positiveSeconds(row.everySeconds) }
    case 'daily':
      return { kind: 'daily', daily: localTimeInput(row) }
    case 'weekly':
      return {
        kind: 'weekly',
        weekly: {
          ...localTimeInput(row),
          weekdays: Array.isArray(row.weekdays)
            ? row.weekdays.filter((day): day is number => typeof day === 'number')
            : [],
        },
      }
    case 'cron':
      return {
        kind: 'cron',
        cron: { expression: String(row.expression ?? ''), time_zone: String(row.timeZone ?? '') },
      }
    case 'rrule':
      return { kind: 'rrule', rrule: String(row.rrule ?? '') }
    default:
      return { kind: 'at', at: String(row.scheduledAt ?? '') }
  }
}

function localTimeInput(row: Record<string, unknown>): { time: string; time_zone: string } {
  return { time: String(row.time ?? ''), time_zone: String(row.timeZone ?? '') }
}

/** Host `ScheduleCatalogEntry` -> wire `schedule.host.task`（丢弃 involvedSessionIds）。 */
function toHostScheduleTask(value: unknown): HostScheduleTaskView {
  const row = toRecord(value)
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    prompt: String(row.prompt ?? ''),
    timing: toHostScheduleTiming(row),
    target: toHostScheduleTarget(row.target),
    // Host 只给这三个状态；形态异常时按 active 保留（至少让任务在列表里可见，
    // 不能让一条真实任务因为字段异常而消失）。
    status: row.status === 'paused' || row.status === 'ended' ? row.status : 'active',
    scheduledAt: String(row.scheduledAt ?? ''),
    ...(typeof row.createdAt === 'string' ? { createdAt: row.createdAt } : {}),
    ...(typeof row.updatedAt === 'string' ? { updatedAt: row.updatedAt } : {}),
    ...(typeof row.executionActive === 'boolean' ? { executionActive: row.executionActive } : {}),
    ...(typeof row.deliveryFloorEndsAt === 'string' ? { deliveryFloorEndsAt: row.deliveryFloorEndsAt } : {}),
    ...(isRecord(row.lastDelivery) ? { lastDelivery: toHostScheduleReceipt(row.lastDelivery) } : {}),
  }
}

function toHostScheduleViewOutcome(value: Record<string, unknown>, id: string): HostScheduleViewOutcome {
  const code = hostResultCode(value)
  if (code === 'schedule_not_found') return { kind: 'not-found', id }
  if (code !== undefined) throwHostResultCode(code)
  return { kind: 'task', task: toHostScheduleTask(value) }
}

function toHostScheduleEditOutcome(value: Record<string, unknown>, id: string): HostScheduleEditOutcome {
  const code = hostResultCode(value)
  if (code === 'schedule_conflict') return { kind: 'conflict', id }
  if (code === 'schedule_not_found') return { kind: 'not-found', id }
  if (code !== undefined) throwHostResultCode(code)
  if (value.deleted === true) return { kind: 'deleted', id: String(value.id ?? id) }
  return { kind: 'task', task: toHostScheduleTask(value) }
}

function toHostScheduleRunOutcome(value: Record<string, unknown>, id: string): HostScheduleRunOutcome {
  const code = hostResultCode(value)
  if (code === 'schedule_execution_pending') return { kind: 'pending', id }
  if (code === 'schedule_not_found') return { kind: 'not-found', id }
  if (code !== undefined) throwHostResultCode(code)
  return { kind: 'task', task: toHostScheduleTask(value) }
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
