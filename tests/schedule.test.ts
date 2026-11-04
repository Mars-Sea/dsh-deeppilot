import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { ApiProxyLike } from '../src/host-api.ts'
import { DispatchJournal, scheduleMutationCodec } from '../src/dispatch-journal.ts'
import { capabilityRejection, registryRowFor, validatePayload } from '../src/wire-registry.ts'

const requestId = (): string => `${Date.now()}-${randomUUID()}`

/** 行内校验的可读拒绝理由；通过时 undefined。 */
function reason(row: { validate?: (payload: unknown) => unknown }, payload: unknown): string | undefined {
  const checked = validatePayload(row as never, payload)
  return checked.ok ? undefined : checked.message
}

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
  if (proxy.schedule?.mode !== 'legacy') assert.fail('legacy schedule adapter expected')
  const response = await proxy.schedule.list({ payload: { sessionId: 'session-1' } })
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
  if (!changed.ok) assert.equal(changed.code, 'E_PROTOCOL')
  bridge.dispose()
})

test('Schedule rows bound ids, selectors, history, and updates', () => {
  const id = requestId()
  const row = (type: string) => registryRowFor(type)!
  assert.equal(reason(row('c2s.schedule.create'), {
    clientRequestId: id, sessionId: 's', title: 'Build', prompt: 'Check', after_seconds: 600,
  }), undefined)
  assert.equal(reason(row('c2s.schedule.create'), {
    clientRequestId: id, sessionId: 's', title: 'Build', prompt: 'Check', after_seconds: 0,
  }), 'invalid after_seconds')
  assert.equal(reason(row('c2s.schedule.create'), {
    clientRequestId: id, sessionId: 's', title: 'Build', prompt: 'Check', after_seconds: 600, every_seconds: 600,
  }), 'schedule requires exactly one selector')
  assert.equal(reason(row('c2s.schedule.history'), { sessionId: 's', id: 'schedule-1', limit: 0 }), 'invalid schedule history')
  assert.equal(reason(row('c2s.schedule.history'), { sessionId: 's', id: 'schedule-1', limit: 100 }), undefined)
  assert.equal(reason(row('c2s.schedule.update'), {
    clientRequestId: id, sessionId: 's', id: 'schedule-1', expected: {},
  }), undefined)
  assert.equal(reason(row('c2s.schedule.delete'), { clientRequestId: 'bad', sessionId: 's', id: 'schedule-1' }), 'invalid schedule delete fields')
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
  assert.equal(reason(registryRowFor('c2s.session.fork')!, { clientRequestId, sessionId: 'source-session', atSeq: 7 }), undefined)
  bridge.dispose()
})
test('MutationJournal does not persist prompt bodies and prevents duplicate execution', async () => {
  const journal = new DispatchJournal({
    codec: scheduleMutationCodec(false),
    joinInFlight: false,
    maxFileBytes: 4 * 1024 * 1024,
  })
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

/* ---------- 宿主级模型（DSH 0.2.2-alpha.3 起，schedulesHost） ---------- */

type HostCall = { operation: string; payload: unknown }

/** 宿主级任务记录（DSH 存储记录形状：camelCase 字段）。 */
function hostTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'schedule-host-1',
    kind: 'every',
    title: '巡检',
    prompt: '巡检状态',
    everySeconds: 3600,
    scheduledAt: '2099-01-01T00:00:00.000Z',
    target: { kind: 'session', sessionId: 'session-1' },
    involvedSessionIds: ['session-1'],
    status: 'active',
    createdAt: '2026-11-03T12:00:00.000Z',
    updatedAt: '2026-11-03T12:00:00.000Z',
    ...overrides,
  }
}

/**
 * 假宿主级 Schedule 服务：形状与 DSH `ScheduleService` 一致（edit 无 update、
 * list 返回分页对象、miss 用结果对象 code 表达），不依赖真实 DSH。
 */
