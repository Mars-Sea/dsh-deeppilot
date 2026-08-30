import assert from 'node:assert/strict'
import test from 'node:test'
import { Dsh012ApiProxy } from '../src/dsh012-api-proxy.ts'
import { HostBridge, projectHistory } from '../src/host-bridge.ts'
import type { BridgeSink } from '../src/host-bridge.ts'

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
