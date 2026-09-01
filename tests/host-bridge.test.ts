import { test } from 'node:test'
import assert from 'node:assert'
import {
  HostBridge,
  MAX_MESSAGE_PROJECTION_BYTES,
  MAX_SESSION_PAGE_MESSAGES_BYTES,
  limitMessageProjection,
  limitSessionPageMessages,
  projectHistory,
  projectEvent,
  unwrapStreamItem,
} from '../src/host-bridge.ts'
import type { ApiProxyLike, BridgeSink, MuxFrameLike } from '../src/host-bridge.ts'

function makeFakeProxy() {
  let pushFrame: ((frame: MuxFrameLike) => void) | undefined
  const respondCalls: any[] = []
  const proxy: ApiProxyLike = {
    sessions: {
      list: async () => ({ result: { ok: true, value: { items: [] } } }),
      history: async () => ({ result: { ok: true, value: { events: [], hasMore: false } } }),
      prompt: async () => ({ result: { ok: true, value: { accepted: true } } }),
      create: async (req) => ({ result: { ok: true, value: { sessionId: 'session-new-1', agentPreset: 'standard' } } }),
      models: async () => ({ result: { ok: true, value: {
        current: { provider: 'deepseek', model: 'deepseek-chat' },
        routable: true,
        groups: [{
          id: 'deepseek',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        }],
        failures: [],
      } } }),
      selectModel: async (req) => ({ result: { ok: true, value: { selected: {
        provider: req.payload?.provider ?? '',
        model: req.payload?.model ?? '',
        ...(req.payload?.reasoningEffort ? { reasoningEffort: req.payload.reasoningEffort } : {}),
      } } } }),
    },
    respond: async (message) => {
      respondCalls.push(message)
      return { accepted: true }
    },
    events: {
      mux: async function* (req, signal) {
        // Match the real apiProxy mux contract: rpcId is on the outer
        // server-request envelope and the mux frame itself is in payload.
        const queue: Array<{ rpcId?: string; payload: MuxFrameLike }> = []
        ;(proxy as any)._push = (frame: MuxFrameLike) => {
          const { rpcId, ...payload } = frame
          queue.push({ ...(rpcId ? { rpcId } : {}), payload: payload as MuxFrameLike })
        }
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5))
            continue
          }
          yield queue.shift()!
        }
      },
      host: async function* () {},
    },
  }
  return { proxy, respondCalls, getPush: () => (proxy as any)._push as (f: MuxFrameLike) => void }
}

function makeSinkInto(store: Array<{ type: string; payload: any }>): BridgeSink {
  return {
    push: (type, payload) => store.push({ type, payload }),
    lastCursor: () => 0,
    replay: () => {},
    replayDone: () => {},
    resync: () => {},
  }
}

function makeSink(collected: Array<{ type: string; payload: any }>): BridgeSink {
  return {
    push: (type, payload) => collected.push({ type, payload }),
    lastCursor: () => 0,
    replay: () => {},
    replayDone: () => {},
    resync: () => {},
  }
}

test('outer stream rpcId wins when nested payload also carries an id', () => {
  const frame = unwrapStreamItem({
    rpcId: 'outer-request-id',
    payload: { type: 'approval/requested', rpcId: 'nested-id', sessionId: 's1' },
  })
  assert.equal(frame.rpcId, 'outer-request-id')
})

test('message projections are truncated by serialized UTF-8 size', () => {
  const projected = limitMessageProjection({
    seq: 1,
    role: 'assistant',
    text: '深'.repeat(MAX_MESSAGE_PROJECTION_BYTES),
    thinking: '考'.repeat(MAX_MESSAGE_PROJECTION_BYTES),
    ts: 1,
  })
  assert.equal(projected.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(projected), 'utf8') <= MAX_MESSAGE_PROJECTION_BYTES)
  assert.doesNotMatch(projected.text ?? '', /[\uD800-\uDBFF]$/)
})

test('session pages stay below the aggregate frame budget without creating a history gap', () => {
  const projected = Array.from({ length: 8 }, (_, index) => limitMessageProjection({
    seq: index + 1,
    role: 'assistant',
    text: String(index + 1) + ':' + 'x'.repeat(180_000),
    ts: index + 1,
  }))

  const page = limitSessionPageMessages(projected)

  assert.ok(page.dropped > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(page.messages), 'utf8') <= MAX_SESSION_PAGE_MESSAGES_BYTES)
  assert.equal(page.messages.at(-1)?.seq, 8, 'the newest boundary row must stay in this page')
  assert.equal(page.messages[0]!.seq, page.dropped + 1, 'the next beforeSeq request must recover every dropped prefix row')
})

test('session pages collapse duplicate host sequences before sending', () => {
  const page = limitSessionPageMessages([
    { seq: 1, role: 'assistant', text: 'stale duplicate', ts: 1 },
    { seq: 1, role: 'system', text: 'canonical duplicate', ts: 2 },
    { seq: 2, role: 'assistant', text: 'next', ts: 3 },
  ])

  assert.deepEqual(page.messages.map((message) => message.seq), [1, 2])
  assert.equal(page.messages[0]!.text, 'canonical duplicate')
  assert.equal(page.dropped, 0, 'duplicate removal is normalization, not frame truncation')
})

test('history pages enforce the exclusive beforeSeq boundary', async () => {
  const { proxy } = makeFakeProxy()
  proxy.sessions.history = async () => ({ result: { ok: true as const, value: {
    events: [
      { event: { type: 'assistant/message', seq: 9, time: 1, data: 'older' } },
      { event: { type: 'assistant/message', seq: 10, time: 2, data: 'boundary' } },
      { event: { type: 'assistant/message', seq: 11, time: 3, data: 'newer' } },
    ],
    hasMore: true,
  } } })
  const bridge = new HostBridge(proxy, 100)

  const page = await bridge.historyPage('s1', 10, 100)

  assert.deepEqual(page?.messages.map((message) => message.seq), [9])
  bridge.dispose()
})

