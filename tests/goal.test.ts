import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { GoalProjectionTracker, projectGoal } from '../src/goal-projection.ts'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import { pushScopeFor } from '../src/connection-policy.ts'
import type { SessionGoal } from '../src/protocol.ts'
import type { ApiProxyLike, MuxFrameLike } from '../src/host-api.ts'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/session-goal.json', import.meta.url), 'utf8')) as Record<string, SessionGoal | null>
const active = fixtures.active!
function host(goal: SessionGoal | null): unknown {
  if (!goal) return null
  const { activation, roundsStarted, createdAt, updatedAt, ...snapshot } = goal
  return { goal: snapshot, roundsStarted, createdAt, updatedAt, ...(activation ? { activation } : {}) }
}

test('shared goal fixture flattens the authoritative host projection, including explicit clear and missing activation', () => {
  for (const goal of Object.values(fixtures)) assert.deepEqual(projectGoal(host(goal)), goal)
  assert.equal(projectGoal(undefined), undefined)
  assert.equal(projectGoal({ goal: active }), undefined)
  assert.equal(projectGoal(host({ ...active, revision: -1 })), undefined)
  assert.equal(projectGoal(host({ ...fixtures.blocked!, blockedReason: undefined })), undefined)
})

test('goal tracker orders baselines and live snapshots, never manufactures completion from baseline/reload', () => {
  const tracker = new GoalProjectionTracker()
  assert.equal(tracker.apply('s', host(active), 'baseline', 10).completed, undefined)
  assert.equal(tracker.apply('s', host(fixtures.complete!), 'live', 20).completed?.id, active.id)
  assert.equal(tracker.apply('s', host(fixtures.complete!), 'live', 20).completed, undefined)
  assert.equal(tracker.apply('s', host(active), 'baseline', 10).accepted, false)
  tracker.apply('s', null, 'live', 21)
  assert.equal(tracker.get('s'), null)
  assert.equal(tracker.apply('s', host(fixtures.complete!), 'baseline', 20).accepted, false)
  const reloaded = new GoalProjectionTracker()
  reloaded.apply('s', host(fixtures.complete!), 'baseline', 20)
  assert.equal(reloaded.apply('s', host(fixtures.complete!), 'live', 20).completed, undefined)
  assert.equal(new GoalProjectionTracker().apply('s', host(fixtures.complete!), 'live', 20).completed, undefined)
})

test('tracker owns goal-turn membership and forgets removed sessions entirely', () => {
  const tracker = new GoalProjectionTracker()
  assert.equal(tracker.inGoalTurn('s'), false)
  tracker.apply('s', host(active), 'baseline', 10)
  tracker.turnStarted('s')
  // Completion inside the turn keeps that turn a goal turn until it ends.
  assert.equal(tracker.apply('s', host(fixtures.complete!), 'live', 20).completed?.id, active.id)
  assert.equal(tracker.inGoalTurn('s'), true)
  tracker.turnEnded('s')
  assert.equal(tracker.inGoalTurn('s'), false)
  tracker.turnStarted('s')
  assert.equal(tracker.inGoalTurn('s'), false, 'an ordinary turn after completion notifies normally')

  tracker.activate('s', { id: active.id, revision: fixtures.complete!.revision, activation: 'armed' })
  tracker.forget('s')
  assert.equal(tracker.get('s'), undefined)
  assert.equal(tracker.inGoalTurn('s'), false)
  // Nothing survives: an older baseline is accepted again and carries no stale activation.
  assert.equal(tracker.apply('s', host(fixtures.unknownActivation!), 'baseline', 1).accepted, true)
  assert.equal(tracker.get('s')?.activation, undefined)
})

test('activation merges only on the same id/revision, rejects delayed revisions and follows unchanged-revision disarm', () => {
  const tracker = new GoalProjectionTracker()
  tracker.apply('s', host(active), 'baseline', 10)
  assert.equal(tracker.activate('s', { id: active.id, revision: 1, activation: 'armed' }), false)
  assert.equal(tracker.activate('s', { id: 'other', revision: 2, activation: 'armed' }), false)
  assert.equal(tracker.activate('s', { id: active.id, revision: 2, activation: 'disarmed' }), true)
  assert.equal(tracker.get('s')?.activation, 'disarmed')
  tracker.activate('s', { id: active.id, revision: 3, activation: 'disarmed' })
  tracker.apply('s', host(fixtures.paused!), 'live', 11)
  assert.equal(tracker.get('s')?.activation, 'disarmed')
  assert.equal(tracker.activate('s', { id: active.id, revision: 2, activation: 'armed' }), false)
})