function hostScheduleController(
  calls: HostCall[],
  seed: Array<Record<string, unknown>> = [],
  options: {
    runPending?: boolean
    runArchived?: boolean
    createInvalid?: boolean
    unknownError?: boolean
    historyMissing?: boolean
    deleteEndedFails?: boolean
  } = {},
) {
  const rows = new Map(seed.map((row) => [String(row.id), { ...row }]))
  return {
    list: async (request: { active?: boolean; limit?: number; offset?: number } = {}) => {
      calls.push({ operation: 'list', payload: request })
      const matched = [...rows.values()].filter((row) =>
        request.active === undefined ? true : request.active === true ? row.status === 'active' : row.status !== 'active')
      const offset = request.offset ?? 0
      const limit = request.limit ?? 100
      const items = matched.slice(offset, offset + limit)
      return { items, shown: items.length, total: matched.length, limit, offset }
    },
    view: async (request: { id: string }) => {
      calls.push({ operation: 'view', payload: request })
      const row = rows.get(request.id)
      return row ? { ...row } : { id: request.id, code: 'schedule_not_found' }
    },
    create: async (request: Record<string, any>) => {
      calls.push({ operation: 'create', payload: request })
      if (options.createInvalid) {
        throw Object.assign(new Error('invalid timing'), { code: 'schedule/input-invalid' })
      }
      const timing = request.timing as Record<string, any>
      const record: Record<string, unknown> = {
        ...hostTask(),
        id: `schedule-host-${rows.size + 10}`,
        title: request.title,
        prompt: request.prompt,
        target: request.target ?? { kind: 'new_once', sessionId: 'session-reserved', create: {} },
      }
      delete record.everySeconds
      record.kind = timing.kind
      if (timing.kind === 'after') record.afterSeconds = timing.after_seconds
      if (timing.kind === 'every') record.everySeconds = timing.every_seconds
      rows.set(String(record.id), record)
      return { ...record }
    },
    edit: async (request: Record<string, any>) => {
      calls.push({ operation: 'edit', payload: request })
      const row = rows.get(request.id)
      if (!row) return { id: request.id, code: 'schedule_not_found' }
      if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== row.updatedAt) {
        return { id: request.id, code: 'schedule_conflict' }
      }
      if (request.action === 'delete') {
        rows.delete(request.id)
        return { id: request.id, deleted: true }
      }
      const patch = request.patch as Record<string, any>
      if (patch.title !== undefined) row.title = patch.title
      if (patch.prompt !== undefined) row.prompt = patch.prompt
      if (patch.timing !== undefined) {
        row.kind = patch.timing.kind
        if (patch.timing.kind === 'every') row.everySeconds = patch.timing.every_seconds
      }
      if (patch.active === false) row.status = 'paused'
      if (patch.active === true) row.status = 'active'
      row.updatedAt = '2026-11-03T13:00:00.000Z'
      return { ...row }
    },
    run: async (request: { id: string }) => {
      calls.push({ operation: 'run', payload: request })
      if (options.runArchived) throw Object.assign(new Error('target archived'), { code: 'schedule/target-archived' })
      if (options.unknownError) throw Object.assign(new Error('boom'), { code: 'schedule/something-else' })
      const row = rows.get(request.id)
      if (!row) return { id: request.id, code: 'schedule_not_found' }
      if (options.runPending) return { id: request.id, code: 'schedule_execution_pending' }
      return { ...row }
    },
    history: async (request: { id: string; limit: number; before?: string }) => {
      calls.push({ operation: 'history', payload: request })
      if (options.historyMissing) return { id: request.id, code: 'delivery_cursor_not_found' }
      return {
        id: request.id,
        records: [{ scheduledAt: '2099-01-01T00:00:00.000Z', deliveredAt: '2099-01-01T00:00:01.000Z', messageId: 'message-1' }],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
      }
    },
    deliveryLimits: () => {
      calls.push({ operation: 'limits', payload: {} })
      return { newSessionIntervalSeconds: 60 }
    },
    // 与 alpha.3 一致：只删 status="ended"，返回 { deleted }。
    deleteInactive: async () => {
      calls.push({ operation: 'deleteInactive', payload: {} })
      if (options.deleteEndedFails) throw Object.assign(new Error('boom'), { code: 'schedule/something-else' })
      let deleted = 0
      for (const [id, row] of rows) {
        if (row.status === 'ended') { rows.delete(id); deleted += 1 }
      }
      return { deleted }
    },
  }
}

function hostProxy(
  calls: HostCall[],
  seed: Array<Record<string, unknown>> = [],
  options: Parameters<typeof hostScheduleController>[2] = {},
): DshApiProxy {
  const controller = hostScheduleController(calls, seed, options)
  return new DshApiProxy({
    get: (key: string) => key === 'sessionController' ? {} : key === 'schedule' ? controller : undefined,
  } as never)
}

/** 取宿主级 adapter（测试里显式断言判别位，避免误用 legacy 分支）。 */
function hostScheduleApi(proxy: DshApiProxy) {
  const schedule = proxy.schedule
  if (schedule === undefined || schedule.mode !== 'host') throw new Error('host schedule adapter expected')
  return schedule
}

test('宿主级形状探测与 schedulesHost 能力位同源，legacy 宿主不受影响', () => {
  const host = hostProxy([])
  assert.equal(host.schedule?.mode, 'host')
  const hostBridge = new HostBridge(host as ApiProxyLike)
  try {
    assert.equal(hostBridge.capabilities.schedules, true, '服务存在仍是会话级能力位的语义')
    assert.equal(hostBridge.capabilities.schedulesHost, true)
  } finally {
    hostBridge.dispose()
  }

  const legacy = new DshApiProxy({
    get: (key: string) => key === 'sessionController' ? {} : key === 'schedule' ? scheduleController([]) : undefined,
  } as never)
  const legacyBridge = new HostBridge(legacy as ApiProxyLike)
  try {
    assert.equal(legacyBridge.capabilities.schedules, true)
    assert.equal(legacyBridge.capabilities.schedulesHost, false, 'legacy 宿主不得通告宿主级能力')
  } finally {
    legacyBridge.dispose()
  }
})

