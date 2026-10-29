import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantStream, MAX_ASSISTANT_DELTA_BYTES, type AssistantStreamDelta } from '../src/assistant-stream.ts'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge, type ApiProxyLike, type BridgeSink, type MuxFrameLike } from '../src/host-bridge.ts'

const start = (attemptId = 's:1', revision = 1) => ({ type: 'start', attemptId, revision, turn: 1, step: 1 })
const chunk = (text: string, revision = 2, index = 0, type = 'text-delta', attemptId = 's:1') =>
  ({ type: 'chunk', attemptId, revision, index, time: 100 + index, chunk: { type, text } })
const end = (outcome: object = { kind: 'committed', eventType: 'assistant/message', seq: 10 }, revision = 4, index = 2, attemptId = 's:1') =>
  ({ type: 'end', attemptId, revision, index, outcome })
const final = (seq = 10, turn = 1, step = 1) => ({ type: 'assistant/message', seq, time: 200,
  data: { turn, step, message: { content: [{ type: 'text', text: '正式答复' }] } } })

function harness() {
  const bridge = new HostBridge({} as ApiProxyLike)
  const rows: Array<{ type: string; payload: any; seq?: number }> = []
  const replayed: unknown[] = []
  const sink = (read = true): BridgeSink => ({
    push: (type, payload, seq) => rows.push({ type, payload, seq }),
    lastCursor: () => 0, replay: entries => replayed.push(...entries), replayDone() {}, resync() {},
    canReceive: scope => read && scope === 'sessions.read',
  })
  const viewer = sink()
  bridge.addSink(viewer)
  bridge.markSinkOpen(viewer, 's')
  const mux = (frame: MuxFrameLike) => (bridge as unknown as { onMuxFrame(frame: MuxFrameLike): void }).onMuxFrame(frame)
  const stream = (value: unknown, sessionId = 's', isSubagent = false) =>
    mux({ type: 'session/assistant-stream', sessionId, value, isSubagent })
  return { bridge, rows, replayed, sink, viewer, mux, stream }
}

test('50 ms window coalesces text and reasoning independently and skips non-text chunks', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const frames: AssistantStreamDelta[] = []
  const stream = new AssistantStream(frame => frames.push(frame), () => true)
  stream.accept('s', start())
  stream.accept('s', chunk('想', 2, 0, 'reasoning-delta'))
  stream.accept('s', chunk('一想', 3, 1, 'reasoning-delta'))
  stream.accept('s', chunk('答', 4, 2))
  stream.accept('s', chunk('复', 5, 3))
  stream.accept('s', chunk('隐藏参数', 6, 4, 'tool-call-delta'))
  t.mock.timers.tick(49)
  assert.deepEqual(frames.map(f => f.kind), ['stream.start'])
  t.mock.timers.tick(1)
  assert.deepEqual(frames.map(f => [f.kind, f.text]), [
    ['stream.start', ''], ['thinking.delta', '想一想'], ['message.delta', '答复'],
  ])
  assert.equal(new Set(frames.map(f => f.streamId)).size, 1)
  stream.dispose()
})

test('interleaved text and reasoning preserve Host order inside one flush window', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const frames: AssistantStreamDelta[] = []
  const stream = new AssistantStream(frame => frames.push(frame), () => true)
  stream.accept('s', start())
  stream.accept('s', chunk('正文甲', 2, 0))
  stream.accept('s', chunk('推理', 3, 1, 'reasoning-delta'))
  stream.accept('s', chunk('正文乙', 4, 2))
  t.mock.timers.tick(50)
  assert.deepEqual(frames.slice(1).map(frame => [frame.kind, frame.text]), [
    ['message.delta', '正文甲'], ['thinking.delta', '推理'], ['message.delta', '正文乙'],
  ])
  stream.dispose()
})

