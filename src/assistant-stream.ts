import { randomUUID } from 'node:crypto'
import type { SessionEventLike } from './host-api.ts'
import type { SessionDeltaPayload, SessionStreamOutcome } from './protocol.ts'

/** Structural mirror of rc.3 / alpha.2 agent/assistant-stream; older hosts need no import. */
export type AssistantStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: { type: string; text?: string } }
  | { type: 'end'; attemptId: string; revision: number; index: number; outcome: AssistantStreamOutcome }

export type AssistantStreamOutcome = SessionStreamOutcome
export type AssistantStreamDelta = SessionDeltaPayload

export const ASSISTANT_STREAM_FLUSH_MS = 50
export const MAX_ASSISTANT_DELTA_BYTES = 256 * 1024

type TextKind = 'message.delta' | 'thinking.delta'
interface PendingText { kind: TextKind; text: string; ts: number; truncated?: true }
interface Attempt {
  attemptId: string
  streamId: string
  revision: number
  nextIndex: number
  turn: number
  step: number
  finalSeq?: number
  pending: PendingText[]
  pendingBytes: number
  timer?: ReturnType<typeof setTimeout>
}

/** Bound by serialized UTF-8 size, including escaping, without splitting a Unicode code point. */
function bounded(payload: AssistantStreamDelta): AssistantStreamDelta {
  if (Buffer.byteLength(JSON.stringify(payload)) <= MAX_ASSISTANT_DELTA_BYTES) return payload
  const points = Array.from(payload.text)
  let low = 0
  let high = points.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const candidate = { ...payload, text: points.slice(0, mid).join(''), truncated: true }
    if (Buffer.byteLength(JSON.stringify(candidate)) <= MAX_ASSISTANT_DELTA_BYTES) low = mid
    else high = mid - 1
  }
  return { ...payload, text: points.slice(0, low).join(''), truncated: true }
}

function isFrame(value: unknown): value is AssistantStreamFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as AssistantStreamFrame
  if (typeof frame.attemptId !== 'string' || !frame.attemptId || !Number.isSafeInteger(frame.revision)) return false
  if (frame.type === 'start') return Number.isSafeInteger(frame.turn) && Number.isSafeInteger(frame.step)
  if (frame.type !== 'chunk' && frame.type !== 'end') return false
  if (!Number.isSafeInteger(frame.index) || frame.index < 0) return false
  if (frame.type === 'chunk') return Number.isSafeInteger(frame.time) && !!frame.chunk && typeof frame.chunk.type === 'string'
  return frame.outcome?.kind === 'abandoned' || (frame.outcome?.kind === 'committed' &&
    ['assistant/message', 'assistant/attempt'].includes(frame.outcome.eventType) && Number.isSafeInteger(frame.outcome.seq))
}

/**
 * One process-local attempt per session. Only the small pending window retains text;
 * the durable session event remains the source of truth for the completed reply.
 */
export class AssistantStream {
  private readonly attempts = new Map<string, Attempt>()

  constructor(
    private readonly emit: (payload: AssistantStreamDelta) => void,
    private readonly isViewed: (sessionId: string) => boolean,
  ) {}