test('宿主级 facade 投影分页列表、timing/target，并隐藏 involvedSessionIds', async () => {
  const calls: HostCall[] = []
  const proxy = hostProxy(calls, [
    hostTask(),
    hostTask({
      id: 'schedule-host-2',
      kind: 'daily',
      time: '09:00:00.000',
      timeZone: 'Asia/Shanghai',
      target: { kind: 'new_once', sessionId: 'session-reserved', create: { cwd: '/tmp/project' } },
      involvedSessionIds: [],
      executionActive: true,
      deliveryFloorEndsAt: '2099-01-01T01:00:00.000Z',
      lastDelivery: {
        scheduledAt: '2099-01-01T00:00:00.000Z',
        deliveredAt: '2099-01-01T00:00:01.000Z',
        messageId: 'message-9',
        targetSessionId: 'session-reserved',
      },
    }),
  ])
  const schedule = hostScheduleApi(proxy)

  const page = await schedule.list({ rpcId: 'r1', payload: { limit: 50, offset: 0 } })
  assert.equal(page.result?.ok, true)
  if (!page.result?.ok) return
  assert.deepEqual(calls[0], { operation: 'list', payload: { limit: 50, offset: 0 } })
  assert.equal(page.result.value.total, 2)
  assert.equal(page.result.value.shown, 2)
  const [first, second] = page.result.value.tasks
  assert.deepEqual(first!.timing, { kind: 'every', every_seconds: 3600 })
  assert.deepEqual(first!.target, { kind: 'session', sessionId: 'session-1' })
  assert.equal('involvedSessionIds' in first!, false, 'Bridge 不返回 Host 内部字段')
  assert.deepEqual(second!.timing, { kind: 'daily', daily: { time: '09:00:00.000', time_zone: 'Asia/Shanghai' } })
  assert.deepEqual(second!.target, { kind: 'new_once', sessionId: 'session-reserved', create: { cwd: '/tmp/project' } })
  assert.equal(second!.executionActive, true)
  assert.equal(second!.deliveryFloorEndsAt, '2099-01-01T01:00:00.000Z')
  assert.deepEqual(second!.lastDelivery, {
    scheduledAt: '2099-01-01T00:00:00.000Z',
    deliveredAt: '2099-01-01T00:00:01.000Z',
    messageId: 'message-9',
    targetSessionId: 'session-reserved',
  })

  // view：miss 是结果对象，不是抛错。
  const missing = await schedule.view({ rpcId: 'r2', payload: { id: 'nope' } })
  assert.deepEqual(missing.result, { ok: true, value: { kind: 'not-found', id: 'nope' } })
})

test('宿主级 facade 的 create/edit/run/limits/history 归一化结果与错误', async () => {
  const calls: HostCall[] = []
  const proxy = hostProxy(calls, [hostTask()])
  const schedule = hostScheduleApi(proxy)

  // create：请求按 Host 的 timing/target 形状转发，返回任务视图。
  const created = await schedule.create({
    rpcId: 'c1',
    payload: {
      title: '构建巡检',
      prompt: '检查构建状态',
      timing: { kind: 'after', after_seconds: 600 },
      target: { kind: 'session', sessionId: 'session-1' },
    },
  })
  assert.equal(created.result?.ok, true)
  if (created.result?.ok) {
    assert.deepEqual(calls.at(-1), {
      operation: 'create',
      payload: {
        title: '构建巡检',
        prompt: '检查构建状态',
        timing: { kind: 'after', after_seconds: 600 },
        target: { kind: 'session', sessionId: 'session-1' },
      },
    })
    assert.deepEqual(created.result.value.timing, { kind: 'after', after_seconds: 600 })
  }

  // 客户端把查看结果里的 target 原样回传（new_once 带 Host 预留的 sessionId）时，
  // 请求侧投影必须剥掉它，按 Host 的创建请求形状转发。
  const echoed = await schedule.create({
    rpcId: 'c2',
    payload: {
      title: '回环目标',
      prompt: '检查',
      timing: { kind: 'every', every_seconds: 600 },
      target: { kind: 'new_once', sessionId: 'session-reserved', create: { cwd: '/tmp' } } as never,
    },
  })
  assert.equal(echoed.result?.ok, true)
  assert.deepEqual(
    (calls.filter((call) => call.operation === 'create').at(-1)?.payload as Record<string, unknown>).target,
    { kind: 'new_once', create: { cwd: '/tmp' } },
    '请求侧 target 不带 new_once 的预留 sessionId',
  )

  // edit update：冲突、成功两条路。
  const conflict = await schedule.edit({
    rpcId: 'e1',
    payload: { id: 'schedule-host-1', action: 'update', patch: { active: false }, expectedUpdatedAt: '2000-01-01T00:00:00.000Z' },
  })
  assert.deepEqual(conflict.result, { ok: true, value: { kind: 'conflict', id: 'schedule-host-1' } })
  const updated = await schedule.edit({
    rpcId: 'e2',
    payload: { id: 'schedule-host-1', action: 'update', patch: { active: false }, expectedUpdatedAt: '2026-11-03T12:00:00.000Z' },
  })
  assert.equal(updated.result?.ok, true)
  if (updated.result?.ok && updated.result.value.kind === 'task') {
    assert.equal(updated.result.value.task.status, 'paused')
  } else {
    assert.fail('update must return a task outcome')
  }

  // edit delete。
  const deleted = await schedule.edit({ rpcId: 'e3', payload: { id: 'schedule-host-1', action: 'delete' } })
  assert.deepEqual(deleted.result, { ok: true, value: { kind: 'deleted', id: 'schedule-host-1' } })

  // run：进行中与目标已归档（RemoteError）两种失败。
  const pendingProxy = hostProxy([], [hostTask()], { runPending: true })
  const pending = await hostScheduleApi(pendingProxy).run({ rpcId: 'r', payload: { id: 'schedule-host-1' } })
  assert.deepEqual(pending.result, { ok: true, value: { kind: 'pending', id: 'schedule-host-1' } })
  const archivedProxy = hostProxy([], [hostTask()], { runArchived: true })
  const archived = await hostScheduleApi(archivedProxy).run({ rpcId: 'r', payload: { id: 'schedule-host-1' } })
  assert.equal(archived.result?.ok, false)
  if (archived.result && !archived.result.ok) assert.equal(archived.result.error.code, 'schedule/target-archived')

  // limits。
  const limits = await schedule.limits({ rpcId: 'l', payload: {} })
  assert.deepEqual(limits.result, { ok: true, value: { newSessionIntervalSeconds: 60 } })

  // history：游标 miss 抛成带 code 的错误，交给 Bridge 映射。
  const missingProxy = hostProxy([], [hostTask()], { historyMissing: true })
  const missing = await hostScheduleApi(missingProxy).history({ rpcId: 'h', payload: { id: 'schedule-host-1', limit: 10, before: 'message-x' } })
  assert.equal(missing.result?.ok, false)
  if (missing.result && !missing.result.ok) assert.equal(missing.result.error.code, 'delivery_cursor_not_found')
})

