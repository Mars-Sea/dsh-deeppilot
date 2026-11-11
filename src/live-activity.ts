import type { DeviceStore } from './token.ts'
import type { LiveActivityState, LiveActivityPushNotification, SessionSummary } from './protocol.ts'
import type { ApnsSendResult } from './apns.ts'
import { WidgetPushScheduler } from './widget-push.ts'

export function liveActivityState(session?: SessionSummary): LiveActivityState {
  const total = Math.max(0, session?.todos?.total ?? session?.todoItems?.length ?? 0)
  const done = Math.min(total, Math.max(0, session?.todos?.done ?? 0))
  const task = session?.todoItems?.find(item => item.status === 'in_progress') ??
    session?.todoItems?.find(item => item.status === 'pending')
  const goal = session?.goal
  // Keep this projection identical to the iOS ContentState.project rule:
  // terminal/paused goals win, pending interactions win over disarmed, and a
  // running turn is evidence of execution even when activation is unknown.
  const phase: LiveActivityState['phase'] = goal
    ? goal.phase === 'complete' ? 'ended' : goal.phase === 'blocked' ? 'failed' :
      goal.phase !== 'active' ? 'unavailable' :
      session?.pendingApproval ? 'approval' : session?.pendingQuestion ? 'question' :
      goal.activation === 'disarmed' ? 'unavailable' :
      session?.status === 'running' || goal.activation === 'armed' ? 'running' : 'unavailable'
    : !session || total === 0 ? 'unavailable' : session.pendingApproval ? 'approval' :
      session.pendingQuestion ? 'question' : session.status === 'running' ? 'running' :
      session.status === 'idle' ? 'ended' : session.status === 'error' ? 'failed' : 'unavailable'
  return {
    ...(goal ? { goalId: goal.id, goalText: Array.from(goal.objective).slice(0, 160).join(''), goalPhase: goal.phase,
      goalRounds: goal.roundsStarted, goalMaxRounds: goal.maxGoalRounds, goalStartedAt: goal.createdAt } : {}),
    title: Array.from(session?.title ?? '').slice(0, 100).join(''),
    task: Array.from(session?.activity?.trim() || task?.content || '').slice(0, 160).join(''), done, total,
    phase,
  }
}

/** Goal pauses/disarming are non-executing updates, never terminal completion. */
export function liveActivityEnded(state: LiveActivityState): boolean {
  if (state.goalId) return state.goalPhase === 'complete' || state.goalPhase === 'blocked'
  return state.phase === 'ended' || state.phase === 'failed' || state.phase === 'unavailable'
}

function stateForRegistration(session: SessionSummary | undefined, goalId?: string): LiveActivityState | undefined {
  if (goalId && session && session.goal === undefined) return undefined // incomplete baseline
  if (goalId && session?.goal?.id !== goalId) return liveActivityState()
  // Legacy registrations without an explicit goal binding retain their turn/todo lifecycle.
  return liveActivityState(goalId || !session ? session : { ...session, goal: undefined })
}

/** Persist terminal state before coalescing so a rapid next round cannot revive an activity. */
export class LiveActivityPushManager {
  private latest = new Map<string, SessionSummary>()
  private sent = new Map<string, string>()
  private readonly scheduler: WidgetPushScheduler
  constructor(
    private readonly devices: () => DeviceStore | undefined,
    private readonly send: (token: string, environment: 'development' | 'production', notification: LiveActivityPushNotification) => Promise<ApnsSendResult>,
    intervalMs = 15_000,
  ) { this.scheduler = new WidgetPushScheduler(() => this.flush(), intervalMs) }

  changed(sessions: SessionSummary[]): void {
    this.latest = new Map(sessions.map(session => [session.id, session]))
    for (const device of this.devices()?.list() ?? []) {
      const r = device.liveActivity
      if (!r) continue
      const state = stateForRegistration(this.latest.get(r.sessionId), r.goalId)
      if (state && liveActivityEnded(state)) {
        this.devices()?.endLiveActivity(device.deviceId, r.token, state)
      }
    }
    this.scheduler.changed()
  }

  async flush(): Promise<void> {
    const devices = this.devices()
    if (!devices) return
    const valid = new Set<string>()
    for (const device of devices.list()) {
      const r = device.liveActivity
      if (!r) continue
      const key = device.deviceId + ':' + r.token
      valid.add(key)
      if (device.revokedAt !== undefined || !['notifications.register', 'sessions.read', 'interactions.respond'].every(scope => device.scopes?.some(value => value === scope)) || r.expiresAt <= Date.now()) {
        devices.clearLiveActivity(device.deviceId, r.activityId, r.token)
        continue
      }
      const state = r.endedState ?? stateForRegistration(this.latest.get(r.sessionId), r.goalId)
      if (!state) continue
      const fingerprint = JSON.stringify(state)
      if (this.sent.get(key) === fingerprint) continue
      // Never send a queued registration after it has rotated or been removed.
      if (devices.authorized(device.deviceId)?.liveActivity?.token !== r.token) continue
      const result = await this.send(r.token, r.environment, {
        kind: 'liveactivity', event: r.endedState ? 'end' : 'update',
        timestamp: Math.floor(Date.now() / 1000), contentState: state,
      }).catch((): ApnsSendResult => ({ outcome: 'failed' }))
      if (result.outcome === 'sent') {
        this.sent.set(key, fingerprint)
        // Retain the terminal tombstone until expiry/unregister: reconnect and token rotation cannot restart this round.
      } else if (result.outcome === 'invalid-token') {
        devices.clearLiveActivity(device.deviceId, r.activityId, r.token)
      } else {
        this.scheduler.changed()
      }
    }
    for (const key of this.sent.keys()) if (!valid.has(key)) this.sent.delete(key)
  }
  dispose(): void { this.scheduler.dispose() }
}
