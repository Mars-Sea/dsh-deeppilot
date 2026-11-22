import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import type { BridgeSink } from '../src/host-bridge.ts'
import { unwrapStreamItem } from '../src/host-api.ts'

test('persisted messages open through the Host page and stable bridge shape', async () => {
  const rawEvents = [
    {
      type: 'user/message',
      seq: 1,
      time: 10,
      data: {
        id: 'message-1',
        role: 'user',
        content: [{ type: 'text', text: '旧会话问题' }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 20,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message-2',
          role: 'assistant',
          content: [{ type: 'text', text: '旧会话回答' }],
          source: { kind: 'model' },
        },
      },
    },
  ]
  const sessionController = {
    page: async () => ({ records: rawEvents.map(event => ({ type: 'event', event })), hasMore: false }),
  }
  const ctx = {
    get: (key: string) => key === 'sessionController' ? sessionController : undefined,
  }
  const proxy = new DshApiProxy(ctx as never)
  const bridge = new HostBridge(proxy, 100)
  const frames: Array<{ type: string; payload: any }> = []
  const sink: BridgeSink = {
    push: (type, payload) => frames.push({ type, payload }),
    lastCursor: () => 0,
    replay: () => {},
    replayDone: () => {},
    resync: () => {},
    canReceive: () => true,
  }

  assert.equal(await bridge.openSession(sink, 'legacy-session', 100), true)
  assert.deepEqual(frames, [{
    type: 's2c.session.tail',
    payload: {
      sessionId: 'legacy-session',
      messages: [
        { seq: 1, ts: 10, role: 'user', text: '旧会话问题' },
        { seq: 2, ts: 20, role: 'assistant', text: '旧会话回答' },
      ],
      oldestSeq: 1,
      hasMore: false,
    },
  }])
  bridge.dispose()
})

test('history unwraps Host page events and translates the exclusive cursor', async () => {
  const records = [
    { type: 'event', event: { type: 'user/message', seq: 1, data: { content: [], source: { kind: 'user' } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'answer' }] } } } },
  ]
  const calls: Array<Record<string, unknown>> = []
  const sessionController = {
    page: async (request: Record<string, unknown>) => {
      calls.push(request)
      return { records, hasMore: true }
    },
  }
  const ctx = {
    get: (key: string) => key === 'sessionController' ? sessionController : undefined,
  }
  const proxy = new DshApiProxy(ctx as never)

  const response = await proxy.sessions.history({
    payload: { sessionId: 'session-1', beforeSeq: 7, maxMessages: 2 },
  })

  // The phone sends an exclusive seq; the host cut is an inclusive one.
  assert.deepEqual(calls, [{
    address: { kind: 'session', sessionId: 'session-1' },
    throughSeq: 6,
    maxMessages: 2,
  }])
  assert.deepEqual(response, {
    result: {
      ok: true,
      value: {
        events: records.map((record) => ({ event: record.event })),
        hasMore: true,
      },
    },
  })
})

test('alpha.2 history omits the cut when the phone asks for the newest page', async () => {
  const calls: Array<Record<string, unknown>> = []
  const sessionController = {
    page: async (request: Record<string, unknown>) => {
      calls.push(request)
      return { records: [], hasMore: false }
    },
  }
  const ctx = {
    get: (key: string) => key === 'sessionController' ? sessionController : undefined,
  }
  const proxy = new DshApiProxy(ctx as never)

  await proxy.sessions.history({ payload: { sessionId: 'session-1' } })

  assert.deepEqual(calls, [{
    address: { kind: 'session', sessionId: 'session-1' },
    maxMessages: 100,
  }])
})

test('projection baseline reads pass the AbortSignal the Host now requires', async () => {
  // DSH 0.2.1-alpha.2 aborts projections before it reads anything, so an omitted
  // signal loses the entire baseline instead of returning values.
  const signals: Array<AbortSignal | undefined> = []
  const ctx = {
    get: (key: string) => key === 'sessionController'
      ? {
        projections: async (_request: unknown, signal: AbortSignal) => {
          signals.push(signal)
          signal.throwIfAborted()
          return { asOfSeq: 7, values: { title: '投影基线' } }
        },
      }
      : undefined,
  }
  const proxy = new DshApiProxy(ctx as never)

  const response = await proxy.sessions.projections({ payload: { sessionId: 'session-1' } })

  assert.deepEqual(response, {
    result: { ok: true, value: { asOfSeq: 7, values: { title: '投影基线' } } },
  })
  assert.equal(signals.length, 1)
  assert.ok(signals[0] instanceof AbortSignal)
})