test('real Host order flushes tail before final, annotates its identity, and settles by seq', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  h.stream(start())
  h.stream(chunk('尚未到 50ms 的尾部'))
  h.mux({ type: 'session/event', sessionId: 's', event: final() })
  h.stream(end({ kind: 'committed', eventType: 'assistant/message', seq: 10 }, 3, 1))
  assert.deepEqual(h.rows.map(f => [f.type, f.payload.kind]), [
    ['s2c.session.delta', 'stream.start'], ['s2c.session.delta', 'message.delta'],
    ['s2c.session.event', 'message.final'], ['s2c.session.delta', 'stream.end'],
  ])
  const id = h.rows[0]!.payload.streamId
  assert.equal(h.rows[2]!.payload.data.streamId, id)
  assert.equal(h.rows[3]!.payload.streamId, id)
  assert.deepEqual(h.rows[3]!.payload.outcome, { kind: 'committed', eventType: 'assistant/message', seq: 10 })
  assert.equal(h.bridge.currentCursor(), 1)
  assert.ok(h.rows.filter(f => f.type === 's2c.session.delta').every(f => f.seq === undefined))
  h.bridge.resumeFrom(0, h.viewer)
  assert.equal(h.replayed.length, 1)
  assert.equal((h.replayed[0] as { type: string }).type, 's2c.session.event')
  t.mock.timers.tick(100)
  assert.equal(h.rows.length, 4, 'no late delta may resurrect the final row')
  h.bridge.dispose()
})

test('unrelated durable assistant messages never steal an active stream identity', () => {
  const h = harness()
  h.stream(start())
  h.stream(chunk('尾部'))
  h.mux({ type: 'session/event', sessionId: 's', event: final(8, 9, 9) })
  assert.equal(h.rows[1]!.payload.data.streamId, undefined)
  h.mux({ type: 'session/event', sessionId: 's', event: final() })
  assert.equal(h.rows[2]!.payload.kind, 'message.delta')
  assert.equal(h.rows[3]!.payload.data.streamId, h.rows[0]!.payload.streamId)
  h.bridge.dispose()
})

for (const outcome of [{ kind: 'abandoned' }, { kind: 'committed', eventType: 'assistant/attempt', seq: 7 }]) {
  test(`terminal ${JSON.stringify(outcome)} clears state even without a message.final`, t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = harness()
    h.stream(start())
    h.stream(chunk('不应遗留'))
    h.stream(end(outcome, 3, 1))
    const count = h.rows.length
    assert.deepEqual(h.rows.at(-1)!.payload.outcome, outcome)
    h.stream(chunk('过期帧', 4, 1))
    t.mock.timers.tick(100)
    assert.equal(h.rows.length, count)
    assert.equal(h.bridge.currentCursor(), 0)
    assert.equal(h.rows.some(f => f.payload.kind === 'message.delta'), outcome.kind === 'committed')
    h.bridge.dispose()
  })
}

test('instant stream stays restricted to open readable sessions and excludes subagents', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  const closed = h.sink()
  h.bridge.addSink(closed)
  const denied = h.sink(false)
  h.bridge.addSink(denied)
  h.bridge.markSinkOpen(denied, 's')
  h.bridge.markSinkOpen(h.viewer, 'worker')
  h.stream(start())
  h.stream(chunk('唯一一份'))
  t.mock.timers.tick(50)
  h.stream(start('worker:1'), 'worker', true)
  h.stream(chunk('子代理正文', 2, 0, 'text-delta', 'worker:1'), 'worker')
  t.mock.timers.tick(50)
  assert.deepEqual(h.rows.map(f => f.payload.kind), ['stream.start', 'message.delta'])
  assert.equal(h.bridge.currentCursor(), 0)
  h.bridge.resumeFrom(0, h.viewer)
  assert.deepEqual(h.replayed, [])
  h.bridge.dispose()
})

test('closing or removing the last viewer drops pending text before reopening', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const remove of [false, true]) {
    const h = harness()
    h.stream(start())
    h.stream(chunk('旧查看周期'))
    if (remove) h.bridge.removeSink(h.viewer)
    else h.bridge.markSinkClosed(h.viewer, 's')
    h.bridge.addSink(h.viewer)
    h.bridge.markSinkOpen(h.viewer, 's')
    t.mock.timers.tick(50)
    assert.equal(h.rows.length, 1)
    h.stream(chunk('重新打开后的增量', 3, 1))
    t.mock.timers.tick(50)
    assert.equal(h.rows[1]!.payload.text, '重新打开后的增量')
    h.bridge.dispose()
  }
})

test('late viewers only receive future chunks and no buffered history', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  h.bridge.markSinkClosed(h.viewer, 's')
  h.stream(start())
  h.stream(chunk('没有查看者时的文字'))
  h.bridge.markSinkOpen(h.viewer, 's')
  h.stream(chunk('现在的文字', 3, 1))
  t.mock.timers.tick(50)
  assert.deepEqual(h.rows.map(f => f.payload.text), ['现在的文字'])
  h.bridge.dispose()
})