test('Host goal capability and activation use optional Cordis lookup and do not activate cold sessions', async () => {
  const ctx = new Context()
  const get = new Map<string, unknown>([['sessionController', {
    list: async () => ({ items: [{ sessionId: 's', projections: { asOfSeq: 10, values: { goal: host(active) } } }] }),
    projections: async () => ({ asOfSeq: 10, values: { goal: host(active) } }),
  }]])
  const originalGet = ctx.get.bind(ctx)
  ctx.get = ((key: string) => get.has(key) ? get.get(key) : originalGet(key)) as typeof ctx.get
  const proxy = new DshApiProxy(ctx)
  assert.equal(proxy.goalViewAvailable, false)
  get.set('sessionProjections', { summaryKeys: () => new Set(['goal']), onChanged: () => () => {} })
  assert.equal(proxy.goalViewAvailable, true)
  const agent = {}
  let live: unknown = agent
  get.set('agents', { get: () => live })
  get.set('goals', { get: (target: unknown) => { assert.equal(target, agent); return { ...active, activation: 'disarmed' } } })
  const read = async () => {
    const result = (await proxy.sessions.projections({ rpcId: 'goal-test', payload: { sessionId: 's' } })).result!
    assert.equal(result.ok, true)
    return result.ok ? projectGoal(result.value?.values.goal) : undefined
  }
  assert.equal((await read())?.activation, 'disarmed')
  live = undefined
  assert.equal((await read())?.activation, 'disarmed')
  get.set('goals', { get: () => ({ ...active, revision: active.revision + 1, activation: 'armed' }) })
  live = agent
  // Durable goal ref does not match the process read, so only the projection's own optional value remains.
  const baseline = get.get('sessionController') as any
  baseline.projections = async () => ({ asOfSeq: 10, values: { goal: host(fixtures.unknownActivation!) } })
  assert.equal((await read())?.activation, undefined)
})

test('cold goal hydration reads each session once, keeps explicit null, retries failures and follows live changes', async () => {
  const projections = new Map<string, unknown>([
    ['cleared', { asOfSeq: 20, values: { goal: null } }],
    ['never', { asOfSeq: 21, values: { title: 'no goal key' } }],
    ['failing', new Error('projection temporarily unavailable')],
    ['warm', new Error('warm rows already carry the key')],
  ])
  const calls: string[] = []
  let active_ = 0
  let peak = 0
  const items: Record<string, unknown>[] = [...projections.keys()].map(sessionId => ({ sessionId, running: false, updatedAt: 10 }))
  items[3]!.projections = { asOfSeq: 5, values: { goal: host(active) } }
  const services = new Map<string, unknown>([
    ['sessionController', {
      list: async () => ({ items }),
      projections: async (request: { sessionId: string }) => {
        calls.push(request.sessionId)
        peak = Math.max(peak, ++active_)
        await new Promise(resolve => setImmediate(resolve))
        active_--
        const value = projections.get(request.sessionId) ?? { asOfSeq: 1, values: {} }
        if (value instanceof Error) throw value
        return value
      },
    }],
    ['sessionProjections', { summaryKeys: () => new Set(['goal']), onChanged: () => () => {} }],
  ])
  const proxy = new DshApiProxy({ get: (key: string) => services.get(key) } as never)
  const goals = async () => {
    const result = (await proxy.sessions.list()).result!
    assert.equal(result.ok, true)
    return new Map((result.ok ? result.value.items : []).map(row => [row.sessionId, row.projections?.values]))
  }
  let rows = await goals()
  assert.equal(rows.get('cleared')?.goal, null)
  assert.equal(Object.hasOwn(rows.get('never') ?? {}, 'goal'), false)
  assert.equal(Object.hasOwn(rows.get('failing') ?? {}, 'goal'), false)
  assert.equal(projectGoal(rows.get('warm')?.goal)?.id, active.id)
  assert.deepEqual(calls.sort(), ['cleared', 'failing', 'never'])

  // Later lists reuse the baseline instead of reading every goal-less session again.
  projections.set('cleared', { asOfSeq: 30, values: { goal: host(active) } })
  rows = await goals()
  assert.equal(rows.get('cleared')?.goal, null)
  assert.deepEqual(calls.sort(), ['cleared', 'failing', 'failing', 'never'], 'only the failed read is retried')

  // A live goal change retires the cached baseline for that session only.
  ;(proxy as any).forgetColdGoal('cleared')
  rows = await goals()
  assert.equal(projectGoal(rows.get('cleared')?.goal)?.id, active.id)
  assert.equal(calls.filter(id => id === 'never').length, 1)

  // Many cold sessions are read with bounded concurrency.
  for (let i = 0; i < 40; i++) items.push({ sessionId: 'bulk-' + i, running: false, updatedAt: 10 })
  peak = 0
  await goals()
  assert.equal(peak, 8)

  const before = calls.length
  services.delete('sessionProjections')
  assert.equal((await goals()).get('cleared'), undefined)
  assert.equal(calls.length, before, 'unsupported hosts must not trigger optional hydration reads')
})

