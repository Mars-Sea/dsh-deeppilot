/** Atomic, optional Host controls. Reads never activate an Agent; explicit writes may resume it. */
import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { openDispatchJournal, type DispatchCodec, type JournalEntry } from './dispatch-journal.ts'
import { ERROR_CODES, type WireErrorCode } from './wire-errors.ts'
import type { SessionGoal, SessionControlRequest, SessionControlReceipt, SessionControlState } from './protocol.ts'

type Row = Record<string, any>
const row = (v: unknown): Row | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : undefined
const seq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0

export class ControlRejection extends Error {
  constructor(readonly code: WireErrorCode, message: string) { super(message) }
}

export interface SessionControlsApi {
  readonly continuationAvailable: boolean
  readonly goalManagementAvailable: boolean
  state(sessionId: string, signal: AbortSignal): Promise<SessionControlState>
  execute(request: SessionControlRequest, signal: AbortSignal): Promise<{ ref?: { id: string; revision: number } }>
}

interface AgentLike {
  id: string
  session: unknown
  status: string
  inbox: { nextTurn: readonly Row[]; nextStep: readonly Row[] }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  followup(message: unknown): void
}

/** Structural optional adapter: no extra injection or version-string activation gate. */
export class DshSessionControls implements SessionControlsApi {
  constructor(private readonly ctx: Context) {}
  private get controller(): Row | undefined { return this.ctx.get('sessionController') as Row | undefined }
  private get projections(): Row | undefined { return this.ctx.get('sessionProjections') as Row | undefined }
  private get goals(): Row | undefined { return this.ctx.get('goals') as Row | undefined }

  get continuationAvailable(): boolean {
    if (typeof this.controller?.resolveAgent !== 'function' || typeof this.controller?.projections !== 'function' ||
        typeof this.projections?.snapshot !== 'function') return false
    // Public reflection is JSON data. A controller without the authoritative projection must not
    // offer a button. Missing reflection on custom Hosts is a conservative feature downgrade.
    try {
      const typert = this.ctx.get('typert') as Row | undefined
      const model = typert?.getPackage?.('@deepseek-ai/dsh-api-session-controller', 'host')?.model
      return model !== undefined && JSON.stringify(model).includes('"conversationContinuation"')
    } catch { return false }
  }

  get goalManagementAvailable(): boolean {
    return typeof this.controller?.resolveAgent === 'function' &&
      ['get', 'create', 'edit', 'pause', 'resume', 'clear'].every(key => typeof this.goals?.[key] === 'function')
  }

  async state(sessionId: string, signal: AbortSignal): Promise<SessionControlState> {
    signal.throwIfAborted()
    if (typeof this.controller?.projections !== 'function') return { sessionId }
    const baseline = await this.controller?.projections?.({ sessionId }, signal)
    signal.throwIfAborted()
    if (!baseline) throw new ControlRejection('E_NOT_FOUND', '会话已不存在')
    const ending = baseline.kind === 'sequenced' ? baseline.values?.conversationContinuation : undefined
    return { sessionId, ...(seq(ending) || ending === null ? { continuationEnding: ending } : {}) }
  }

  async execute(request: SessionControlRequest, signal: AbortSignal): Promise<{ ref?: { id: string; revision: number } }> {
    signal.throwIfAborted()
    const supported = request.action === 'continue' ? this.continuationAvailable : this.goalManagementAvailable
    if (!supported) throw new ControlRejection('E_UNSUPPORTED', '当前主机不支持此操作')
    const resolved = await this.controller!.resolveAgent(request.sessionId)
    signal.throwIfAborted()
    if (resolved.error) throw new ControlRejection('E_NOT_FOUND', '会话暂时无法操作')
    const agent = resolved.agent as AgentLike
    if (!agent || agent.id !== request.sessionId) throw new ControlRejection('E_NOT_FOUND', '会话暂时无法操作')
    if (request.action === 'continue') {
      if (typeof agent.runMaintenance !== 'function' || typeof agent.followup !== 'function') {
        throw new ControlRejection('E_UNSUPPORTED', '当前主机不支持继续生成')
      }
      // runMaintenance claims true idle synchronously. No await between the authoritative
      // snapshot, exact ending check and inbox insertion; a competing Web prompt cannot slip in.
      if (agent.status !== 'idle') throw new ControlRejection('E_BUSY', '会话正在处理其他输入')
      return agent.runMaintenance(async maintenanceSignal => {
        maintenanceSignal.throwIfAborted()
        signal.throwIfAborted()
        const ending = this.projections!.snapshot(agent.session, ['conversationContinuation']).values.conversationContinuation
        if (!seq(ending) || ending !== request.endingSeq || agent.inbox.nextTurn.length > 0 ||
            agent.inbox.nextStep.some(message => message.source?.kind === 'user')) {
          throw new ControlRejection('E_BUSY', '会话状态已变化，请刷新后重试')
        }
        // This is the native identified retry message vocabulary, not a synthetic text prompt.
        agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: Object.freeze([]),
          source: Object.freeze({ kind: 'retry', rpcId: `dp:${request.clientRequestId}` }) }))
        return {}
      })
    }
    // Goal methods are synchronous. Compare and mutate in one JS turn, including create,
    // whose native method has no expected-ref parameter of its own.
    const goals = this.goals!
    const current = goals.get(agent) as SessionGoal | undefined
    const expected = request.expectedGoal
    if (expected === null ? current !== undefined : !current || current.id !== expected?.id || current.revision !== expected.revision) {
      throw new ControlRejection('E_BUSY', '目标已在其他地方更新，请查看最新状态')
    }
    let result: Row
    try {
      switch (request.action) {
        case 'create': result = goals.create(agent, request.patch); break
        case 'edit': result = goals.edit(agent, expected, request.patch); break
        case 'pause': result = goals.pause(agent, expected); break
        case 'resume': result = goals.resume(agent, expected); break
        case 'clear': result = goals.clear(agent, expected); break
      }
    } catch (error) {
      const code = (error as Row)?.code
      if (typeof code === 'string' && code.startsWith('GOAL_')) {
        throw new ControlRejection('E_BUSY', '目标状态不允许此操作，请查看最新状态和轮数上限')
      }
      throw error // a failure after a write may have happened is UNKNOWN, never auto-redelivered
    }
    return { ref: { id: result.id, revision: result.revision } }
  }
}