test('Bridge 新帧：列表/查看/创建/编辑/执行/上限与幂等、错误码映射', async () => {
  const calls: HostCall[] = []
  const proxy = hostProxy(calls, [hostTask()])
  const bridge = new HostBridge(proxy as ApiProxyLike)
  try {
    const listed = await bridge.listHostSchedules({ limit: 50, offset: 0 })
    assert.equal(listed.ok, true)
    if (listed.ok) {
      assert.equal(listed.value.total, 1)
      assert.equal(listed.value.tasks[0]!.id, 'schedule-host-1')
    }

    const viewed = await bridge.viewHostSchedule('schedule-host-1')
    assert.equal(viewed.ok, true)
    const missing = await bridge.viewHostSchedule('nope')
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.equal(missing.code, 'E_NOT_FOUND')

    const id = requestId()
    const createPayload = {
      clientRequestId: id,
      title: '构建巡检',
      prompt: '检查构建状态',
      timing: { kind: 'every', every_seconds: 3600 },
      target: { kind: 'session', sessionId: 'session-1' },
    }
    const first = await bridge.createHostSchedule('device-1', createPayload)
    const replay = await bridge.createHostSchedule('device-1', createPayload)
    assert.equal(first.ok, true)
    assert.equal(replay.ok, true)
    if (replay.ok) assert.equal(replay.replayed, true)
    assert.equal(calls.filter((call) => call.operation === 'create').length, 1, '同一 clientRequestId 只创建一次')
    const mismatch = await bridge.createHostSchedule('device-1', { ...createPayload, title: '另一个标题' })
    assert.equal(mismatch.ok, false)
    if (!mismatch.ok) assert.equal(mismatch.code, 'E_PROTOCOL')

    const updated = await bridge.editHostSchedule('device-1', {
      clientRequestId: requestId(),
      id: 'schedule-host-1',
      action: 'update',
      expectedUpdatedAt: '2026-11-03T12:00:00.000Z',
      patch: { active: false },
    })
    assert.equal(updated.ok, true)
    if (updated.ok && 'task' in updated.value) assert.equal(updated.value.task.status, 'paused')
    const conflict = await bridge.editHostSchedule('device-1', {
      clientRequestId: requestId(),
      id: 'schedule-host-1',
      action: 'update',
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      patch: { active: true },
    })
    assert.equal(conflict.ok, false)
    if (!conflict.ok) assert.equal(conflict.code, 'E_BUSY')
    const deleted = await bridge.editHostSchedule('device-1', {
      clientRequestId: requestId(),
      id: 'schedule-host-1',
      action: 'delete',
    })
    assert.equal(deleted.ok, true)
    if (deleted.ok) assert.deepEqual(deleted.value, { deleted: true, id: 'schedule-host-1' })

    const runPendingBridge = new HostBridge(hostProxy([], [hostTask()], { runPending: true }) as ApiProxyLike)
    try {
      const pending = await runPendingBridge.runHostSchedule('device-1', { clientRequestId: requestId(), id: 'schedule-host-1' })
      assert.equal(pending.ok, false)
      if (!pending.ok) assert.equal(pending.code, 'E_BUSY')
    } finally {
      runPendingBridge.dispose()
    }
    const runArchivedBridge = new HostBridge(hostProxy([], [hostTask()], { runArchived: true }) as ApiProxyLike)
    try {
      const archived = await runArchivedBridge.runHostSchedule('device-1', { clientRequestId: requestId(), id: 'schedule-host-1' })
      assert.equal(archived.ok, false)
      if (!archived.ok) assert.equal(archived.code, 'E_NOT_FOUND')
    } finally {
      runArchivedBridge.dispose()
    }
    const unknownBridge = new HostBridge(hostProxy([], [hostTask()], { unknownError: true }) as ApiProxyLike)
    try {
      const unknown = await unknownBridge.runHostSchedule('device-1', { clientRequestId: requestId(), id: 'schedule-host-1' })
      assert.equal(unknown.ok, false)
      if (!unknown.ok) assert.equal(unknown.code, 'E_INTERNAL')
    } finally {
      unknownBridge.dispose()
    }

    const limits = await bridge.scheduleLimits()
    assert.deepEqual(limits, { ok: true, value: { newSessionIntervalSeconds: 60 } })

    // 清理已结束任务：只删 ended，按 clientRequestId 幂等（重放不再删一次），成功与失败都广播 changed。
    const cleanupCalls: HostCall[] = []
    const cleanupBridge = new HostBridge(hostProxy(cleanupCalls, [
      hostTask({ id: 'ended-1', status: 'ended' }),
      hostTask({ id: 'ended-2', status: 'ended' }),
      hostTask({ id: 'paused-1', status: 'paused' }),
      hostTask({ id: 'active-1' }),
    ]) as ApiProxyLike)
    try {
      const cleanupId = requestId()
      const cleaned = await cleanupBridge.deleteEndedHostSchedules('device-1', { clientRequestId: cleanupId })
      assert.equal(cleaned.ok, true)
      if (cleaned.ok) {
        assert.equal(cleaned.value.deleted, 2)
        assert.notEqual(cleaned.replayed, true, '首次执行不是重放')
      }
      const replayed = await cleanupBridge.deleteEndedHostSchedules('device-1', { clientRequestId: cleanupId })
      assert.equal(replayed.ok, true)
      if (replayed.ok) {
        // journal 不落盘成功值：重放只标 replayed，不带条数。
        assert.equal(replayed.value.deleted, undefined)
        assert.equal(replayed.replayed, true)
      }
      assert.equal(cleanupCalls.filter((call) => call.operation === 'deleteInactive').length, 1, '重放不得再次调用上游')
      const again = await cleanupBridge.deleteEndedHostSchedules('device-1', { clientRequestId: requestId() })
      assert.equal(again.ok, true)
      if (again.ok) assert.equal(again.value.deleted, 0, '已结束任务清空后再清理删除 0 条')
    } finally {
      cleanupBridge.dispose()
    }
    const cleanupFailBridge = new HostBridge(hostProxy([], [hostTask()], { deleteEndedFails: true }) as ApiProxyLike)
    try {
      const failed = await cleanupFailBridge.deleteEndedHostSchedules('device-1', { clientRequestId: requestId() })
      assert.equal(failed.ok, false)
      if (!failed.ok) assert.equal(failed.code, 'E_INTERNAL')
    } finally {
      cleanupFailBridge.dispose()
    }

    // Host 写入前校验失败（RemoteError schedule/input-invalid）-> E_PROTOCOL。
    const invalidBridge = new HostBridge(hostProxy([], [hostTask()], { createInvalid: true }) as ApiProxyLike)
    try {
      const invalid = await invalidBridge.createHostSchedule('device-1', {
        clientRequestId: requestId(),
        title: '构建巡检',
        prompt: '检查构建状态',
        timing: { kind: 'every', every_seconds: 3600 },
      })
      assert.equal(invalid.ok, false)
      if (!invalid.ok) assert.equal(invalid.code, 'E_PROTOCOL')
    } finally {
      invalidBridge.dispose()
    }
  } finally {
    bridge.dispose()
  }
})