test('history pages stop when boundary filtering leaves no older sequence', async () => {
  const { proxy } = makeFakeProxy()
  proxy.sessions.history = async () => ({ result: { ok: true as const, value: {
    events: [
      { event: { type: 'assistant/message', seq: 10, time: 1, data: 'boundary' } },
      { event: { type: 'assistant/message', seq: 11, time: 2, data: 'newer' } },
    ],
    hasMore: true,
  } } })
  const bridge = new HostBridge(proxy, 100)

  const page = await bridge.historyPage('s1', 10, 100)

  assert.deepEqual(page?.messages, [])
  assert.equal(page?.hasMore, false)
  bridge.dispose()
})

test('HostBridge.start is idempotent', async () => {
  let muxStarts = 0
  let hostStarts = 0
  const { proxy } = makeFakeProxy()
  proxy.events.mux = async function* (_req, signal) {
    muxStarts += 1
    while (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  proxy.events.host = async function* () { hostStarts += 1 }
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  bridge.start()
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(muxStarts, 1)
  assert.equal(hostStarts, 1)
  bridge.dispose()
})

test('approval requested -> pending push -> respond allow', async () => {
  const { proxy, respondCalls, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  const collected: Array<{ type: string; payload: any }> = []
  bridge.start()
  bridge.addSink(makeSink(collected))
  getPush()({
    type: 'approval/requested',
    rpcId: 'rpc-1',
    sessionId: 'session-a',
    approvalId: 'apr-1',
    toolName: 'bash',
    reason: 'escalate sandbox',
  })
  await new Promise((r) => setTimeout(r, 20))
  const push = collected.find((x) => x.type === 's2c.pending.approval')
  assert.ok(push, 'pending.approval push missing')
  assert.equal(push.payload.requestId, 'apr-1')
  assert.equal(push.payload.riskLevel, 'write')

  const ok = await bridge.respondApproval('apr-1', 'allow')
  assert.equal(ok.ok, true)
  assert.equal(respondCalls.length, 1)
  assert.equal(respondCalls[0].rpcId, 'rpc-1')
  assert.deepEqual(respondCalls[0].result.value, {
    sessionId: 'session-a',
    approvalId: 'apr-1',
    outcome: 'allowed-once',
  })
  bridge.dispose()
})

test('question requested -> pending push -> respond answers', async () => {
  const { proxy, respondCalls, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  const collected: Array<{ type: string; payload: any }> = []
  bridge.start()
  bridge.addSink(makeSink(collected))
  getPush()({
    type: 'question/requested',
    rpcId: 'rq-9',
    sessionId: 'session-b',
    questions: [{ id: 'q1', question: 'A or B', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))
  const push = collected.find((g) => g.type === 's2c.pending.question')
  assert.ok(push, 'pending.question push missing')

  const ok = await bridge.respondQuestion('q-rq-9', [{ id: 'q1', selected: ['A'], custom: '' }])
  assert.equal(ok.ok, true, 'an option-only answer with empty custom must be accepted')
  assert.equal(respondCalls.length, 1)
  assert.equal(respondCalls[0].rpcId, 'rq-9')
  // Empty `custom` is dropped before the host sees it: the host rejects
  // present-but-empty values, which used to fail every option-only answer.
  assert.deepEqual(respondCalls[0].result.value.answer.answers, [{ id: 'q1', selected: ['A'] }])
  bridge.dispose()
})

test('question answers are normalized to exactly what the host accepts', async () => {
  const { proxy, respondCalls, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'question/requested',
    rpcId: 'rq-norm',
    sessionId: 'session-c',
    questions: [
      { id: 'single', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'multi', question: 'Pick many', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
      { id: 'free', question: 'Describe' },
    ],
  })
  await new Promise((r) => setTimeout(r, 20))

  const outcome = await bridge.respondQuestion('q-rq-norm', [
    { id: 'single', selected: ['A'], custom: '' }, // lenient phone shape
    { id: 'multi', selected: ['Y', 'X', 'X'] }, // duplicate label
    { id: 'free', selected: [], custom: '  spaced but real  ' },
  ])
  assert.equal(outcome.ok, true)
  assert.deepEqual(respondCalls[respondCalls.length - 1].result.value.answer.answers, [
    { id: 'single', selected: ['A'] },
    { id: 'multi', selected: ['Y', 'X'] },
    { id: 'free', selected: [], custom: '  spaced but real  ' },
  ])
  bridge.dispose()
})

test('single-select answers mixing selection and custom keep only the selection', async () => {
  const { proxy, respondCalls, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'question/requested', rpcId: 'rq-mix', sessionId: 'session-c',
    questions: [{ id: 'q1', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))

  const outcome = await bridge.respondQuestion('q-rq-mix', [
    { id: 'q1', selected: ['A'], custom: 'actually B' },
  ])
  assert.equal(outcome.ok, true)
  assert.deepEqual(respondCalls[respondCalls.length - 1].result.value.answer.answers, [
    { id: 'q1', selected: ['A'] },
  ])
  bridge.dispose()
})

test('host answer rejection reports bad-response and restores the pending entry for retry', async () => {
  const { proxy, getPush } = makeFakeProxy()
  proxy.respond = async () => ({ accepted: false, reason: 'bad-response' })
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'question/requested', rpcId: 'rq-br', sessionId: 'session-c',
    questions: [{ id: 'q1', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))

  // Label "Z" was never offered — the host rejects the whole batch.
  const rejected = await bridge.respondQuestion('q-rq-br', [{ id: 'q1', selected: ['Z'] }])
  assert.deepEqual(rejected, { ok: false, reason: 'bad-response' })

  proxy.respond = async () => ({ accepted: true })
  const retried = await bridge.respondQuestion('q-rq-br', [{ id: 'q1', selected: ['A'] }])
  assert.equal(retried.ok, true, 'pending was restored for retry after rejection')
  bridge.dispose()
})

test('answering the last pending approval clears the summary badge immediately', async () => {
  const { proxy, getPush } = makeFakeProxy()
  proxy.sessions.list = async () => ({ result: { ok: true, value: { items: [
    { sessionId: 'session-badge', updatedAt: 100, running: false, blank: false },
  ] } } })
  const bridge = new HostBridge(proxy, 100)
  const collected: Array<{ type: string; payload: any }> = []
  bridge.start()
  bridge.addSink(makeSink(collected))
  await bridge.refreshSummaries()

  getPush()({
    type: 'approval/requested', rpcId: 'rpc-badge', sessionId: 'session-badge',
    approvalId: 'apr-badge', toolName: 'bash', reason: 'escalate sandbox',
  })
  await new Promise((r) => setTimeout(r, 20))
  const flagged = collected.filter((f) => f.type === 's2c.sessions.delta').at(-1)
  assert.equal(flagged?.payload.upserted?.[0]?.pendingApproval, true)

  const answered = await bridge.respondApproval('apr-badge', 'allow')
  assert.equal(answered.ok, true)
  const cleared = collected.filter((f) => f.type === 's2c.sessions.delta').at(-1)
  assert.equal(
    cleared?.payload.upserted?.[0]?.pendingApproval,
    false,
    'the badge must clear as soon as the answer is accepted, not on the next unrelated refresh',
  )

  // The later resolved frame finds nothing left to bump — it must not throw.
  getPush()({ type: 'approval/resolved', approvalId: 'apr-badge' })
  await new Promise((r) => setTimeout(r, 20))
  bridge.dispose()
})

test('a not-pending receipt leaves no ghost entry behind', async () => {
  const { proxy, getPush } = makeFakeProxy()
  // The host reports the request as already settled (e.g. resolved while the
  // answer was in flight): restoring would strand an unanswerable entry.
  proxy.respond = async () => ({ accepted: false, reason: 'not-pending' })
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'approval/requested', rpcId: 'rpc-ghost', sessionId: 'session-g',
    approvalId: 'apr-ghost', toolName: 'bash', reason: 'y',
  })
  getPush()({
    type: 'question/requested', rpcId: 'rq-ghost', sessionId: 'session-g',
    questions: [{ id: 'q1', question: '?', options: [] }],
  })
  await new Promise((r) => setTimeout(r, 20))

  assert.deepEqual(await bridge.respondApproval('apr-ghost', 'deny'), { ok: false, reason: 'not-pending' })
  assert.deepEqual(await bridge.respondQuestion('q-rq-ghost', [{ id: 'q1', selected: [] }]), { ok: false, reason: 'not-pending' })

  assert.equal(bridge.pendingSnapshot().approvals.length, 0, 'no ghost approval may stay answerable')
  assert.equal(bridge.pendingSnapshot().questions.length, 0, 'no ghost question may stay answerable')

  const retried = await bridge.respondApproval('apr-ghost', 'allow')
  assert.deepEqual(retried, { ok: false, reason: 'not-pending' }, 'retry reads as gone instead of looping on a stranded entry')
  bridge.dispose()
})

test('deny carries the optional user reason through to the host', async () => {
  const { proxy, respondCalls, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'approval/requested', rpcId: 'rpc-deny', sessionId: 'session-d',
    approvalId: 'apr-deny', toolName: 'bash', reason: 'x',
  })
  await new Promise((r) => setTimeout(r, 20))
  const outcome = await bridge.respondApproval('apr-deny', 'deny', '这个命令会删数据，先不要跑')
  assert.equal(outcome.ok, true)
  assert.deepEqual(respondCalls[respondCalls.length - 1].result.value, {
    sessionId: 'session-d',
    approvalId: 'apr-deny',
    outcome: 'rejected',
    reason: '这个命令会删数据，先不要跑',
  })

  // Blank reasons are dropped rather than sent as empty strings.
  getPush()({
    type: 'approval/requested', rpcId: 'rpc-deny2', sessionId: 'session-d',
    approvalId: 'apr-deny2', toolName: 'bash', reason: 'y',
  })
  await new Promise((r) => setTimeout(r, 20))
  await bridge.respondApproval('apr-deny2', 'deny', '   ')
  assert.equal('reason' in respondCalls[respondCalls.length - 1].result.value, false)
  bridge.dispose()
})

test('replay buffers frames and honors cursor gaps', async () => {
  const { proxy } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  const received: number[] = []
  const sink: BridgeSink = {
    push: (_t, _p, seq) => { if (seq !== undefined) received.push(seq) },
    lastCursor: () => 0,
    replay: (entries) => { for (const e of entries) received.push(e.seq) },
    replayDone: () => {},
    resync: () => {},
  }
  ;(bridge as any).record('s2c.sessions.delta', { upserted: [], removedIds: [] })
  ;(bridge as any).record('s2c.sessions.delta', { upserted: [], removedIds: [] })
  bridge.dispose()
})

test('createSession forwards a selected workspace and refreshes mirror', async () => {
  const { proxy } = makeFakeProxy()
  let createPayload: any
  proxy.sessions.create = async (request) => {
    createPayload = request.payload
    return { result: { ok: true, value: { sessionId: 'session-new-1' } } }
  }
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  const id = await bridge.createSession({ workspaceId: 'workspace-1' })
  assert.equal(id, 'session-new-1')
  assert.deepEqual(createPayload, { workspaceId: 'workspace-1' })
  const failed = await (() => { return null })()
  assert.equal(failed, null)
  bridge.dispose()
})

test('workspace and directory operations use the host apiProxy contracts', async () => {
  const { proxy } = makeFakeProxy()
  let workspaceCreatePayload: any
  let listedPath: string | undefined
  proxy.workspace = {
    list: async () => ({ result: { ok: true, value: {
      items: [{
        workspaceId: 'workspace-1',
        title: 'deeppilot-demo',
        path: '/Users/sea/deeppilot-demo',
        sessionIds: ['session-a'],
      }],
      archivedSessionIds: [],
    } } }),
    create: async (request) => {
      workspaceCreatePayload = request.payload
      return { result: { ok: true, value: {
        workspace: {
          workspaceId: 'workspace-2',
          title: 'new-project',
          path: request.payload?.path ?? '',
          sessionIds: [],
        },
        created: true,
      } } }
    },
  }
  proxy.host = {
    listDirectory: async (request) => {
      listedPath = request.payload?.path
      return { result: { ok: true, value: {
        path: listedPath ?? '/Users/sea',
        home: '/Users/sea',
        crumbs: [{ name: 'sea', path: '/Users/sea', hidden: false }],
        entries: [{ name: 'deeppilot-demo', path: '/Users/sea/deeppilot-demo', hidden: false }],
        truncated: false,
      } } }
    },
    pickDirectory: async () => ({ result: { ok: true, value: { path: '/Users/sea/new-project' } } }),
  }

  const bridge = new HostBridge(proxy, 100)
  assert.equal(bridge.capabilities.projectSelection, true)

  const workspaces = await bridge.listWorkspaces()
  assert.equal(workspaces.ok, true)
  if (workspaces.ok) assert.equal(workspaces.value[0]?.id, 'workspace-1')

  const listing = await bridge.listDirectory('/Users/sea')
  assert.equal(listing.ok, true)
  assert.equal(listedPath, '/Users/sea')

  const picked = await bridge.pickDirectory()
  assert.deepEqual(picked, { ok: true, value: '/Users/sea/new-project' })

  const created = await bridge.createWorkspace('/Users/sea/new-project')
  assert.equal(created.ok, true)
  assert.deepEqual(workspaceCreatePayload, { path: '/Users/sea/new-project' })
  bridge.dispose()
})

test('session model catalog and selection use host apiProxy', async () => {
  const { proxy } = makeFakeProxy()
  let selectionRequest: any
  proxy.sessions.selectModel = async (request) => {
    selectionRequest = request
    return { result: { ok: true, value: { selected: {
      provider: request.payload?.provider ?? '',
      model: request.payload?.model ?? '',
      reasoningEffort: request.payload?.reasoningEffort,
    } } } }
  }
  const bridge = new HostBridge(proxy, 100)
  assert.equal(bridge.capabilities.models, true)

  const catalog = await bridge.sessionModels('session-models')
  assert.equal(catalog.ok, true)
  if (catalog.ok) {
    assert.equal(catalog.value.current.model, 'deepseek-chat')
    assert.equal(catalog.value.groups[0]?.models[0]?.name, 'DeepSeek Chat')
  }

  const selected = await bridge.selectSessionModel('session-models', {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
  assert.equal(selected.ok, true)
  assert.deepEqual(selectionRequest.payload, {
    sessionId: 'session-models',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
})

test('session management renames, archives, and hides archived rows', async () => {
  const { proxy } = makeFakeProxy()
  let archivedSessionIds: string[] = ['session-old']
  let renamedPayload: any
  let archivedPayload: any
  proxy.sessions.list = async () => ({ result: { ok: true, value: { items: [
    { sessionId: 'session-new', updatedAt: 200, running: false, blank: false, projections: { values: { title: 'New' } } },
    { sessionId: 'session-old', updatedAt: 100, running: false, blank: false, projections: { values: { title: 'Old' } } },
  ] } } })
  proxy.sessions.rename = async (request) => {
    renamedPayload = request.payload
    return { result: { ok: true, value: { title: request.payload?.title ?? '', seq: 9 } } }
  }
  proxy.workspace = {
    list: async () => ({ result: { ok: true, value: { items: [], archivedSessionIds } } }),
    archiveSession: async (request) => {
      archivedPayload = request.payload
      archivedSessionIds = [...new Set([...archivedSessionIds, String(request.payload?.sessionId)])]
      return { result: { ok: true, value: { archivedSessionIds } } }
    },
  }

  const bridge = new HostBridge(proxy, 100)
  assert.equal(bridge.capabilities.sessionManagement, true)
  await bridge.refreshSummaries()
  assert.deepEqual(bridge.listSessions().map((item) => item.id), ['session-new'])

  const renamed = await bridge.renameSession('session-new', 'Renamed')
  assert.equal(renamed.ok, true)
  assert.deepEqual(renamedPayload, { sessionId: 'session-new', title: 'Renamed' })
  assert.equal(bridge.listSessions()[0]?.title, 'Renamed')

  const archived = await bridge.archiveSession('session-new')
  assert.equal(archived.ok, true)
  assert.deepEqual(archivedPayload, { sessionId: 'session-new' })
  assert.deepEqual(bridge.listSessions(), [])
  bridge.dispose()
})

test('subagent sessions stay off the phone list and out of turn notifications', async () => {
  const { proxy, getPush } = makeFakeProxy()
  proxy.sessions.list = async () => ({ result: { ok: true, value: { items: [
    { sessionId: 'session-main', updatedAt: 300, running: false, blank: false, projections: { values: { title: 'Main' } } },
    // Both subagent markers the host uses: explicit origin and a parent link.
    { sessionId: 'session-sub-a', updatedAt: 250, running: true, blank: false, origin: 'subagent', projections: { values: { title: 'Sub A' } } },
    { sessionId: 'session-sub-b', updatedAt: 240, running: false, blank: false, parentSessionId: 'session-main', projections: { values: { title: 'Sub B' } } },
  ] } } })

  const bridge = new HostBridge(proxy, 100)
  const collected: Array<{ type: string; payload: any }> = []
  bridge.start()
  bridge.addSink(makeSink(collected))
  await bridge.refreshSummaries()

  assert.deepEqual(bridge.listSessions().map((item) => item.id), ['session-main'])

  // A finished subagent turn must not ring the phone for a session it cannot open.
  getPush()({
    type: 'session/event', rpcId: 'r1', sessionId: 'session-sub-a',
    event: { type: 'assistant/message', seq: 10, data: { message: { role: 'assistant', content: [{ type: 'text', text: '子任务完成' }] } } },
  })
  getPush()({
    type: 'session/event', rpcId: 'r2', sessionId: 'session-sub-a',
    event: { type: 'turn/end', seq: 11, data: { reason: { kind: 'completed' } } },
  })
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(
    collected.filter((x) => x.type === 's2c.notify').length,
    0,
    'subagent turn completion must not notify devices',
  )
  bridge.dispose()
})

test('blank sessions report idle so phones can send the first prompt', async () => {
  const { proxy } = makeFakeProxy()
  proxy.sessions.list = async () => ({ result: { ok: true, value: { items: [
    // A phone-created session before its first prompt: blank and not running.
    { sessionId: 'session-blank', updatedAt: 300, running: false, blank: true },
    { sessionId: 'session-running', updatedAt: 200, running: true, blank: false },
    { sessionId: 'session-idle', updatedAt: 100, running: false, blank: false },
  ] } } })

  const bridge = new HostBridge(proxy, 100)
  await bridge.refreshSummaries()
  const byId = new Map(bridge.listSessions().map((s) => [s.id, s.status]))
  assert.equal(
    byId.get('session-blank'),
    'idle',
    'a never-prompted session cannot converge from unknown: the composer would disable sending forever',
  )
  assert.equal(byId.get('session-running'), 'running')
  assert.equal(byId.get('session-idle'), 'idle')
  bridge.dispose()
})

test('sendPrompt forwards image content and projects attachment metadata', async () => {
  const { proxy } = makeFakeProxy()
  let promptRequest: any
  proxy.sessions.prompt = async (request) => {
    promptRequest = request
    return { result: { ok: true, value: { accepted: true } } }
  }
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  const sent = await bridge.sendPrompt('session-image', '看这张图', [{
    mediaType: 'image/jpeg',
    data: 'aGVsbG8=',
    name: 'phone.jpg',
  }])
  assert.equal(sent.ok, true, 'an accepted prompt resolves ok')
  assert.deepEqual(promptRequest.payload.content, [
    { type: 'text', text: '看这张图' },
    { type: 'image', mediaType: 'image/jpeg', data: 'aGVsbG8=', name: 'phone.jpg' },
  ])

  const rows = projectHistory([{
    event: {
      type: 'user/message',
      seq: 1,
      data: { message: { role: 'user', content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', attachment: { mediaType: 'image/jpeg', name: 'phone.jpg' } },
      ] } },
    },
  }] as any)
  assert.deepEqual(rows[0]?.attachments, [{ kind: 'image', mediaType: 'image/jpeg', name: 'phone.jpg' }])
  bridge.dispose()
})

test('sendPrompt projects bounded documents as attachment chips without echoing their body', async () => {
  const { proxy } = makeFakeProxy()
  let promptRequest: any
  proxy.sessions.prompt = async (request) => {
    promptRequest = request
    return { result: { ok: true, value: { accepted: true } } }
  }
  const bridge = new HostBridge(proxy, 100)
  const sent = await bridge.sendPrompt('session-doc', '总结附件', [], [{
    name: 'notes.md',
    mediaType: 'text/markdown',
    text: '# Private notes\nimportant details',
  }])
  assert.equal(sent.ok, true)
  assert.equal(promptRequest.payload.content[0].text, '总结附件')
  assert.match(promptRequest.payload.content[1].text, /^\[DeepPilot document:/)
  assert.match(promptRequest.payload.content[1].text, /important details/)

  const rows = projectHistory([{
    event: {
      type: 'user/message',
      seq: 2,
      data: { message: { role: 'user', content: promptRequest.payload.content } },
    },
  }] as any)
  assert.equal(rows[0]?.text, '总结附件')
  assert.deepEqual(rows[0]?.attachments, [{
    kind: 'document',
    name: 'notes.md',
    mediaType: 'text/markdown',
  }])
  bridge.dispose()
})

test('turn.end notifies only devices not viewing the session', async () => {
  const { proxy, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  const viewerCollected: Array<{ type: string; payload: any }> = []
  const awayCollected: Array<{ type: string; payload: any }> = []
  const viewer = makeSinkInto(viewerCollected)
  const away = makeSinkInto(awayCollected)
  bridge.start()
  bridge.addSink(viewer)
  bridge.addSink(away)
  bridge.markSinkOpen(viewer, 'session-x')

  // assistant text then turn end
  getPush()({
    type: 'session/event', rpcId: 'r1', sessionId: 'session-x',
    event: { type: 'assistant/message', seq: 10, data: { message: { role: 'assistant', content: [{ type: 'text', text: '一切就绪' }] } } },
  })
  getPush()({
    type: 'session/event', rpcId: 'r2', sessionId: 'session-x',
    event: { type: 'turn/end', seq: 11, data: { reason: { kind: 'completed' } } },
  })
  await new Promise((r) => setTimeout(r, 20))

  const viewerNotifies = viewerCollected.filter((x) => x.type === 's2c.notify')
  const awayNotifies = awayCollected.filter((x) => x.type === 's2c.notify')
  assert.equal(viewerNotifies.length, 0, 'viewing device must not be notified')
  assert.equal(awayNotifies.length, 1, 'away device must be notified')
  assert.equal(awayNotifies[0].payload.category, 'turn.completed')
  assert.ok((awayNotifies[0].payload.body as string).includes('一切就绪'))
  bridge.dispose()
})

test('reasoning chunks project to thinking.delta; finals carry thinking; empty steps skipped', async () => {
  const { proxy, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  const collected: Array<{ type: string; payload: any }> = []
  bridge.start()
  bridge.addSink(makeSink(collected))

  const pushEvent = (rpcId: string, seq: number, event: any) =>
    getPush()({ type: 'session/event', rpcId, sessionId: 'session-t', event })

  pushEvent('r1', 1, { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'reasoning-delta', index: 0, text: '让我想' } } })
  pushEvent('r2', 2, { type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', index: 1, text: '答案是' } } })
  pushEvent('r3', 3, {
    type: 'assistant/message', seq: 3,
    data: {
      turn: 0, step: 0,
      message: { role: 'assistant', content: [
        { type: 'reasoning', text: '让我想想' },
        { type: 'text', text: '答案是 42' },
      ] },
    },
  })
  // Pure tool-call step without answer or reasoning must not emit a final.
  pushEvent('r4', 4, {
    type: 'assistant/message', seq: 4,
    data: { turn: 0, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } },
  })
  await new Promise((r) => setTimeout(r, 20))
  bridge.dispose()

  const events = collected.filter((x) => x.type === 's2c.session.event')
  const kinds = events.map((x) => x.payload.kind)
  assert.ok(kinds.includes('thinking.delta'), 'thinking.delta missing')
  assert.ok(kinds.includes('message.delta'), 'message.delta missing')
  assert.equal(events.filter((x) => x.payload.kind === 'message.final').length, 1, 'empty step must not emit final')
  const final = events.find((x) => x.payload.kind === 'message.final')!
  assert.equal(final.payload.data.text, '答案是 42')
  assert.equal(final.payload.data.thinking, '让我想想')

  // History projection mirrors the same shapes and skips empty rows.
  const rows = projectHistory([
    { event: { type: 'user/message', seq: 0, time: 1, data: 'hi' } },
    { event: { type: 'assistant/message', seq: 3, time: 2, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '嗯' }, { type: 'text', text: '42' }] } } } },
    { event: { type: 'assistant/message', seq: 4, time: 3, data: { message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] } } } },
  ] as any)
  const assistantRows = rows.filter((r) => r.role === 'assistant')
  assert.equal(assistantRows.length, 1, 'empty assistant row must be skipped in history')
  assert.equal(assistantRows[0].text, '42')
  assert.equal(assistantRows[0].thinking, '嗯')
})

// ---------- live tool event callId passthrough ----------

test('tool.start/tool.end pushes echo the host call id', () => {
  const start = projectEvent('s1', {
    type: 'tool/call', seq: 7, time: 1,
    data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'call-7' },
  } as any)
  assert.ok(start, 'tool/call must project')
  assert.equal(start!.kind, 'tool.start')
  assert.equal((start!.data.tool as { callId?: string }).callId, 'call-7')

  const end = projectEvent('s1', {
    type: 'tool/result', seq: 8, time: 2,
    data: { callId: 'call-7', message: { content: 'ok' } },
  } as any)
  assert.ok(end, 'tool/result must project')
  assert.equal(end!.kind, 'tool.end')
  // The result carries its own seq plus the call id that pairs it with row 7.
  assert.equal(end!.data.seq, 8)
  assert.equal(end!.data.callId, 'call-7')
  assert.equal(end!.data.ok, true)

  const failed = projectEvent('s1', {
    type: 'tool/result', seq: 9, time: 3,
    data: { error: { message: 'boom' } },
  } as any)
  assert.ok(failed, 'failed tool/result must project')
  assert.equal(failed!.data.ok, false)
  assert.equal(failed!.data.callId, undefined, 'no callId must stay absent')
})

// ---------- injected user-role context projects as system rows ----------

test('history: host-injected context rows become role=system; human prompts stay user', () => {
  const rows = projectHistory([
    // Runtime-context style snapshot injection (plugin source).
    { event: { type: 'user/message', seq: 1, time: 1, data: {
      id: 'm1', role: 'user',
      content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier snapshots.' }],
      source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] },
    } } },
    // Background-job notice injection.
    { event: { type: 'user/message', seq: 2, time: 2, data: {
      id: 'm2', role: 'user',
      content: [{ type: 'text', text: 'background job bash-9 finished. Read its output with job_output.' }],
      source: { kind: 'plugin', plugin: 'jobs', form: 'notice', summary: 'bash-9 finished' },
    } } },
    // Genuine human prompt.
    { event: { type: 'user/message', seq: 3, time: 3, data: {
      id: 'm3', role: 'user',
      content: [{ type: 'text', text: '修一下聊天界面' }],
      source: { kind: 'user' },
    } } },
    // Workspace instructions injection with path provenance.
    { event: { type: 'user/message', seq: 4, time: 4, data: {
      id: 'm4', role: 'user',
      content: [{ type: 'text', text: '# AGENTS.md — guide' }],
      source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: '/repo/AGENTS.md' }] },
    } } },
    // Legacy bare-string payload without any source must stay a user row.
    { event: { type: 'user/message', seq: 5, time: 5, data: 'hi' } },
  ] as any)

  assert.equal(rows[0].role, 'system')
  assert.equal(rows[0].context?.label, 'runtime-context')
  assert.equal(rows[0].context?.form, 'snapshot')
  assert.match(rows[0].text ?? '', /Current runtime context/)

  assert.equal(rows[1].role, 'system')
  assert.equal(rows[1].context?.label, 'jobs')
  assert.equal(rows[1].context?.form, 'notice')

  assert.equal(rows[2].role, 'user')
  assert.equal(rows[2].context, undefined)

  assert.equal(rows[3].role, 'system')
  assert.equal(rows[3].context?.label, '/repo/AGENTS.md')
  assert.equal(rows[3].context?.form, 'instructions')

  assert.equal(rows[4].role, 'user')
  assert.equal(rows[4].text, 'hi')
})

