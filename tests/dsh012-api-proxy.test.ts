import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Dsh012ApiProxy } from '../src/dsh012-api-proxy.ts'
import { HostBridge, projectHistory } from '../src/host-bridge.ts'
import type { BridgeSink } from '../src/host-bridge.ts'
import { unwrapStreamItem } from '../src/host-api.ts'

test('dsh 0.1.2 non-empty raw history opens through the stable bridge shape', async () => {
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
    inspect: async () => ({ events: rawEvents }),
  }
  const ctx = {
    get: (key: string) => key === 'sessionController' ? sessionController : undefined,
  }
  const proxy = new Dsh012ApiProxy(ctx as never)
  const bridge = new HostBridge(proxy, 100)
  const frames: Array<{ type: string; payload: any }> = []
  const sink: BridgeSink = {
    push: (type, payload) => frames.push({ type, payload }),
    lastCursor: () => 0,
    replay: () => {},
    replayDone: () => {},
    resync: () => {},
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

test('dsh 0.1.2 history adapter preserves sequence pagination while wrapping events', async () => {
  const rawEvents = [
    { type: 'user/message', seq: 1, data: { content: [], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
    { type: 'user/message', seq: 3, data: { content: [], source: { kind: 'user' } } },
  ]
  const ctx = {
    get: (key: string) => key === 'sessionController'
      ? { inspect: async () => ({ events: rawEvents }) }
      : undefined,
  }
  const proxy = new Dsh012ApiProxy(ctx as never)

  const response = await proxy.sessions.history({
    payload: { sessionId: 'legacy-session', beforeSeq: 3, maxMessages: 1 },
  })

  assert.deepEqual(response, {
    result: {
      ok: true,
      value: {
        events: [{ event: rawEvents[1] }],
        hasMore: true,
      },
    },
  })
})

test('dsh 0.1.2 history adapter skips raw pages with no phone message projection', async () => {
  const rawEvents = [
    {
      type: 'user/message',
      seq: 1,
      time: 10,
      data: { content: [{ type: 'text', text: 'earlier message' }], source: { kind: 'user' } },
    },
    { type: 'turn/start', seq: 2, data: {} },
    { type: 'assistant/chunk', seq: 3, data: { chunk: { type: 'text-delta', text: 'ignored in history' } } },
  ]
  const ctx = {
    get: (key: string) => key === 'sessionController'
      ? { inspect: async () => ({ events: rawEvents }) }
      : undefined,
  }
  const proxy = new Dsh012ApiProxy(ctx as never)
  const bridge = new HostBridge(proxy, 100)

  assert.deepEqual(await bridge.historyPage('legacy-session', 4, 1), {
    sessionId: 'legacy-session',
    messages: [{ seq: 1, ts: 10, role: 'user', text: 'earlier message' }],
    hasMore: false,
  })
  bridge.dispose()
})

test('dsh 0.1.2 history adapter accumulates raw pages up to the requested phone message count', async () => {
  const rawEvents = [
    { type: 'user/message', seq: 1, time: 10, data: 'oldest' },
    { type: 'turn/start', seq: 2, time: 20, data: {} },
    { type: 'user/message', seq: 3, time: 30, data: 'middle' },
    { type: 'turn/start', seq: 4, time: 40, data: {} },
    {
      type: 'assistant/message',
      seq: 5,
      time: 50,
      data: { message: { content: [{ type: 'text', text: 'latest' }] } },
    },
  ]
  const ctx = {
    get: (key: string) => key === 'sessionController'
      ? { inspect: async () => ({ events: rawEvents }) }
      : undefined,
  }
  const proxy = new Dsh012ApiProxy(ctx as never)

  const first = await proxy.sessions.history({
    payload: { sessionId: 'legacy-session', beforeSeq: 6, maxMessages: 2 },
  })
  assert.equal(first.result?.ok, true)
  if (!first.result?.ok) return
  assert.deepEqual(projectHistory(first.result.value.events), [
      { seq: 3, ts: 30, role: 'user', text: 'middle' },
      { seq: 5, ts: 50, role: 'assistant', text: 'latest' },
  ])
  assert.equal(first.result.value.hasMore, true)

  const second = await proxy.sessions.history({
    payload: { sessionId: 'legacy-session', beforeSeq: 3, maxMessages: 2 },
  })
  assert.equal(second.result?.ok, true)
  if (!second.result?.ok) return
  assert.deepEqual(projectHistory(second.result.value.events), [
    { seq: 1, ts: 10, role: 'user', text: 'oldest' },
  ])
  assert.equal(second.result.value.hasMore, false)
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

  readonly gateway = {
    wireStream: {
      open: async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>> => {
        assert.equal(endpoint, '$events')
        assert.deepEqual(payload, { args: {} })
        this.opened = true
        this.openedWake?.()
        return this.stream(signal)
      },
    },
  }

  readonly connection = {
    createSharedFetchHandler: (channel: string) => {
      assert.equal(channel, '/api')
      return {
        fetch: async (request: Request): Promise<Response> => {
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

async function startMux(proxy: Dsh012ApiProxy, signal: AbortSignal) {
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
  const proxy = new Dsh012ApiProxy(ctx)
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
  const proxy = new Dsh012ApiProxy(ctx, { shouldSurfaceInteraction: () => false })
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
  const proxy = new Dsh012ApiProxy(ctx, {
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
  const proxy = new Dsh012ApiProxy(ctx, { shouldSurfaceInteraction: kind => kind === 'approval' })
  const controller = new AbortController()
  const { iterator, firstFrame } = await startMux(proxy, controller.signal)
  await harness.waitUntilOpened()

  harness.push({
    type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 'session-a',
    request: { toolName: 'write', reason: 'edit' },
  })
  const streamItem = await firstFrame
  assert.equal(streamItem.done, false)
  const frame = unwrapStreamItem(streamItem.value!)
  assert.equal(frame.type, 'approval/requested')
  assert.equal(frame.sessionId, 'session-a')

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
  const proxy = new Dsh012ApiProxy(ctx)
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
  const proxy = new Dsh012ApiProxy(ctx, {
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