test('旧帧在宿主级模型上的映射：列表过滤/排序、创建、更新冲突、删除、历史忽略会话', async () => {
  const calls: HostCall[] = []
  const proxy = hostProxy(calls, [
    hostTask({ id: 'task-late', scheduledAt: '2099-02-01T00:00:00.000Z' }),
    hostTask({ id: 'task-early', scheduledAt: '2099-01-01T00:00:00.000Z' }),
    hostTask({ id: 'task-ended', status: 'ended' }),
    hostTask({ id: 'task-other-session', target: { kind: 'session', sessionId: 'session-2' } }),
    hostTask({ id: 'task-new-once', target: { kind: 'new_once', sessionId: 'session-1', create: {} } }),
    hostTask({ id: 'task-rrule', kind: 'rrule', rrule: 'DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY' }),
  ])
  const bridge = new HostBridge(proxy as ApiProxyLike)
  try {
    const list = await bridge.listSchedules('session-1')
    assert.equal(list.ok, true)
    if (list.ok) {
      assert.deepEqual(list.value.map((task) => task.id), ['task-early', 'task-late'], '只保留本会话 session 目标且按 scheduledAt 升序')
      assert.equal(list.value[0]!.kind, 'every')
      assert.equal(list.value[0]!.everySeconds, 3600)
      assert.equal(list.value[0]!.deliveryMode, 'host')
      assert.equal(list.value[0]!.state, 'scheduled')
    }

    // 创建：选择器 -> timing，target 固定为请求会话。
    const created = await bridge.createSchedule('device-1', {
      clientRequestId: requestId(),
      sessionId: 'session-1',
      title: '构建巡检',
      prompt: '检查构建状态',
      after_seconds: 600,
    })
    assert.equal(created.ok, true)
    if (created.ok) {
      assert.equal(created.value.kind, 'after')
      assert.equal(created.value.afterSeconds, 600)
    }
    const createCall = calls.filter((call) => call.operation === 'create').at(-1)
    assert.deepEqual(createCall?.payload, {
      title: '构建巡检',
      prompt: '检查构建状态',
      timing: { kind: 'after', after_seconds: 600 },
      target: { kind: 'session', sessionId: 'session-1' },
    })

    // 更新：expected 与当前旧投影一致才写；不一致回 E_BUSY。
    const current = await bridge.listSchedules('session-1')
    assert.equal(current.ok, true)
    if (!current.ok) return
    const expected = current.value[0]!
    const updated = await bridge.updateSchedule('device-1', {
      clientRequestId: requestId(),
      sessionId: 'session-1',
      id: expected.id,
      expected,
      title: '改名',
    })
    assert.equal(updated.ok, true)
    if (updated.ok) assert.equal(updated.value.title, '改名')
    const updateCall = calls.filter((call) => call.operation === 'edit').at(-1)
    assert.deepEqual((updateCall?.payload as Record<string, unknown>).patch, { title: '改名' })

    const stale = await bridge.updateSchedule('device-1', {
      clientRequestId: requestId(),
      sessionId: 'session-1',
      id: expected.id,
      expected: { ...expected, title: '已过期' },
      title: '再改',
    })
    assert.equal(stale.ok, false)
    if (!stale.ok) assert.equal(stale.code, 'E_BUSY')

    // 删除走 edit({action:"delete"})。
    const deleted = await bridge.deleteSchedule('device-1', {
      clientRequestId: requestId(),
      sessionId: 'session-1',
      id: 'task-early',
    })
    assert.equal(deleted.ok, true)
    const deleteCall = calls.filter((call) => call.operation === 'edit').at(-1)
    assert.deepEqual(deleteCall?.payload, { id: 'task-early', action: 'delete' })

    // 历史忽略 sessionId。
    const history = await bridge.scheduleHistory('session-1', 'task-late', 10)
    assert.equal(history.ok, true)
    const historyCall = calls.filter((call) => call.operation === 'history').at(-1)
    assert.deepEqual(historyCall?.payload, { id: 'task-late', limit: 10 })
  } finally {
    bridge.dispose()
  }
})

