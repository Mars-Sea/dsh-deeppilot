import type { SessionGoal } from './protocol.ts'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min

/** Host owns lifecycle/counters. Unknown shapes never masquerade as a cleared goal. */
export function projectGoal(value: unknown): SessionGoal | null | undefined {
  if (value === null) return null
  const projection = object(value)
  const goal = object(projection?.goal)
  if (!projection || !goal || typeof goal.id !== 'string' || !goal.id ||
      !integer(goal.revision, 1) || typeof goal.objective !== 'string' || !goal.objective.trim() ||
      !['active', 'paused', 'blocked', 'complete'].includes(goal.phase as string) ||
      !integer(goal.maxGoalRounds, 1) || !integer(projection.roundsStarted) ||
      !integer(projection.createdAt) || !integer(projection.updatedAt)) return undefined
  const reason = object(goal.blockedReason)
  if (goal.phase === 'blocked' && (!reason || typeof reason.code !== 'string' || !reason.code ||
      typeof reason.message !== 'string' || !reason.message)) return undefined
  const activation = projection.activation
  return {
    id: goal.id, revision: goal.revision, objective: goal.objective,
    phase: goal.phase as SessionGoal['phase'], maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: projection.roundsStarted, createdAt: projection.createdAt, updatedAt: projection.updatedAt,
    ...(activation === 'armed' || activation === 'disarmed' ? { activation } : {}),
    ...(goal.phase === 'blocked' ? { blockedReason: { code: reason!.code as string, message: reason!.message as string } } : {}),
  }
}

export interface GoalActivationEdge { id: string; revision: number; activation: 'armed' | 'disarmed' }

/**
 * One authoritative mirror orders baselines, live durable changes and process-only activation,
 * and remembers which running turn belongs to a goal so its completion is announced once.
 */
export class GoalProjectionTracker {
  private readonly rows = new Map<string, { goal: SessionGoal | null; seq?: number }>()
  private readonly completed = new Map<string, Set<string>>()
  private readonly activation = new Map<string, GoalActivationEdge>()
  private readonly goalTurns = new Set<string>()

  get(sessionId: string): SessionGoal | null | undefined { return this.rows.get(sessionId)?.goal }

  apply(sessionId: string, value: unknown, origin: 'baseline' | 'live', seq?: number): { accepted: boolean; completed?: SessionGoal } {
    let goal = projectGoal(value)
    if (goal === undefined) return { accepted: false }
    const previous = this.rows.get(sessionId)
    if (previous?.seq !== undefined && seq !== undefined && seq < previous.seq) return { accepted: false }
    if (goal && previous?.goal?.id === goal.id && goal.revision < previous.goal.revision) return { accepted: false }
    const edge = this.activation.get(sessionId)
    if (goal && edge?.id === goal.id && edge.revision === goal.revision) goal = { ...goal, activation: edge.activation }
    // A baseline with no process-local observation must not erase one already known for the same ref.
    if (goal && goal.activation === undefined && previous?.goal?.id === goal.id && previous.goal.revision === goal.revision && previous.goal.activation) {
      goal = { ...goal, activation: previous.goal.activation }
    }
    const shouldNotify = origin === 'live' && goal?.phase === 'complete' && previous?.goal?.id === goal.id &&
      previous.goal.phase !== 'complete' && !this.completed.get(sessionId)?.has(goal.id)
    if (goal?.phase === 'complete') {
      const done = this.completed.get(sessionId) ?? new Set<string>()
      this.completed.set(sessionId, done.add(goal.id))
    }
    // A goal can complete inside a tool call, before its turn ends: keep that turn a goal turn.
    if (origin === 'live' && goal && (shouldNotify || goal.phase !== 'complete')) this.goalTurns.add(sessionId)
    this.rows.set(sessionId, { goal, ...(seq === undefined ? (previous?.seq === undefined ? {} : { seq: previous.seq }) : { seq }) })
    return { accepted: true, ...(shouldNotify && goal ? { completed: goal } : {}) }
  }

  private unfinished(sessionId: string): boolean {
    const goal = this.get(sessionId)
    return goal != null && goal.phase !== 'complete'
  }

  turnStarted(sessionId: string): void {
    if (this.unfinished(sessionId)) this.goalTurns.add(sessionId)
    else this.goalTurns.delete(sessionId)
  }

  /** A goal spans turns, so a successful goal turn is not itself a completion worth announcing. */
  inGoalTurn(sessionId: string): boolean {
    return this.goalTurns.has(sessionId) || this.unfinished(sessionId)
  }

  turnEnded(sessionId: string): void { this.goalTurns.delete(sessionId) }

  /** Drop everything known about a session the Host no longer lists. */
  forget(sessionId: string): void {
    this.rows.delete(sessionId)
    this.completed.delete(sessionId)
    this.activation.delete(sessionId)
    this.goalTurns.delete(sessionId)
  }

  activate(sessionId: string, value: unknown): boolean {
    const edge = object(value)
    if (!edge || typeof edge.id !== 'string' || !integer(edge.revision, 1) ||
        (edge.activation !== 'armed' && edge.activation !== 'disarmed')) return false
    const current = this.rows.get(sessionId)
    const old = this.activation.get(sessionId)
    if (old?.id === edge.id && old.revision > edge.revision) return false
    if (current?.goal?.id === edge.id && current.goal.revision > edge.revision) return false
    const next = edge as unknown as GoalActivationEdge
    this.activation.set(sessionId, next)
    if (current?.goal?.id !== next.id || current.goal.revision !== next.revision) return false
    current.goal = { ...current.goal, activation: next.activation }
    return true
  }
}