test('live push: injected user-role events emit message.final with role=system', () => {
  const live = projectEvent('s1', {
    type: 'user/message', seq: 10, time: 1,
    data: {
      id: 'm10', role: 'user',
      content: [{ type: 'text', text: 'skill loaded' }],
      source: { kind: 'skill-invocation', name: 'orca-cli', form: 'instructions' },
    },
  } as any)
  assert.ok(live, 'user/message must project live')
  assert.equal(live!.kind, 'message.final')
  assert.equal(live!.data.role, 'system')
  const context = live!.data.context as { label?: string; form?: string }
  assert.equal(context.label, 'orca-cli')
  assert.equal(context.form, 'instructions')

  // The optimistic-echo path stays intact: a human prompt final keeps role=user
  // so the phone reconciles its pending bubble.
  const echo = projectEvent('s1', {
    type: 'user/message', seq: 11, time: 2,
    data: {
      id: 'm11', role: 'user',
      content: [{ type: 'text', text: '在吗' }],
      source: { kind: 'user' },
    },
  } as any)
  assert.equal(echo!.kind, 'message.final')
  assert.equal(echo!.data.role, 'user')
})

test('wrapped legacy payloads classify through the inner message source', () => {
  const rows = projectHistory([
    { event: { type: 'user/message', seq: 20, time: 1, data: {
      message: { role: 'user', content: [{ type: 'text', text: '注入的上下文' }],
        source: { kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [] } },
    } } },
    { event: { type: 'user/message', seq: 21, time: 2, data: {
      message: { role: 'user', content: [{ type: 'text', text: '真人在说话' }],
        source: { kind: 'user' } },
    } } },
  ] as any)
  assert.equal(rows[0].role, 'system')
  assert.equal(rows[0].context?.label, 'time-context')
  assert.equal(rows[1].role, 'user')
})