test('宿主级帧的 validate/handle 与能力门', async () => {
  const id = requestId()
  const row = (type: string) => registryRowFor(type)!
  assert.equal(reason(row('c2s.schedule.host.list'), { active: true, limit: 500, offset: 0 }), undefined)
  assert.equal(reason(row('c2s.schedule.host.list'), { limit: 0 }), 'invalid schedule host list')
  assert.equal(reason(row('c2s.schedule.host.view'), { id: 'i' }), undefined)
  assert.equal(reason(row('c2s.schedule.host.view'), {}), 'invalid schedule id')
  assert.equal(reason(row('c2s.schedule.host.create'), {
    clientRequestId: id, title: 't', prompt: 'p', timing: { kind: 'rrule', rrule: 'DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY' },
  }), undefined)
  assert.equal(reason(row('c2s.schedule.host.create'), {
    clientRequestId: id, title: 't', prompt: 'p', timing: { kind: 'every', every_seconds: 0 },
  }), 'invalid schedule host create fields')
  assert.equal(reason(row('c2s.schedule.host.edit'), { clientRequestId: id, id: 'i', action: 'delete' }), undefined)
  assert.equal(reason(row('c2s.schedule.host.edit'), { clientRequestId: id, id: 'i', action: 'update', patch: {} }), 'invalid schedule host edit patch')
  assert.equal(reason(row('c2s.schedule.host.run'), { clientRequestId: id, id: 'i' }), undefined)
  assert.equal(reason(row('c2s.schedule.host.limits'), {}), undefined)
  assert.equal(reason(row('c2s.schedule.host.deleteEnded'), { clientRequestId: id }), undefined)
  assert.equal(reason(row('c2s.schedule.host.deleteEnded'), {}), 'invalid schedule host delete ended fields')
  assert.deepEqual(capabilityRejection(row('c2s.schedule.host.deleteEnded'), { historyPaging: true } as never), {
    code: 'E_UNSUPPORTED', message: 'capability unavailable on this host version',
  })

  // 能力门：schedulesHost=false 时新帧一律 E_UNSUPPORTED。
  assert.deepEqual(capabilityRejection(row('c2s.schedule.host.list'), { historyPaging: true } as never), {
    code: 'E_UNSUPPORTED', message: 'capability unavailable on this host version',
  })
  assert.equal(capabilityRejection(row('c2s.schedule.host.list'), { historyPaging: true, schedulesHost: true } as never), undefined)

  // handler：每个新帧发出的 s2c 类型与载荷。
  const sent: Array<{ type: string; payload: any }> = []
  const failures: Array<{ code: string; message: string }> = []
  const calls: HostCall[] = []
  const proxy = hostProxy(calls, [hostTask()])
  const bridge = new HostBridge(proxy as ApiProxyLike)
  const ctx = {
    bridge,
    deviceId: 'device-1',
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
    fail: (code: string, message: string) => failures.push({ code, message }),
  } as never
  try {
    await row('c2s.schedule.host.list').handle(ctx, { limit: 50, offset: 0 })
    assert.equal(sent.at(-1)?.type, 's2c.schedule.host.snapshot')
    assert.equal(sent.at(-1)?.payload.tasks[0].id, 'schedule-host-1')

    await row('c2s.schedule.host.view').handle(ctx, { id: 'schedule-host-1' })
    assert.equal(sent.at(-1)?.type, 's2c.schedule.host.task')
    await row('c2s.schedule.host.view').handle(ctx, { id: 'nope' })
    assert.deepEqual(failures.at(-1), { code: 'E_NOT_FOUND', message: 'schedule not found' })

    const createId = requestId()
    await row('c2s.schedule.host.create').handle(ctx, {
      clientRequestId: createId,
      title: '构建巡检',
      prompt: '检查构建状态',
      timing: { kind: 'every', every_seconds: 3600 },
    })
    assert.equal(sent.at(-1)?.type, 's2c.schedule.updated')
    assert.equal(sent.at(-1)?.payload.clientRequestId, createId)
    assert.equal('sessionId' in sent.at(-1)!.payload, false, '宿主级回执不带 sessionId')
    assert.equal(sent.at(-1)?.payload.task.id !== undefined, true)

    await row('c2s.schedule.host.edit').handle(ctx, {
      clientRequestId: requestId(), id: 'schedule-host-1', action: 'update', patch: { title: '改名' },
    })
    assert.equal(sent.at(-1)?.type, 's2c.schedule.updated')
    assert.equal(sent.at(-1)?.payload.task.title, '改名')
    await row('c2s.schedule.host.edit').handle(ctx, {
      clientRequestId: requestId(), id: 'schedule-host-1', action: 'delete',
    })
    assert.equal(sent.at(-1)?.payload.deleted, true)
    await row('c2s.schedule.host.edit').handle(ctx, {
      clientRequestId: requestId(), id: 'schedule-host-1', action: 'update', patch: { active: true },
    })
    assert.deepEqual(failures.at(-1), { code: 'E_NOT_FOUND', message: 'schedule not found' })

    await row('c2s.schedule.host.run').handle(ctx, { clientRequestId: requestId(), id: 'schedule-host-1' })
    assert.deepEqual(failures.at(-1), { code: 'E_NOT_FOUND', message: 'schedule not found' })

    await row('c2s.schedule.host.limits').handle(ctx, {})
    assert.deepEqual(sent.at(-1), { type: 's2c.schedule.host.limits', payload: { newSessionIntervalSeconds: 60 } })

    const cleanupId = requestId()
    await row('c2s.schedule.host.deleteEnded').handle(ctx, { clientRequestId: cleanupId })
    assert.deepEqual(sent.at(-1), { type: 's2c.schedule.updated', payload: { clientRequestId: cleanupId, deletedEnded: 0 } })
    await row('c2s.schedule.host.deleteEnded').handle(ctx, { clientRequestId: cleanupId })
    assert.deepEqual(sent.at(-1), { type: 's2c.schedule.updated', payload: { clientRequestId: cleanupId, replayed: true } },
      '重放不再调用上游，条数未知时省略 deletedEnded')
  } finally {
    bridge.dispose()
  }
})