interface RemoteResultFrame {
  clientId: string
  eventId: string
  outcome: { kind: string; value?: unknown }
}

class RemoteEventHarness {
  private readonly frames: unknown[] = []
  private readonly results: RemoteResultFrame[] = []
  private frameWake: (() => void) | undefined
  private resultWake: (() => void) | undefined
  private openedWake: (() => void) | undefined
  private opened = false

  private readonly peer = { principal: { kind: 'owner' }, interactions: 'answer', signal: new AbortController().signal }

  readonly gateway = {
    wireStream: {
      open: async (endpoint: string, payload: unknown, uplink: unknown, peer: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> => {
        assert.equal(endpoint, '$events')
        assert.deepEqual(payload, { args: {} })
        assert.equal(uplink, undefined)
        assert.equal(peer, this.peer)
        this.opened = true
        this.openedWake?.()
        return this.stream(signal)
      },
    },
  }

  readonly connection = {
    createPeer: () => this.peer,
    createSharedFetchHandler: (channel: string) => {
      assert.equal(channel, '/api')
      return {
        fetch: async (request: Request, peer: unknown): Promise<Response> => {
          assert.equal(peer, this.peer)
          const body = await request.json() as {
            rpcId: string
            method: string
            payload: { args: RemoteResultFrame }
          }
          assert.equal(body.method, '$events/result')
          this.results.push(body.payload.args)
          this.resultWake?.()
          return Response.json({
            type: 'server-response',
            rpcId: body.rpcId,
            result: { ok: true },
          })
        },
      }
    },
  }

  push(frame: unknown): void {
    this.frames.push(frame)
    this.frameWake?.()
  }

  async waitUntilOpened(): Promise<void> {
    if (this.opened) return
    await new Promise<void>(resolve => { this.openedWake = resolve })
    this.openedWake = undefined
  }

  async nextResult(): Promise<RemoteResultFrame> {
    while (this.results.length === 0) {
      await new Promise<void>(resolve => { this.resultWake = resolve })
      this.resultWake = undefined
    }
    return this.results.shift()!
  }

  private async *stream(signal: AbortSignal): AsyncIterable<unknown> {
    yield { type: 'ready', clientId: 'deeppilot-client', host: { home: '/tmp/home' } }
    while (!signal.aborted) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await new Promise<void>(resolve => {
        const abort = (): void => resolve()
        signal.addEventListener('abort', abort, { once: true })
        this.frameWake = () => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
      })
      this.frameWake = undefined
    }
  }
}

function interactionContext(harness: RemoteEventHarness): Context {
  const ctx = new Context()
  ctx.provide('sessionController', {})
  ctx.provide('connection', harness.connection)
  ctx.provide('typertGateway', harness.gateway)
  return ctx
}

async function startMux(proxy: DshApiProxy, signal: AbortSignal) {
  const iterator = proxy.events.mux({}, signal)[Symbol.asyncIterator]()
  const firstFrame = iterator.next()
  return { iterator, firstFrame }
}

function dispatchHostWaterfall(
  ctx: Context,
  event: string,
  request: unknown,
  fallback: () => Promise<unknown>,
): Promise<unknown> {
  return (ctx as unknown as {
    waterfall(event: string, request: unknown, fallback: () => Promise<unknown>): Promise<unknown>
  }).waterfall(event, request, fallback)
}

test('DeepPilot no longer registers a competing Host interaction waterfall', async () => {
  const harness = new RemoteEventHarness()
  const ctx = interactionContext(harness)
  const proxy = new DshApiProxy(ctx)
  const controller = new AbortController()
  const { iterator } = await startMux(proxy, controller.signal)
  await harness.waitUntilOpened()

  assert.equal(await dispatchHostWaterfall(
    ctx,
    'approval/request',
    { toolName: 'write' },
    async () => 'official-host-chain',
  ), 'official-host-chain')

  controller.abort()
  await iterator.return?.()
})

