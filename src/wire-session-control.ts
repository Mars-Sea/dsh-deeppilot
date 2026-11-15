import { validSendId } from './connection-policy.ts'
import { ControlRejection } from './session-controls.ts'
import type { SessionControlRequest } from './protocol.ts'
import { isText, payloadObject, reject, type WireFrameRow } from './wire-registry.ts'

const refValid = (v: unknown): boolean => {
  const r = v as { id?: unknown; revision?: unknown } | null
  return r !== null && typeof r === 'object' && isText(r.id, 512) && Number.isSafeInteger(r.revision) && (r.revision as number) > 0
}
export const sessionControlRows: readonly WireFrameRow[] = [
  {
    type: 'c2s.session.controls', stage: 'authenticated', scopes: ['sessions.read'], widgetPolicy: 'deny',
    doc: 'PROTOCOL.md c2s.session.controls',
    validate: value => {
      const p = payloadObject(value)
      return !p.ok || isText(p.value.sessionId) ? p : reject('E_PROTOCOL', '会话标识无效')
    },
    handle: async (ctx, p) => {
      try { ctx.send('s2c.session.controls', await ctx.bridge.sessionControls.state(p.sessionId as string, ctx.signal ?? new AbortController().signal)) }
      catch (error) { ctx.fail(error instanceof ControlRejection ? error.code : 'E_INTERNAL', '暂时无法读取会话操作状态') }
    },
  },
  ...(['continue', 'goal.manage'] as const).map((kind): WireFrameRow => ({
    type: `c2s.session.${kind}`, stage: 'authenticated', scopes: ['sessions.read', 'prompt.send'], widgetPolicy: 'deny',
    capability: kind === 'continue' ? 'generationContinuation' : 'goalManagement',
    doc: `PROTOCOL.md c2s.session.${kind}`,
    validate: value => {
      const p = payloadObject(value)
      if (!p.ok) return p
      const r = p.value
      if (!isText(r.sessionId) || !validSendId(r.clientRequestId)) return reject('E_PROTOCOL', '操作标识无效')
      if (kind === 'continue') return Number.isSafeInteger(r.endingSeq) && (r.endingSeq as number) >= 0
        ? { ok: true, value: { sessionId: r.sessionId, clientRequestId: r.clientRequestId, action: 'continue', endingSeq: r.endingSeq } }
        : reject('E_PROTOCOL', '继续生成状态无效')
      if (!['create', 'edit', 'pause', 'resume', 'clear'].includes(String(r.action)) ||
          !(r.expectedGoal === null ? r.action === 'create' : refValid(r.expectedGoal))) return reject('E_PROTOCOL', '目标操作无效')
      if (r.action === 'create' || r.action === 'edit') {
        const patch = r.patch as Record<string, unknown> | undefined
        if (!patch || Array.isArray(patch) || typeof patch !== 'object' ||
            (patch.objective === undefined && patch.maxGoalRounds === undefined) ||
            (r.action === 'create' && patch.objective === undefined) ||
            (patch.objective !== undefined && (!isText(patch.objective, 64 * 1024) || !(patch.objective as string).trim())) ||
            (patch.maxGoalRounds !== undefined && (!Number.isSafeInteger(patch.maxGoalRounds) || (patch.maxGoalRounds as number) < 1))) {
          return reject('E_PROTOCOL', '目标正文或轮数上限无效')
        }
        return { ok: true, value: { sessionId: r.sessionId, clientRequestId: r.clientRequestId, action: r.action,
          expectedGoal: r.expectedGoal, patch: { ...(patch.objective === undefined ? {} : { objective: patch.objective }),
            ...(patch.maxGoalRounds === undefined ? {} : { maxGoalRounds: patch.maxGoalRounds }) } } }
      }
      return { ok: true, value: { sessionId: r.sessionId, clientRequestId: r.clientRequestId, action: r.action, expectedGoal: r.expectedGoal } }
    },
    handle: async (ctx, p) => ctx.send('s2c.session.control.receipt', await ctx.bridge.sessionControls.execute(ctx.deviceId!,
      p as unknown as SessionControlRequest, ctx.signal ?? new AbortController().signal)),
  })),
  {
    type: 'c2s.session.control.status', stage: 'authenticated', scopes: ['sessions.read', 'prompt.send'], widgetPolicy: 'deny',
    doc: 'PROTOCOL.md c2s.session.control.status',
    validate: value => {
      const p = payloadObject(value)
      return !p.ok || (isText(p.value.sessionId) && validSendId(p.value.clientRequestId)) ? p : reject('E_PROTOCOL', '操作标识无效')
    },
    handle: async (ctx, p) => ctx.send('s2c.session.control.receipt', ctx.bridge.sessionControls.status(ctx.deviceId!, p.sessionId as string, p.clientRequestId as string)),
  },
]