function bridgeHarness() {
  const rows = [{ sessionId: 's', running: true, updatedAt: 10, projections: { asOfSeq: 10, values: { goal: host(active) } } }]
  const proxy = { sessions: { list: async () => ({ result: { ok: true, value: { items: rows } } }) } } as unknown as ApiProxyLike
  const bridge = new HostBridge(proxy, 100)
  const notifications: any[] = []
  const frames: any[] = []
  bridge.setPushOutlet({ fanOut: n => notifications.push(n), isAvailable: () => true })
  const sink = { push: (type: string, payload: unknown) => frames.push({ type, payload }), lastCursor: () => 0,
    replay: () => {}, replayDone: () => {}, resync: () => {}, canReceive: () => true }
  bridge.addSink(sink)
  const frame = (f: MuxFrameLike) => (bridge as any).onMuxFrame(f)
  const turn = (type: 'turn/start' | 'turn/end', seq: number, status = 'completed') => frame({ type: 'session/event', sessionId: 's', event: { type, seq, data: type === 'turn/end' ? { turn: seq, reason: { kind: status } } : { turn: seq } } })
  const goal = (g: SessionGoal | null, seq: number) => frame({ type: 'session/projection', sessionId: 's', key: 'goal', value: host(g), seq })
  return { bridge, notifications, frames, sink, rows, frame, turn, goal }
}

test('live goal completion notifies viewed online clients once, suppresses goal turns but allows a later ordinary turn', async () => {
  const h = bridgeHarness()
  try {
    await (h.bridge as any).refreshSummaries()
    assert.equal(h.bridge.listSessions()[0]?.goal?.phase, 'active')
    await h.bridge.openSession(h.sink, 's', 1) // absent history can fail without removing viewed binding
    h.turn('turn/start', 11)
    assert.equal((h.bridge as any).goals.inGoalTurn('s'), true)
    h.turn('turn/end', 12)
    assert.equal(h.notifications.length, 0)
    h.turn('turn/start', 13)
    h.goal(fixtures.complete!, 20)
    h.goal(fixtures.complete!, 20)
    h.turn('turn/end', 21)
    assert.deepEqual(h.notifications.map(n => n.category), ['goal.completed'])
    assert.equal(h.notifications[0].notificationId, 'goal-goal-1:s')
    assert.equal(h.frames.filter(f => f.type === 's2c.notify' && f.payload.category === 'goal.completed').length, 1)
    h.turn('turn/start', 22)
    h.turn('turn/end', 23)
    assert.deepEqual(h.notifications.map(n => n.category), ['goal.completed', 'turn.completed'])
    h.goal(null, 24)
    assert.equal(h.bridge.listSessions()[0]?.goal, null)
    h.goal(active, 10)
    assert.equal(h.bridge.listSessions()[0]?.goal, null)
    assert.equal(pushScopeFor('s2c.notify', { category: 'goal.completed' }), 'sessions.read')
  } finally { h.bridge.dispose() }
})

test('terminal baseline never notifies; blocked/paused/disarmed suppress successful turns while failures still alert', async () => {
  const h = bridgeHarness()
  h.rows[0]!.projections.values.goal = host(fixtures.complete!)
  try {
    await (h.bridge as any).refreshSummaries()
    assert.equal(h.notifications.length, 0)
    for (const [i, state] of [fixtures.paused!, fixtures.blocked!, fixtures.disarmed!].entries()) {
      h.goal({ ...state, id: 'goal-' + (i + 2) }, 30 + i * 3)
      h.turn('turn/start', 31 + i * 3)
      h.turn('turn/end', 32 + i * 3)
    }
    assert.equal(h.notifications.length, 0)
    h.turn('turn/start', 50)
    h.turn('turn/end', 51, 'failed')
    assert.equal(h.notifications.at(-1)?.category, 'session.error')
  } finally { h.bridge.dispose() }
})
