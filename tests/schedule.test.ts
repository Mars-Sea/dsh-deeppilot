import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike } from '../src/host-api.ts'
import { MutationJournal } from '../src/mutation-journal.ts'
import { validateRequest } from '../src/request-validation.ts'

const requestId = (): string => `${Date.now()}-${randomUUID()}`

function scheduleController(calls: Array<{ operation: string; payload: unknown }>) {
  return {
    list: async ({ sessionId }: { sessionId: string }) => {
      calls.push({ operation: 'list', payload: { sessionId } })
      return [{
        id: 'schedule-1', kind: 'after', title: '检查构建', prompt: '检查构建状态',
        afterSeconds: 600, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
      }]
    },
    history: async (request: unknown) => {
      calls.push({ operation: 'history', payload: request })
      return { id: 'schedule-1', records: [], earlierRecordsUnavailable: false, retention: { days: 30, records: 200 } }
    },
    create: async (sessionId: string, request: Record<string, unknown>) => {
      calls.push({ operation: 'create', payload: { sessionId, request } })
      return {
        id: 'schedule-1', kind: 'after', title: request.title, prompt: request.prompt,
        afterSeconds: 600, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
      }
    },
    update: async (request: Record<string, unknown>) => {
      calls.push({ operation: 'update', payload: request })
      return { id: 'schedule-1', updated: true, record: {
        id: 'schedule-1', kind: 'after', title: request.title ?? '检查构建', prompt: request.prompt ?? '检查构建状态',
        afterSeconds: 600, scheduledAt: '2099-01-01T00:00:00.000Z', state: 'scheduled', deliveryMode: 'host',
      } }
    },
    delete: async (request: { id: string }) => {
      calls.push({ operation: 'delete', payload: request })
      return { id: request.id, deleted: true }
    },
  }
}

test('DSH Schedule facade projects list and preserves the DSH session boundary', async () => {
  const calls: Array<{ operation: string; payload: unknown }> = []
  const ctx = {
    get: (key: string) => key === 'sessionController' ? {} : key === 'schedule' ? scheduleController(calls) : undefined,
  }
  const proxy = new DshApiProxy(ctx as never)
  assert.ok(proxy.schedule)
  const response = await proxy.schedule!.list({ payload: { sessionId: 'session-1' } })
  assert.equal(response.result?.ok, true)
  assert.deepEqual(calls[0], { operation: 'list', payload: { sessionId: 'session-1' } })
  if (response.result?.ok) {
    assert.equal(response.result.value.tasks[0]?.title, '检查构建')
    assert.equal(response.result.value.tasks[0]?.deliveryMode, 'host')
  }
})

test('HostBridge schedule capability and mutations are capability-gated and idempotent', async () => {
  const calls: Array<{ operation: string; payload: unknown }> = []
  const ctx = {
    get: (key: string) => key === 'sessionController' ? {} : key === 'schedule' ? scheduleController(calls) : undefined,
  }
  const proxy = new DshApiProxy(ctx as never)
  const bridge = new HostBridge(proxy as ApiProxyLike)
  assert.equal(bridge.capabilities.schedules, true)

  const id = requestId()
  const payload = {
    clientRequestId: id,
    sessionId: 'session-1',
    title: '检查构建',
    prompt: '检查构建状态',
    after_seconds: 600,
  }
  const first = await bridge.createSchedule('device-1', payload)
  const second = await bridge.createSchedule('device-1', payload)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.replayed, true)
  assert.equal(calls.filter(call => call.operation === 'create').length, 1)

  const changed = await bridge.createSchedule('device-1', { ...payload, title: '另一个标题' })
  assert.equal(changed.ok, false)
  if (!changed.ok) assert.equal(changed.kind, 'invalid')
  bridge.dispose()
})

test('Schedule request validation bounds ids, selectors, history, and updates', () => {
  const id = requestId()
  assert.equal(validateRequest('c2s.schedule.create', {
    clientRequestId: id, sessionId: 's', title: 'Build', prompt: 'Check', after_seconds: 600,
  }), undefined)
  assert.ok(validateRequest('c2s.schedule.create', {
    clientRequestId: id, sessionId: 's', title: 'Build', prompt: 'Check', after_seconds: 0,
  }))
  assert.ok(validateRequest('c2s.schedule.create', {
    clientRequestId: id, sessionId: 's', title: 'Build', prompt: 'Check', after_seconds: 600, every_seconds: 600,
  }))
  assert.ok(validateRequest('c2s.schedule.history', { sessionId: 's', id: 'schedule-1', limit: 0 }))
  assert.equal(validateRequest('c2s.schedule.history', { sessionId: 's', id: 'schedule-1', limit: 100 }), undefined)
  assert.equal(validateRequest('c2s.schedule.update', {
    clientRequestId: id, sessionId: 's', id: 'schedule-1', expected: {},
  }), undefined)
  assert.ok(validateRequest('c2s.schedule.delete', { clientRequestId: 'bad', sessionId: 's', id: 'schedule-1' }))
})

test('Session fork creates one new session and preserves the source', async () => {
  let forkCalls = 0
  const sessionController = {
    list: async () => ({ items: [{ sessionId: 'source-session', updatedAt: 1, running: false }] }),
    fork: async () => {
      forkCalls += 1
      return { sessionId: 'forked-session' }
    },
  }
  const proxy = new DshApiProxy({ get: (key: string) => key === 'sessionController' ? sessionController : undefined } as never)
  const bridge = new HostBridge(proxy as ApiProxyLike)
  await bridge.refreshSummaries()
  const clientRequestId = requestId()
  const first = await bridge.forkSession('device-1', { clientRequestId, sessionId: 'source-session', atSeq: 7 })
  const second = await bridge.forkSession('device-1', { clientRequestId, sessionId: 'source-session', atSeq: 7 })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  if (first.ok) assert.equal(first.value.sessionId, 'forked-session')
  if (second.ok) assert.equal(second.replayed, true)
  assert.equal(forkCalls, 1)
  assert.equal(validateRequest('c2s.session.fork', { clientRequestId, sessionId: 'source-session', atSeq: 7 }), undefined)
  bridge.dispose()
})
test('MutationJournal does not persist prompt bodies and prevents duplicate execution', async () => {
  const journal = new MutationJournal()
  const id = requestId()
  let calls = 0
  const operation = async () => {
    calls += 1
    return { ok: true as const, value: { id: 'schedule-1', title: 'Check' } }
  }
  const first = await journal.dispatch('device', id, { prompt: 'secret reminder' }, operation)
  const second = await journal.dispatch('device', id, { prompt: 'secret reminder' }, operation)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.replayed, true)
  assert.equal(calls, 1)
  const changed = await journal.dispatch('device', id, { prompt: 'different' }, operation)
  assert.equal(changed.ok, false)
  if (!changed.ok) assert.equal(changed.code, 'E_PROTOCOL')
})