// ---------- replay targeting ----------

function makeRecordingSink() {
  const frames: Array<{ type: string; seq?: number }> = []
  let done = 0
  return {
    frames,
    doneCount: () => done,
    push: (type: string, _p: unknown, seq?: number) => { frames.push({ type, seq }) },
    lastCursor: () => 0,
    replay: (entries: Array<{ seq: number; type: string }>) => { for (const e of entries) frames.push({ type: e.type, seq: e.seq }) },
    replayDone: () => { done += 1 },
    resync: () => {},
  }
}

test('resumeFrom replays only into the requesting sink, not every connected device', () => {
  const { proxy } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 100)
  bridge.start()

  // Fill the ring with three pushes.
  ;(bridge as any).record('s2c.a', {})
  ;(bridge as any).record('s2c.b', {})
  ;(bridge as any).record('s2c.c', {})

  const requester = makeRecordingSink()
  const bystander = makeRecordingSink()
  bridge.addSink(requester)
  bridge.addSink(bystander)

  const ok = bridge.resumeFrom(1, requester as any) // everything after seq 1
  assert.equal(ok, true)

  const replayedTypes = requester.frames.map((f) => f.type).sort().join(',')
  assert.ok(replayedTypes.includes('s2c.b') && replayedTypes.includes('s2c.c'), 'requester gets the missed window')
  assert.ok(!replayedTypes.includes('s2c.a'), 'frames at or before the cursor are not resent')
  assert.equal(requester.doneCount(), 1, 'exactly one replayDone for the requester')
  assert.deepEqual(bystander.frames, [], 'bystander devices receive no replay traffic')
  assert.equal(bystander.doneCount(), 0, 'no spurious replayDone on bystanders')
  bridge.dispose()
})

