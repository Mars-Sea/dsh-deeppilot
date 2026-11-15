import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DshSessionControls, SessionControlCoordinator, ControlRejection } from '../src/session-controls.ts'
import { wireFrameRows } from '../src/wire-registry.ts'

const identity = () => `${Date.now()}-${randomUUID()}`
function fixture() {
  let current: any, inserted = 0, maintenance = false
  const agent = {
    id: 's', session: {}, status: 'idle', inbox: { nextTurn: [] as any[], nextStep: [] as any[] },
    runMaintenance: async (fn: (signal: AbortSignal) => Promise<any>) => {
      if (maintenance) throw new Error('busy')
      maintenance = true
      try { return await fn(new AbortController().signal) } finally { maintenance = false }
    },
    followup: (message: any) => { assert.equal(maintenance, true); assert.equal(message.source.kind, 'retry');
      assert.deepEqual(message.content, []); assert.equal(Object.isFrozen(message), true); inserted++; agent.inbox.nextTurn.push(message) },
  }
  const services: Record<string, any> = {
    sessionController: { resolveAgent: async () => ({ agent }), projections: async () => ({ kind: 'sequenced', values: { conversationContinuation: 7 } }) },
    sessionProjections: { snapshot: () => ({ values: { conversationContinuation: 7 } }) },
    typert: { getPackage: () => ({ model: { fields: ['conversationContinuation'] } }) },
    goals: {
      get: () => current,
      create: (_: any, patch: any) => current = { id: randomUUID(), revision: 1, ...patch },
      edit: (_: any, ref: any, patch: any) => { assert.equal(ref.revision, current.revision); return current = { ...current, ...patch, revision: current.revision + 1 } },
      pause: () => current = { ...current, revision: current.revision + 1, phase: 'paused' },
      resume: () => current = { ...current, revision: current.revision + 1, phase: 'active' },
      clear: () => { const ref = { id: current.id, revision: current.revision + 1 }; current = undefined; return ref },
    },
  }
  return { api: new DshSessionControls({ get: (key: string) => services[key] } as never), services, agent, inserted: () => inserted, goal: () => current }
}

test('continuation checks exact Host ending and inbox inside maintenance, without an empty user bubble', async () => {
  const f = fixture(), signal = new AbortController().signal
  assert.equal(f.api.continuationAvailable, true)
  assert.deepEqual(await f.api.state('s', signal), { sessionId: 's', continuationEnding: 7 })
  const request = { sessionId: 's', action: 'continue' as const, endingSeq: 6, clientRequestId: identity() }
  await assert.rejects(f.api.execute(request, signal), (e: any) => e instanceof ControlRejection && e.code === 'E_BUSY')
  assert.equal(f.inserted(), 0)
  await f.api.execute({ ...request, endingSeq: 7 }, signal)
  await assert.rejects(f.api.execute({ ...request, endingSeq: 7 }, signal))
  assert.equal(f.inserted(), 1)
})

test('absence of authoritative reflection disables continuation', async () => {
  const f = fixture(); delete f.services.typert
  assert.equal(f.api.continuationAvailable, false)
  await assert.rejects(f.api.execute({ sessionId: 's', action: 'continue', endingSeq: 7, clientRequestId: identity() }, new AbortController().signal))
  assert.equal(f.inserted(), 0)
})

test('goal writes preserve arbitrary objective text and reject stale or absent refs', async () => {
  const f = fixture(), signal = new AbortController().signal
  await f.api.execute({ sessionId: 's', action: 'create', expectedGoal: null, patch: { objective: 'pause\n清除也只是正文' }, clientRequestId: identity() }, signal)
  assert.equal(f.goal().objective, 'pause\n清除也只是正文')
  const ref = { id: f.goal().id, revision: f.goal().revision }
  await f.api.execute({ sessionId: 's', action: 'edit', expectedGoal: ref, patch: { objective: 'new' }, clientRequestId: identity() }, signal)
  await assert.rejects(f.api.execute({ sessionId: 's', action: 'clear', expectedGoal: ref, clientRequestId: identity() }, signal))
  assert.equal(f.goal().objective, 'new')
  await assert.rejects(f.api.execute({ sessionId: 's', action: 'create', expectedGoal: null, patch: { objective: 'wrong' }, clientRequestId: identity() }, signal))
})

test('durable operations deduplicate, isolate devices/sessions and do not persist objective text', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dp-controls-'))
  try {
    const path = join(directory, 'journal.json'), f = fixture(), coordinator = new SessionControlCoordinator(() => f.api, path)
    const request = { sessionId: 's', action: 'create' as const, expectedGoal: null, patch: { objective: 'private-objective-never-in-journal' }, clientRequestId: identity() }
    const a = await coordinator.execute('device', request, new AbortController().signal)
    assert.deepEqual(await coordinator.execute('device', request, new AbortController().signal), a)
    assert.equal(a.status, 'accepted')
    assert.equal(readFileSync(path, 'utf8').includes(request.patch.objective), false)
    assert.equal(coordinator.status('other', 's', request.clientRequestId).status, 'notFound')
    assert.equal(coordinator.status('device', 'other-session', request.clientRequestId).status, 'notFound')
    assert.equal((await coordinator.execute('device', { ...request, patch: { objective: 'different' } }, new AbortController().signal)).status, 'rejected')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('unconfirmed side effects stay unknown and repeated requests never call Host again', async () => {
  let calls = 0
  const coordinator = new SessionControlCoordinator(() => ({ continuationAvailable: true, goalManagementAvailable: true,
    state: async sessionId => ({ sessionId }), execute: async () => { calls++; throw new Error('lost reply') } }))
  const request = { sessionId: 's', action: 'continue' as const, endingSeq: 7, clientRequestId: identity() }
  assert.equal((await coordinator.execute('d', request, new AbortController().signal)).status, 'unknown')
  assert.equal((await coordinator.execute('d', request, new AbortController().signal)).status, 'unknown')
  assert.equal(calls, 1)
})

test('wire validators require explicit actions and refs with bounded objectives', () => {
  const goal = wireFrameRows().find(r => r.type === 'c2s.session.goal.manage')!, common = { sessionId: 's', clientRequestId: identity() }
  assert.equal(goal.validate!({ ...common, action: 'clear', expectedGoal: null }).ok, false)
  assert.equal(goal.validate!({ ...common, action: 'create', expectedGoal: null, patch: { objective: ' ' } }).ok, false)
  assert.equal(goal.validate!({ ...common, action: 'create', expectedGoal: null, patch: { objective: 'clear' } }).ok, true)
})

test('migration cache hints never authorize a continuation button', async () => {
  const f = fixture()
  f.services.sessionController.projections = async () => ({ kind: 'migration-required', values: { conversationContinuation: 7 } })
  assert.deepEqual(await f.api.state('s', new AbortController().signal), { sessionId: 's' })
})