test('投递历史：宿主级模型下 sessionId 可选，会话级宿主仍要求会话边界', async () => {
  const row = registryRowFor('c2s.schedule.history')!
  const hostCalls: HostCall[] = []
  const hostBridge = new HostBridge(hostProxy(hostCalls, [hostTask()]) as ApiProxyLike)
  const hostSent: Array<{ type: string; payload: any }> = []
  const hostCtx = {
    bridge: hostBridge,
    deviceId: 'device-1',
    send: (type: string, payload: unknown) => hostSent.push({ type, payload }),
    fail: (code: string) => assert.fail('host history must not fail: ' + code),
  } as never
  try {
    assert.equal(reason(row, { id: 'schedule-host-1', limit: 10 }), undefined)
    await row.handle(hostCtx, { id: 'schedule-host-1', limit: 10 })
    assert.equal(hostSent.at(-1)?.type, 's2c.schedule.history')
    assert.equal('sessionId' in hostSent.at(-1)!.payload, false, '未提供 sessionId 时不回填')
    assert.deepEqual(hostCalls.filter((call) => call.operation === 'history').at(-1)?.payload, {
      id: 'schedule-host-1',
      limit: 10,
    })
  } finally {
    hostBridge.dispose()
  }

  const legacy = new DshApiProxy({
    get: (key: string) => key === 'sessionController' ? {} : key === 'schedule' ? scheduleController([]) : undefined,
  } as never)
  const legacyBridge = new HostBridge(legacy as ApiProxyLike)
  const failures: Array<{ code: string; message: string }> = []
  const legacyCtx = {
    bridge: legacyBridge,
    deviceId: 'device-1',
    send: () => assert.fail('legacy history without sessionId must fail before the handler'),
    fail: (code: string, message: string) => failures.push({ code, message }),
  } as never
  try {
    await row.handle(legacyCtx, { id: 'schedule-1', limit: 10 })
    assert.deepEqual(failures, [{ code: 'E_PROTOCOL', message: 'invalid schedule history' }])
  } finally {
    legacyBridge.dispose()
  }
})