test('canResumeFrom detects unrecoverable gaps against the oldest buffered seq', () => {
  const { proxy } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 3) // tiny ring
  bridge.start()
  for (let i = 0; i < 10; i++) (bridge as any).record('s2c.tick', { i })

  assert.equal(bridge.canResumeFrom(bridge.currentCursor()), true, 'current cursor always resumable')
  assert.equal(bridge.canResumeFrom(1), false, 'a cursor older than the ring is a gap')
  assert.equal(bridge.canResumeFrom(bridge.currentCursor() + 1), false, 'a cursor from another bridge lifetime is a gap')
  bridge.dispose()
})

test('pending snapshot preserves full answerable state independently of replay', async () => {
  const { proxy, getPush } = makeFakeProxy()
  const bridge = new HostBridge(proxy, 1)
  bridge.start()
  getPush()({
    type: 'approval/requested', rpcId: 'rpc-a', sessionId: 'session-x',
    approvalId: 'apr-snapshot', toolName: 'bash', reason: 'write files',
  })
  getPush()({
    type: 'question/requested', rpcId: 'rpc-q', sessionId: 'session-x',
    questions: [{ id: 'choice', question: 'Choose?', options: [{ label: 'A' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))

  // Overflow the one-entry replay ring. The authoritative snapshot must still
  // retain both transient interactions and their response ids.
  ;(bridge as any).record('s2c.tick', {})
  const snapshot = bridge.pendingSnapshot()
  assert.equal(snapshot.approvals[0].requestId, 'apr-snapshot')
  assert.equal(snapshot.approvals[0].summary, 'write files')
  assert.equal(snapshot.questions[0].requestId, 'q-rpc-q')
  assert.equal(snapshot.questions[0].questions[0].question, 'Choose?')
  bridge.dispose()
})

// ---------- approval/question single-shot ----------

test('approval response claims the pending entry so a second submit cannot re-fire', async () => {
  const { proxy, getPush } = makeFakeProxy()
  let respondCalls = 0
  proxy.respond = async () => {
    respondCalls += 1
    return { accepted: true }
  }
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'approval/requested',
    rpcId: 'rpc-dup',
    sessionId: 'session-x',
    approvalId: 'apr-dup',
    toolName: 'bash',
    reason: '',
  })
  await new Promise((r) => setTimeout(r, 20))

  assert.equal((await bridge.respondApproval('apr-dup', 'allow')).ok, true)
  assert.equal((await bridge.respondApproval('apr-dup', 'deny')).ok, false, 'second submit finds nothing pending')
  assert.equal(respondCalls, 1, 'the host receives exactly one client-response')

  // The resolved frame arriving later stays harmless.
  getPush()({ type: 'approval/resolved', approvalId: 'apr-dup' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal((await bridge.respondApproval('apr-dup', 'deny')).ok, false)
  assert.equal(respondCalls, 1)
  bridge.dispose()
})

test('approval response survives a transport error by restoring the pending entry', async () => {
  const { proxy, getPush } = makeFakeProxy()
  let failNext = true
  proxy.respond = async () => {
    if (failNext) throw new Error('socket hiccup')
    return { accepted: true }
  }
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'approval/requested',
    rpcId: 'rpc-retry',
    sessionId: 'session-x',
    approvalId: 'apr-retry',
    toolName: 'bash',
    reason: '',
  })
  await new Promise((r) => setTimeout(r, 20))

  assert.equal((await bridge.respondApproval('apr-retry', 'allow')).ok, false)
  failNext = false
  assert.equal((await bridge.respondApproval('apr-retry', 'allow')).ok, true, 'pending was restored for retry')
  bridge.dispose()
})

test('host rejection restores approval and question entries for retry', async () => {
  const { proxy, getPush } = makeFakeProxy()
  let accept = false
  proxy.respond = async () => ({ accepted: accept, reason: accept ? undefined : 'invalid answer batch' })
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'approval/requested', rpcId: 'rpc-rejected', sessionId: 'session-x',
    approvalId: 'apr-rejected', toolName: 'bash', reason: '',
  })
  getPush()({
    type: 'question/requested', rpcId: 'rq-rejected', sessionId: 'session-x',
    questions: [{ id: 'q1', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))

  const answers = [{ id: 'q1', selected: ['A'], custom: '' }]
  assert.equal((await bridge.respondApproval('apr-rejected', 'allow')).ok, false)
  assert.equal((await bridge.respondQuestion('q-rq-rejected', answers)).ok, false)

  accept = true
  assert.equal((await bridge.respondApproval('apr-rejected', 'allow')).ok, true)
  assert.equal((await bridge.respondQuestion('q-rq-rejected', answers)).ok, true)
  bridge.dispose()
})

test('question response follows the same single-shot claim semantics', async () => {
  const { proxy, getPush } = makeFakeProxy()
  let respondCalls = 0
  proxy.respond = async () => {
    respondCalls += 1
    return { accepted: true }
  }
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  getPush()({
    type: 'question/requested',
    rpcId: 'rq-single',
    sessionId: 'session-x',
    questions: [{ id: 'q1', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }],
  })
  await new Promise((r) => setTimeout(r, 20))

  const answers = [{ id: 'q1', selected: ['A'], custom: '' }]
  assert.equal((await bridge.respondQuestion('q-rq-single', answers)).ok, true)
  assert.equal((await bridge.respondQuestion('q-rq-single', answers)).ok, false)
  assert.equal(respondCalls, 1)
  bridge.dispose()
})

test('session summary carries the full todo checklist for conversation views', async () => {
  const { proxy } = makeFakeProxy()
  proxy.sessions.list = async () => ({ result: { ok: true, value: { items: [
    {
      sessionId: 'session-todo',
      updatedAt: 300,
      running: true,
      blank: false,
      projections: { values: { title: 'Todo 会话' } },
    },
  ] } } })
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  const collected: Array<{ type: string; payload: any }> = []
  bridge.addSink(makeSink(collected))
  await new Promise((r) => setTimeout(r, 20))

  ;(bridge as any).onMuxFrame({
    type: 'session/projection',
    sessionId: 'session-todo',
    key: 'todos',
    value: [
      { content: '定位问题', status: 'completed' },
      { content: '修复重定向', status: 'in_progress' },
      { content: '   ', status: 'pending' }, // blank content is dropped
      { content: '写回归测试', status: 'bogus' }, // unknown status is dropped
    ],
  })
  await new Promise((r) => setTimeout(r, 20))

  const delta = [...collected].reverse().find((f) => f.type === 's2c.sessions.delta')
  assert.ok(delta, 'sessions.delta missing')
  const upserted = delta.payload.upserted.find((s: any) => s.id === 'session-todo')
  assert.ok(upserted, 'session summary missing from delta')
  assert.deepEqual(upserted.todoItems, [
    { content: '定位问题', status: 'completed' },
    { content: '修复重定向', status: 'in_progress' },
  ])
  assert.deepEqual(upserted.todos, { done: 1, total: 2 })
  bridge.dispose()
})

test('user message projection carries the durable attachment reference', async () => {
  const { proxy } = makeFakeProxy()
  proxy.sessions.list = async () => ({ result: { ok: true, value: { items: [
    {
      sessionId: 'session-img',
      updatedAt: 400,
      running: false,
      blank: false,
      projections: { values: { title: '图片会话' } },
    },
  ] } } })
  const bridge = new HostBridge(proxy, 100)
  bridge.start()
  const collected: Array<{ type: string; payload: any }> = []
  bridge.addSink(makeSink(collected))
  await new Promise((r) => setTimeout(r, 20))

  ;(bridge as any).onMuxFrame({
    type: 'session/event',
    sessionId: 'session-img',
    event: {
      type: 'user/message',
      seq: 7,
      time: 1234,
      data: {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看这张图' },
            {
              type: 'image',
              attachment: {
                attachmentId: 'att-1',
                mediaType: 'image/jpeg',
                width: 2048,
                height: 1536,
                name: 'photo.jpg',
              },
            },
            // Non-image blocks are ignored.
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
          ],
        },
      },
    },
  })
  await new Promise((r) => setTimeout(r, 20))

  const push = [...collected].reverse().find((f) => f.type === 's2c.session.event')
  assert.ok(push, 'session.event push missing')
  assert.equal(push.payload.kind, 'message.final')
  assert.deepEqual(push.payload.data.attachments, [
    {
      kind: 'image',
      name: 'photo.jpg',
      mediaType: 'image/jpeg',
      attachmentId: 'att-1',
      width: 2048,
      height: 1536,
    },
  ])
  bridge.dispose()
})

test('attachmentData relays host bytes and degrades when unsupported', async () => {
  const { proxy } = makeFakeProxy()
  let capturedPayload: any
  proxy.sessions.attachment = async (req: any) => {
    capturedPayload = req.payload
    return { result: { ok: true, value: { attachment: { mediaType: 'image/png' }, data: 'aGk=' } } }
  }
  const bridge = new HostBridge(proxy, 100)
  bridge.start()

  const image = await bridge.attachmentData('session-a', 'att-9')
  assert.deepEqual(image, { mediaType: 'image/png', data: 'aGk=' })
  assert.deepEqual(capturedPayload, { sessionId: 'session-a', attachmentId: 'att-9' })

  // A host without sessions.attachment degrades to null instead of throwing.
  const plainBridge = new HostBridge(makeFakeProxy().proxy, 100)
  assert.equal(await plainBridge.attachmentData('session-a', 'att-9'), null)
  bridge.dispose()
})