test('a missing phone surface delegates only the DeepPilot Gateway delivery', async () => {
  const harness = new RemoteEventHarness()
  const ctx = interactionContext(harness)
  const proxy = new DshApiProxy(ctx, { shouldSurfaceInteraction: () => false })
  const controller = new AbortController()
  const { iterator, firstFrame } = await startMux(proxy, controller.signal)
  await harness.waitUntilOpened()

  harness.push({
    type: 'waterfall', event: 'approval/request', eventId: 'approval-next',
    agentId: 'session-a', request: { toolName: 'write' },
  })
  assert.deepEqual(await harness.nextResult(), {
    clientId: 'deeppilot-client', eventId: 'approval-next', outcome: { kind: 'next' },
  })

  controller.abort()
  assert.equal((await firstFrame).done, true, 'delegated delivery must not create a phone pending frame')
  await iterator.return?.()
})

test('the resident phone Client returns a question through the official Gateway result channel', async () => {
  const harness = new RemoteEventHarness()
  const ctx = interactionContext(harness)
  const proxy = new DshApiProxy(ctx, {
    shouldSurfaceInteraction: kind => kind === 'question',
  })
  const controller = new AbortController()
  const { iterator, firstFrame } = await startMux(proxy, controller.signal)
  await harness.waitUntilOpened()

  harness.push({
    type: 'waterfall', event: 'user-questions/request', eventId: 'question-1', agentId: 'session-q',
    request: { questions: [{ id: 'choice', question: 'A or B?' }] },
  })
  const streamItem = await firstFrame
  assert.equal(streamItem.done, false)
  const frame = unwrapStreamItem(streamItem.value!)
  assert.equal(frame.type, 'question/requested')
  assert.equal(frame.sessionId, 'session-q')

  const phoneAnswer = { answers: [{ id: 'choice', selected: ['A'] }] }
  assert.deepEqual(await proxy.respond({
    type: 'client-response',
    rpcId: frame.rpcId!,
    result: { ok: true, value: { answer: phoneAnswer } },
  }), { accepted: true })
  assert.deepEqual(await harness.nextResult(), {
    clientId: 'deeppilot-client', eventId: 'question-1',
    outcome: { kind: 'result', value: phoneAnswer },
  })

  controller.abort()
  await iterator.return?.()
})

test('a phone approval is sent through Gateway and resolves the local pending card', async () => {
  const harness = new RemoteEventHarness()
  const ctx = interactionContext(harness)
  const proxy = new DshApiProxy(ctx, { shouldSurfaceInteraction: kind => kind === 'approval' })
  const controller = new AbortController()
  const { iterator, firstFrame } = await startMux(proxy, controller.signal)
  await harness.waitUntilOpened()

  harness.push({
    type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 'session-a',
    request: { toolName: 'write', reason: 'edit', callId: 'call-approval' },
  })
  const streamItem = await firstFrame
  assert.equal(streamItem.done, false)
  const frame = unwrapStreamItem(streamItem.value!)
  assert.equal(frame.type, 'approval/requested')
  assert.equal(frame.sessionId, 'session-a')
  assert.equal(frame.callId, 'call-approval')

  assert.deepEqual(await proxy.respond({
    type: 'client-response',
    rpcId: frame.rpcId!,
    result: { ok: true, value: { outcome: 'allowed-once' } },
  }), { accepted: true })
  assert.deepEqual(await harness.nextResult(), {
    clientId: 'deeppilot-client', eventId: 'approval-1',
    outcome: { kind: 'result', value: 'allowed-once' },
  })

  const resolved = unwrapStreamItem((await iterator.next()).value!)
  assert.equal(resolved.type, 'approval/resolved')
  assert.equal(resolved.approvalId, frame.approvalId)

  controller.abort()
  await iterator.return?.()
})