test('dispose cancels timers; agent disposal and replacement clear abandoned attempts', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  h.stream(start())
  const firstId = h.rows[0]!.payload.streamId
  h.stream(chunk('旧文字'))
  h.mux({ type: 'session/assistant-stream-disposed', sessionId: 's' })
  assert.equal(h.rows.at(-1)!.payload.outcome.kind, 'abandoned')
  h.stream(start()) // Host replacement restarts BOTH attemptId and revision.
  assert.notEqual(h.rows.at(-1)!.payload.streamId, firstId)
  h.stream(chunk('新文字'))
  const count = h.rows.length
  h.bridge.dispose()
  t.mock.timers.tick(100)
  assert.equal(h.rows.length, count)
})

test('oversized Unicode and escaped text stays below serialized 256 KiB without broken surrogates', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  for (const text of ['深😀'.repeat(100_000), '\u0000"\\'.repeat(100_000)]) {
    const frames: AssistantStreamDelta[] = []
    const stream = new AssistantStream(f => frames.push(f), () => true)
    stream.accept('s', start())
    stream.accept('s', chunk(text))
    t.mock.timers.tick(50)
    const delta = frames[1]!
    assert.equal(delta.truncated, true)
    assert.ok(Buffer.byteLength(JSON.stringify(delta)) <= MAX_ASSISTANT_DELTA_BYTES)
    assert.doesNotMatch(delta.text, /[\uD800-\uDBFF]$/)
    stream.dispose()
  }
})

test('duplicate, stale, malformed and wrong-attempt frames never duplicate text', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const frames: AssistantStreamDelta[] = []
  const stream = new AssistantStream(f => frames.push(f), () => true)
  for (const invalid of [null, {}, { type: 'start' }, { ...start(), revision: NaN }]) stream.accept('s', invalid)
  stream.accept('s', start())
  stream.accept('s', chunk('一次'))
  stream.accept('s', chunk('一次'))
  stream.accept('s', chunk('错误尝试', 3, 1, 'text-delta', 's:old'))
  stream.accept('s', { ...chunk('错误形状', 3, 1), chunk: null })
  t.mock.timers.tick(50)
  assert.deepEqual(frames.map(f => f.text), ['', '一次'])
  stream.dispose()
})

test('stream capability probes live Host reflection and stays false on older hosts', () => {
  let typert: unknown
  const queries: unknown[] = []
  const proxy = new DshApiProxy({ get: (key: string) =>
    key === 'sessionController' ? {} : key === 'typert' ? typert : undefined,
  } as never)
  assert.equal(proxy.assistantStreamAvailable, false)
  typert = {}
  assert.equal(proxy.assistantStreamAvailable, false)
  const reflected = (services: unknown[]) => ({ getPackage: (...args: unknown[]) => {
    queries.push(args)
    return { model: { services } }
  } })
  typert = reflected([{ key: 'sessionController', types: [{ name: 'SessionPage' }] }])
  assert.equal(proxy.assistantStreamAvailable, false)
  typert = reflected([{ key: 'sessionController', types: [{ name: 'SessionAssistantStreamFrame' }] }])
  assert.equal(proxy.assistantStreamAvailable, true)
  assert.deepEqual(queries.at(-1), ['@deepseek-ai/dsh-api-session-controller', 'host'])
  typert = { getPackage: () => { throw new Error('not registered yet') } }
  assert.equal(proxy.assistantStreamAvailable, false)
})

test('adapter reads the actual {agent, frame} callback, excludes nested unwrap ambiguity, and unregisters', async () => {
  const listeners = new Map<string, (...args: any[]) => void>()
  const ctx = {
    get: (key: string) => key === 'sessionController' ? {} : undefined,
    on: (name: string, listener: (...args: any[]) => void) => {
      listeners.set(name, listener)
      return () => { listeners.delete(name) }
    },
  }
  const proxy = new DshApiProxy(ctx as never)
  const controller = new AbortController()
  const iterator = proxy.events.mux({ rpcId: 'test' }, controller.signal)[Symbol.asyncIterator]()
  const first = iterator.next()
  const agent = { session: { id: 'worker', header: { origin: 'subagent' } } }
  const frame = start('worker:1')
  listeners.get('agent/assistant-stream')!({ agent, frame })
  assert.deepEqual((await first).value, {
    type: 'session/assistant-stream', sessionId: 'worker', isSubagent: true, value: frame,
  })
  const disposed = iterator.next()
  listeners.get('agent/disposed')!({ agent })
  assert.deepEqual((await disposed).value, { type: 'session/assistant-stream-disposed', sessionId: 'worker' })
  controller.abort()
  assert.equal((await iterator.next()).done, true)
  assert.equal(listeners.size, 0)
})