  accept(sessionId: string, value: unknown): void {
    if (!sessionId || !isFrame(value)) return
    const frame = value
    let state = this.attempts.get(sessionId)
    if (frame.type === 'start') {
      // The Host's attempt counter resets when its Agent is replaced. A fresh
      // bridge id avoids colliding with a still-rendered attempt after replacement.
      if (state?.attemptId === frame.attemptId && frame.revision <= state.revision) return
      this.abandon(sessionId)
      state = { attemptId: frame.attemptId, streamId: randomUUID(), revision: frame.revision,
        nextIndex: 0, turn: frame.turn, step: frame.step, pending: [], pendingBytes: 0 }
      this.attempts.set(sessionId, state)
      this.emit({ sessionId, streamId: state.streamId, kind: 'stream.start', text: '', ts: Date.now() })
      return
    }
    if (!state || state.attemptId !== frame.attemptId || frame.revision <= state.revision || frame.index < state.nextIndex) return
    state.revision = frame.revision
    if (frame.type === 'end') {
      if (frame.outcome.kind === 'committed') this.flush(sessionId)
      this.clearPending(sessionId)
      this.attempts.delete(sessionId)
      this.emit({ sessionId, streamId: state.streamId, kind: 'stream.end', text: '', ts: Date.now(), outcome: frame.outcome })
      return
    }
    state.nextIndex = frame.index + 1
    if (state.finalSeq !== undefined || !this.isViewed(sessionId)) return
    const kind = frame.chunk.type === 'text-delta' ? 'message.delta'
      : frame.chunk.type === 'reasoning-delta' ? 'thinking.delta' : undefined
    if (!kind || typeof frame.chunk.text !== 'string' || frame.chunk.text.length === 0) return
    // 只合并相邻同类片段，不能把正文→推理→正文重排为正文→推理。
    // 达到两帧预算时提前发出窗口，防止同步突发流用大量短分段撑大内存。
    const previous = state.pending.at(-1)?.kind === kind ? state.pending.at(-1) : undefined
    if (previous?.truncated) return
    const payload = bounded({ sessionId, streamId: state.streamId, kind,
      text: (previous?.text ?? '') + frame.chunk.text, ts: frame.time })
    const next: PendingText = { kind, text: payload.text, ts: payload.ts, ...(payload.truncated ? { truncated: true } : {}) }
    const oldBytes = previous ? Buffer.byteLength(JSON.stringify(previous)) : 0
    const newBytes = Buffer.byteLength(JSON.stringify(next))
    if (state.pendingBytes - oldBytes + newBytes > 2 * MAX_ASSISTANT_DELTA_BYTES) this.flush(sessionId)
    if (previous && state.pending.at(-1) === previous) {
      state.pending[state.pending.length - 1] = next
      state.pendingBytes -= oldBytes
    } else if (previous) {
      // 提前 flush 已发出旧片段，本次只排入新增部分，不能重复发送累计前缀。
      const tail = bounded({ sessionId, streamId: state.streamId, kind, text: frame.chunk.text, ts: frame.time })
      next.text = tail.text
      next.truncated = tail.truncated ? true : undefined
      state.pending.push(next)
    } else state.pending.push(next)
    state.pendingBytes += Buffer.byteLength(JSON.stringify(next))
    state.timer ??= setTimeout(() => this.flush(sessionId), ASSISTANT_STREAM_FLUSH_MS)
    state.timer.unref?.()
  }

  /** The Host appends the durable event BEFORE publishing committed end. */
  beforeEvent(sessionId: string, event: SessionEventLike): string | undefined {
    const state = this.attempts.get(sessionId)
    if (!state || (event.type !== 'assistant/message' && event.type !== 'assistant/attempt')) return undefined
    const data = event.data as { turn?: number; step?: number } | undefined
    if (data?.turn !== state.turn || data?.step !== state.step) return undefined
    this.flush(sessionId)
    state.finalSeq = event.seq
    return state.streamId
  }

  flush(sessionId: string): void {
    const state = this.attempts.get(sessionId)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    const pending = state.pending
    state.pending = []
    state.pendingBytes = 0
    for (const text of pending) this.emit({ sessionId, streamId: state.streamId, ...text })
  }

  /** Closing the last viewer must not deliver its buffered text on a later open. */
  clearPending(sessionId: string): void {
    const state = this.attempts.get(sessionId)
    if (!state) return
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    state.pending = []
    state.pendingBytes = 0
  }

  abandon(sessionId: string): void {
    const state = this.attempts.get(sessionId)
    if (!state) return
    this.clearPending(sessionId)
    this.attempts.delete(sessionId)
    this.emit({ sessionId, streamId: state.streamId, kind: 'stream.end', text: '', ts: Date.now(), outcome: { kind: 'abandoned' } })
  }

  dispose(): void {
    for (const sessionId of this.attempts.keys()) this.clearPending(sessionId)
    this.attempts.clear()
  }
}