test('Gateway cancellation from a Web answer clears the phone pending interaction', async () => {
  const harness = new RemoteEventHarness()
  const ctx = interactionContext(harness)
  const proxy = new DshApiProxy(ctx)
  const controller = new AbortController()
  const { iterator, firstFrame } = await startMux(proxy, controller.signal)
  await harness.waitUntilOpened()

  harness.push({
    type: 'waterfall', event: 'approval/request', eventId: 'web-won', agentId: 'session-a',
    request: { toolName: 'write' },
  })
  const frame = unwrapStreamItem((await firstFrame).value!)
  assert.equal(frame.type, 'approval/requested')

  harness.push({ type: 'cancel', eventId: 'web-won' })
  const resolved = unwrapStreamItem((await iterator.next()).value!)
  assert.equal(resolved.type, 'approval/resolved')
  assert.deepEqual(await proxy.respond({
    type: 'client-response', rpcId: frame.rpcId!, result: { ok: true, value: { outcome: 'rejected' } },
  }), { accepted: false, reason: 'not-pending' })

  controller.abort()
  await iterator.return?.()
})

test('a throwing phone-surface decision delegates this Gateway delivery', async () => {
  const harness = new RemoteEventHarness()
  const ctx = interactionContext(harness)
  const proxy = new DshApiProxy(ctx, {
    shouldSurfaceInteraction: () => { throw new Error('registry broke') },
  })
  const controller = new AbortController()
  const { iterator, firstFrame } = await startMux(proxy, controller.signal)
  await harness.waitUntilOpened()

  harness.push({
    type: 'waterfall', event: 'approval/request', eventId: 'decision-error',
    agentId: 'session-a', request: { toolName: 'write' },
  })
  assert.deepEqual(await harness.nextResult(), {
    clientId: 'deeppilot-client', eventId: 'decision-error', outcome: { kind: 'next' },
  })
  controller.abort()
  assert.equal((await firstFrame).done, true)
  await iterator.return?.()
})

