import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionEventLike } from '../src/host-api.ts'
import { incrementalTail } from '../src/host-bridge.ts'
import { eventImageRefs, projectEvent, projectHistory } from '../src/host-event-projection.ts'

const image = { attachmentId: 'result-image', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
const content = [{ type: 'text', text: 'result text' }, { type: 'image', attachment: image }]
const call: SessionEventLike = {
  type: 'tool/call', seq: 1, time: 1,
  data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"example.txt"}' },
}

const cases = [
  { name: 'native success', failed: false, data: { message: { toolCallId: 'call-1', isError: false, content } } },
  { name: 'native failure without error metadata', failed: true, data: { message: { toolCallId: 'call-1', isError: true, content } } },
  { name: 'native failure with error metadata', failed: true, data: { message: { toolCallId: 'call-1', isError: true, content }, error: { name: 'ToolError', code: 'TOOL_FAILED' } } },
  { name: 'legacy success', failed: false, data: { callId: 'call-1', message: { content } } },
  { name: 'legacy failure', failed: true, data: { callId: 'call-1', message: { content }, error: { message: 'failed' } } },
  { name: 'legacy failure metadata with isError false', failed: true, data: { callId: 'call-1', message: { isError: false, content }, error: { message: 'failed' } } },
]

for (const scenario of cases) {
  test(`${scenario.name}: live, history, incremental tail and image access agree`, () => {
    const result: SessionEventLike = {
      type: 'tool/result', seq: 2, time: 2,
      data: { turn: 1, step: 1, ...scenario.data },
    }
    const live = projectEvent('session-1', result)!
    assert.equal(live.kind, 'tool.end')
    assert.equal(live.data.callId, 'call-1')
    assert.equal(live.data.ok, !scenario.failed)
    assert.equal(live.data.summary, scenario.failed ? '失败' : 'result text')
    assert.equal(Boolean(live.data.attachments), !scenario.failed)

    const entries = [{ event: call }, { event: result }]
    const touched = new Map<number, number>()
    const history = projectHistory(entries, touched)
    assert.equal(history.length, 1, 'the result completes the original call without a second row')
    assert.equal(history[0]!.seq, 1)
    assert.equal(history[0]!.tool?.name, 'read')
    assert.equal(history[0]!.tool?.state, scenario.failed ? 'error' : 'ok')
    assert.equal(history[0]!.tool?.summary, scenario.failed ? '失败' : 'result text')
    assert.deepEqual(history[0]!.tool?.target, { kind: 'path', value: 'example.txt' })
    assert.equal(Boolean(history[0]!.attachments), !scenario.failed)
    assert.equal(touched.get(1), 2, 'a result changes the earlier call row')
    assert.deepEqual(incrementalTail(entries, history, touched, 1), history)
    assert.deepEqual(eventImageRefs(result), scenario.failed ? [] : [image])
  })
}

test('native result identity wins over a stale legacy call id', () => {
  const result: SessionEventLike = {
    type: 'tool/result', seq: 3,
    data: { callId: 'stale-call', message: { toolCallId: 'call-1', content } },
  }
  const staleCall: SessionEventLike = { ...call, seq: 2, data: { callId: 'stale-call', name: 'write', arguments: '{}' } }
  assert.equal(projectEvent('session-1', result)!.data.callId, 'call-1')
  const history = projectHistory([{ event: call }, { event: staleCall }, { event: result }])
  assert.deepEqual(history.map(row => [row.tool?.name, row.tool?.state]), [['read', 'ok'], ['write', 'running']])
})

test('a native failure outside the history window remains a failed standalone result', () => {
  const result: SessionEventLike = {
    type: 'tool/result', seq: 2,
    data: { message: { toolCallId: 'outside-call', isError: true, content } },
  }
  const history = projectHistory([{ event: result }])
  assert.equal(history.length, 1)
  assert.equal(history[0]!.tool?.name, 'result')
  assert.equal(history[0]!.tool?.state, 'error')
  assert.equal(history[0]!.attachments, undefined)
})

test('a native result without identity does not invent a live call id', () => {
  const result: SessionEventLike = { type: 'tool/result', seq: 2, data: { message: { isError: true, content } } }
  const live = projectEvent('session-1', result)!
  assert.equal(live.data.ok, false)
  assert.equal(Object.hasOwn(live.data, 'callId'), false)
})