interface Entry extends JournalEntry {
  sessionId: string
  action: string
  receipt: SessionControlReceipt
}

/** No objectives, prompt bodies, or goal snapshots are persisted in the control journal. */
export const sessionControlCodec: DispatchCodec<SessionControlRequest, SessionControlReceipt> = {
  identity: 'session-controls-v1', requiresValidId: true,
  fingerprint: request => createHash('sha256').update(JSON.stringify(request)).digest('hex'),
  reserve: (request, id) => ({ sessionId: request.sessionId, action: request.action,
    receipt: { sessionId: request.sessionId, clientRequestId: id, status: 'unknown' } }),
  accepted: (entry, id, value) => { entry.receipt = { sessionId: entry.sessionId, clientRequestId: id, status: 'accepted', ...value as object } },
  rejected: (entry, id, code) => { entry.receipt = { sessionId: entry.sessionId, clientRequestId: id, status: 'rejected', code } },
  resultOf: (outcome, id) => {
    if (outcome.kind === 'ran' || outcome.kind === 'replay') return (outcome.entry as Entry).receipt
    const status = outcome.kind === 'expired' ? 'expired' : outcome.kind === 'invalid-id' || outcome.kind === 'mismatch' || outcome.kind === 'full' ? 'rejected' : 'unknown'
    return { sessionId: '', clientRequestId: id, status,
      ...(status === 'rejected' ? { code: outcome.kind === 'full' ? 'E_BUSY' : 'E_PROTOCOL' } : {}) }
  },
  matches: (entry, request) => entry.sessionId === request,
  miss: (id, expired) => ({ sessionId: '', clientRequestId: id, status: expired ? 'expired' : 'notFound' }),
  parse: raw => {
    if (!Array.isArray(raw)) throw new Error('invalid control journal')
    const entries: Record<string, Entry> = Object.create(null)
    for (const item of raw) {
      const entry = row(item), receipt = row(entry?.receipt)
      if (!entry || !receipt || !/^[a-f0-9]{64}$/.test(entry.key) || !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
          !Number.isFinite(entry.createdAt) || typeof entry.sessionId !== 'string' || typeof entry.action !== 'string' ||
          receipt.sessionId !== entry.sessionId || typeof receipt.clientRequestId !== 'string' ||
          entry.createdAt !== Number(receipt.clientRequestId.slice(0, 13)) || !['accepted', 'rejected', 'unknown'].includes(receipt.status) ||
          (receipt.status === 'rejected' && !(receipt.code in ERROR_CODES)) ||
          (receipt.ref !== undefined && (typeof receipt.ref.id !== 'string' || !seq(receipt.ref.revision) || receipt.ref.revision === 0))) {
        throw new Error('invalid control journal')
      }
      entries[entry.key] = { fingerprint: entry.fingerprint, createdAt: entry.createdAt, sessionId: entry.sessionId,
        action: entry.action, receipt: { sessionId: entry.sessionId, clientRequestId: receipt.clientRequestId, status: receipt.status,
          ...(receipt.code ? { code: receipt.code } : {}), ...(receipt.ref ? { ref: receipt.ref } : {}) } }
    }
    return entries
  },
  serialize: entries => Object.entries(entries).map(([key, entry]) => ({ key, ...entry })),
}

export class SessionControlCoordinator {
  private readonly journal
  constructor(private readonly api: () => SessionControlsApi | undefined, path?: string, log?: (message: string) => void) {
    this.journal = openDispatchJournal({ codec: sessionControlCodec, path, log, capacity: 2000, maxFileBytes: 2 * 1024 * 1024 })
  }
  async state(sessionId: string, signal: AbortSignal): Promise<SessionControlState> {
    const api = this.api()
    if (!api) throw new ControlRejection('E_UNSUPPORTED', '当前主机不支持此操作')
    return api.state(sessionId, signal)
  }
  status(deviceId: string, sessionId: string, id: string): SessionControlReceipt {
    const result = this.journal.lookup(deviceId, id, sessionId)!
    return { ...result, sessionId }
  }
  async execute(deviceId: string, request: SessionControlRequest, signal: AbortSignal): Promise<SessionControlReceipt> {
    const receipt = await this.journal.dispatch(deviceId, request.clientRequestId, request, async () => {
      try {
        const api = this.api()
        if (!api) throw new ControlRejection('E_UNSUPPORTED', '当前主机不支持此操作')
        return { ok: true, value: await api.execute(request, signal) }
      } catch (error) {
        if (error instanceof ControlRejection) return { ok: false, code: error.code }
        throw error
      }
    })
    return { ...receipt, sessionId: request.sessionId }
  }
}