for (const listed of [true, false]) {
  test(`adapter and bridge suppress worker completion pushes (${listed ? 'listed' : 'before list refresh'})`, async () => {
    const harness = new RemoteEventHarness()
    const ctx = new Context()
    // `parentSessionId` alone is not tested here as a suppression signal: a
    // forked (c2s.session.fork) session also carries it as lineage while
    // being an ordinary top-level session — see host-bridge.test.ts's
    // "forked sessions surface on the phone list" case. Only `origin:
    // 'subagent'` identifies a real worker, on both the list row and the
    // live Session header below.
    let rows: Array<Record<string, unknown>> = [
      { sessionId: 'main', updatedAt: 1, running: true },
      ...(listed ? [
        { sessionId: 'worker-origin', origin: 'subagent', updatedAt: 1, running: true },
      ] : []),
    ]
    ctx.provide('sessionController', { list: async () => ({ items: rows }) })
    ctx.provide('connection', harness.connection)
    ctx.provide('typertGateway', harness.gateway)
    const bridge = new HostBridge(new DshApiProxy(ctx), 100)
    const frames: Array<{ type: string; payload: any }> = []
    const pushes: Array<{ sessionId: string; category: string }> = []
    bridge.addSink({
      push: (type, payload) => frames.push({ type, payload }),
      lastCursor: () => 0, replay: () => {}, replayDone: () => {},
      resync: () => {}, canReceive: () => true,
    })
    bridge.setPushOutlet({ fanOut: value => pushes.push(value), isAvailable: () => true })
    const emit = (id: string, header: Record<string, unknown>, failed = false) => {
      (ctx as unknown as { emit(event: string, ...args: unknown[]): void }).emit(
        'session/event', { id, header },
        { type: 'turn/end', seq: 1, data: { reason: { kind: failed ? 'error' : 'completed' } } },
      )
    }
    const waitForMain = async (count: number) => {
      for (let i = 0; i < 100 && pushes.length < count; i++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(pushes.length, count)
    }
    bridge.start()
    try {
      await harness.waitUntilOpened()
      await bridge.refreshSummaries()
      assert.deepEqual(bridge.listSessions().map(row => row.id), ['main'])
      // Listed workers can have older event sources without identity hints.
      // Newly created workers must be recognized from the live Session header.
      emit('worker-origin', listed ? {} : { origin: 'subagent' })
      // Ordinary fork lineage must still notify, including before list refresh.
      emit('main', { parentSession: 'fork-source' })
      await waitForMain(1)
      assert.deepEqual(pushes.map(p => [p.sessionId, p.category]), [['main', 'turn.completed']])

      // A stale/shorter list must not forget a worker identified earlier.
      rows = [rows[0]!]
      await bridge.refreshSummaries()
      emit('worker-origin', {})
      emit('main', {}, true)
      await waitForMain(2)
      assert.deepEqual(pushes.map(p => [p.sessionId, p.category]), [
        ['main', 'turn.completed'], ['main', 'session.error'],
      ])
      assert.deepEqual(frames.filter(f => f.type === 's2c.notify').map(f => f.payload.sessionId), ['main', 'main'])
      assert.equal(frames.some(f => f.type === 's2c.session.event' && f.payload.sessionId.startsWith('worker-')), false)
    } finally {
      bridge.dispose()
    }
  })
}

test('restore capability reflects whether the optional workspace service is present', () => {
  for (const available of [false, true]) {
    const workspace = available ? { unarchiveSession: async () => ({ archivedSessionIds: [] }) } : undefined
    const proxy = new DshApiProxy({ get: (key: string) =>
      key === 'sessionController' ? {} : key === 'workspaceController' ? workspace : undefined,
    } as never)
    const bridge = new HostBridge(proxy, 100)
    assert.equal(bridge.capabilities.sessionRestore, available)
    bridge.dispose()
  }
})

test('the Host controller receives the phone queue operation', async () => {
  const calls: unknown[] = []
  const controller = { updateQueue: async (request: unknown) => { calls.push(request); return { accepted: true } } }
  const proxy = new DshApiProxy({ get: (key: string) =>
    key === 'sessionController' ? controller : undefined,
  } as never)
  const bridge = new HostBridge(proxy, 100)
  try {
    assert.equal(bridge.capabilities.promptQueue, true)
    const request = { sessionId: 's', itemId: 'm', action: { kind: 'remove' as const } }
    assert.deepEqual(await proxy.sessions.updateQueue!({ rpcId: 'r', payload: request }), { result: { ok: true, value: { accepted: true } } })
    assert.deepEqual(calls, [request])
  } finally {
    bridge.dispose()
  }
})

test('schedule capability follows the optional service mounting after the bridge exists', () => {
  let controller: Record<string, unknown> | undefined
  const proxy = new DshApiProxy({ get: (key: string) =>
    key === 'sessionController' ? {} : key === 'schedule' ? controller : undefined,
  } as never)
  const bridge = new HostBridge(proxy, 100)
  try {
    assert.equal(bridge.capabilities.schedules, false, '服务未挂载时不得通告日程能力')
    controller = {
      list: async () => ({ items: [] }),
      edit: async () => ({}),
    }
    assert.equal(bridge.capabilities.schedules, true, '服务后挂载时必须能通告日程能力')
    // Repeated reads must keep working, and must not rebuild the adapter.
    assert.equal(bridge.capabilities.schedules, true)
    const mounted = proxy.schedule
    assert.equal(mounted, proxy.schedule)
    controller = undefined
    assert.equal(bridge.capabilities.schedulesHost, false)
    controller = { list: async () => ({ items: [] }) }
    assert.notEqual(proxy.schedule, mounted)
  } finally {
    bridge.dispose()
  }
})

test('image read-back sends the complete verified Host reference', async () => {
  const stored = { attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 3, width: 2, height: 1 }
  const records = [{ type: 'event', event: { type: 'tool/result', seq: 4, data: { callId: 'c', message: { role: 'tool', content: [{ type: 'image', attachment: stored }] } } } }]
  let reads = 0
  const sessionController = {
    page: async () => ({ records, hasMore: false }),
    attachment: async (request: { sessionId: string; attachment: typeof stored }) => {
      assert.deepEqual(request, { sessionId: 'session-1', attachment: stored })
      reads++
      return { attachment: request.attachment, data: 'aGk=' }
    },
  }
  const proxy = new DshApiProxy({ get: (key: string) => key === 'sessionController' ? sessionController : undefined } as never)
  const bridge = new HostBridge(proxy, 100)
  try {
    assert.deepEqual(await bridge.attachmentData('session-1', 'sha256:abc'), { mediaType: 'image/png', data: 'aGk=' })
    assert.equal(await bridge.attachmentData('session-1', 'sha256:other'), null)
    assert.equal(reads, 1, 'unreferenced attachments never reach the Host controller')
  } finally {
    bridge.dispose()
  }
})