test('宿主级 timing 反向投影：at/weekly/cron 进旧视图，rrule 无法投影被跳过', async () => {
  const seeds = [
    hostTask({ id: 't-at', kind: 'at', everySeconds: undefined, scheduledAt: '2030-01-01T00:00:00.000Z' }),
    hostTask({ id: 't-past', kind: 'at', everySeconds: undefined, scheduledAt: '2020-01-01T00:00:00.000Z' }),
    hostTask({
      id: 't-weekly',
      kind: 'weekly',
      everySeconds: undefined,
      time: '09:00:00.000',
      timeZone: 'Asia/Shanghai',
      weekdays: [1, 3],
      scheduledAt: '2030-01-06T01:00:00.000Z',
    }),
    hostTask({
      id: 't-cron',
      kind: 'cron',
      everySeconds: undefined,
      expression: '0 9 * * 1-5',
      timeZone: 'UTC',
      scheduledAt: '2030-01-07T09:00:00.000Z',
    }),
    hostTask({
      id: 't-rrule',
      kind: 'rrule',
      everySeconds: undefined,
      rrule: 'DTSTART:20260101T000000Z\nRRULE:FREQ=WEEKLY',
      scheduledAt: '2030-01-01T00:00:00.000Z',
    }),
  ]
  const proxy = hostProxy([], seeds)
  const schedule = hostScheduleApi(proxy)
  const page = await schedule.list({ rpcId: 'l', payload: {} })
  assert.equal(page.result?.ok, true)
  if (!page.result?.ok) return
  const byId = new Map(page.result.value.tasks.map((task) => [task.id, task]))
  assert.deepEqual(byId.get('t-at')!.timing, { kind: 'at', at: '2030-01-01T00:00:00.000Z' })
  assert.deepEqual(byId.get('t-weekly')!.timing, {
    kind: 'weekly',
    weekly: { time: '09:00:00.000', time_zone: 'Asia/Shanghai', weekdays: [1, 3] },
  })
  assert.deepEqual(byId.get('t-cron')!.timing, {
    kind: 'cron',
    cron: { expression: '0 9 * * 1-5', time_zone: 'UTC' },
  })
  assert.deepEqual(byId.get('t-rrule')!.timing, {
    kind: 'rrule',
    rrule: 'DTSTART:20260101T000000Z\nRRULE:FREQ=WEEKLY',
  })

  const bridge = new HostBridge(proxy as ApiProxyLike)
  try {
    const legacy = await bridge.listSchedules('session-1')
    assert.equal(legacy.ok, true)
    if (legacy.ok) {
      assert.deepEqual(legacy.value.map((task) => task.id), ['t-past', 't-at', 't-weekly', 't-cron'], '按 scheduledAt 升序且跳过 rrule')
      const views = new Map(legacy.value.map((task) => [task.id, task]))
      assert.deepEqual(views.get('t-weekly'), {
        id: 't-weekly',
        kind: 'weekly',
        title: '巡检',
        prompt: '巡检状态',
        scheduledAt: '2030-01-06T01:00:00.000Z',
        state: 'scheduled',
        deliveryMode: 'host',
        time: '09:00:00.000',
        timeZone: 'Asia/Shanghai',
        weekdays: [1, 3],
      })
      assert.equal(views.get('t-cron')!.expression, '0 9 * * 1-5')
      assert.equal(views.get('t-at')!.kind, 'at')
      assert.equal(views.get('t-at')!.state, 'scheduled')
      assert.equal(views.get('t-past')!.state, 'overdue', 'state 只由 scheduledAt 是否已过推导')
    }
  } finally {
    bridge.dispose()
  }
})
