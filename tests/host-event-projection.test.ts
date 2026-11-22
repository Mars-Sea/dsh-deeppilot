/** Event and history projection boundaries for the mobile bridge. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MESSAGE_PROJECTION_BYTES,
  normalizePageLimit,
  projectEvent,
  projectHistory,
  retryActivityText,
  turnEndFailureText,
} from '../src/host-event-projection.ts'
import { incrementalTail } from '../src/host-bridge.ts'

const event = (seq: number, type: string, data?: unknown): unknown => ({ type, seq, time: 1, data })

const assistant = (seq: number, text: string) => event(seq, 'assistant/message', { text })
const toolCall = (seq: number, callId: string) => event(seq, 'tool/call', { name: 'bash', arguments: '{}', callId })
const toolResult = (seq: number, callId: string) => event(seq, 'tool/result', { callId, message: { content: 'ok' } })

test('an isolated tool/call row stays running until its result arrives', () => {
  const messages = projectHistory([{ event: toolCall(1, 'c1') } as never])
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.tool?.state, 'running')
  assert.equal(messages[0]!.tool?.name, 'bash')
})

test('a result whose call is outside the window degrades to a standalone row', () => {
  const messages = projectHistory([{ event: toolResult(2, 'c-outside') } as never])
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.tool?.name, 'result')
  assert.equal(messages[0]!.tool?.state, 'ok')
})

test('normalizePageLimit mirrors the wire validator', () => {
  assert.equal(normalizePageLimit(undefined), 100)
  assert.equal(normalizePageLimit(0), 1)
  assert.equal(normalizePageLimit(-3), 1)
  assert.equal(normalizePageLimit(900), 500)
  assert.equal(normalizePageLimit(250), 250)
  assert.equal(normalizePageLimit('nope'), 100)
})

test('duplicate seqs keep the last projection', () => {
  const source = [assistant(1, 'first'), assistant(1, 'second')]
  const messages = projectHistory([{ event: source[1] } as never, { event: source[0] } as never])
  assert.equal(messages.length, 1, '同一 seq 只保留一条')
})

// ---------- 增量 tail（能力 incrementalTail） ----------

const incrementalEvents = [
  { event: { type: 'user/message', seq: 1, data: '问题' } },
  { event: { type: 'assistant/message', seq: 2, data: { text: '先看看' } } },
  { event: { type: 'tool/call', seq: 3, data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'c1' } } },
  { event: { type: 'turn/start', seq: 4, data: {} } },
  { event: { type: 'tool/result', seq: 5, data: { callId: 'c1', message: { content: 'ok' } } } },
  { event: { type: 'assistant/message', seq: 6, data: { text: '完成' } } },
] as any[]

function deltaFor(sinceSeq: number) {
  const touched = new Map<number, number>()
  const projected = projectHistory(incrementalEvents, touched)
  return incrementalTail(incrementalEvents, projected, touched, sinceSeq)
}

test('incremental tail includes rows after sinceSeq and older tool rows completed after it', () => {
  const delta = deltaFor(4)!
  assert.deepEqual(delta.map((m) => m.seq), [3, 6], 'tool call 3 changed at seq 5; assistant 6 is new')
  assert.equal(delta[0]!.tool?.state, 'ok')
})

test('incremental tail is empty when nothing changed after sinceSeq', () => {
  assert.deepEqual(deltaFor(6), [])
})

test('incremental tail falls back to a full tail when completeness cannot be proven', () => {
  assert.equal(deltaFor(0), undefined, 'window starts after sinceSeq: events in between may be missing')
  assert.equal(deltaFor(7), undefined, 'client claims a seq the host never produced')
  assert.equal(incrementalTail([], [], new Map(), 3), undefined)
})

const askCall = {
  type: 'tool/call', seq: 18, time: 1700,
  data: {
    callId: 'ask-1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [
      { id: 'options', question: 'Which login methods?' },
      { id: 'notes', question: 'Any notes?' },
      { id: 'optional', question: 'Anything else?' },
    ] }),
  },
}
const askAnswers = [
  { id: 'optional', selected: [] },
  { id: 'notes', selected: [], custom: 'Keep the email.\n\nAdd a retry.' },
  { id: 'options', selected: ['Email', 'Apple'] },
]
const askResult = {
  type: 'tool/result', seq: 20, time: 1800,
  data: { message: { toolCallId: 'ask-1', content: [{ type: 'text', text: JSON.stringify({ answers: askAnswers }) }] } },
}
const expectedResponse = { items: [
  { ...askAnswers[2], question: 'Which login methods?' },
  { ...askAnswers[1], question: 'Any notes?' },
  { ...askAnswers[0], question: 'Anything else?' },
] }

test('answered DSH questions use the result sequence and keep original question order and text', () => {
  const live = projectEvent('s1', askResult, askCall)
  assert.equal(live?.kind, 'tool.end')
  assert.equal(live?.data.seq, 20)
  assert.equal(live?.data.callId, 'ask-1')
  assert.deepEqual(live?.data.questionResponse, expectedResponse)
  const history = projectHistory([{ event: askCall }, { event: askResult }])
  assert.deepEqual(history.map(row => row.seq), [18, 20])
  assert.equal(history[0]?.tool?.state, 'ok')
  assert.equal(history[1]?.ts, live?.data.ts)
  assert.deepEqual(history[1]?.questionResponse, expectedResponse)

})

test('late replies keep their native admission seq and do not project as normal prompts', () => {
  const lateReply = {
    type: 'user/message', seq: 27, time: 1900,
    data: { message: {
      source: { kind: 'user-question-reply', callId: 'ask-1', outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({
        kind: 'answer_to_pending_question', callId: 'ask-1', tool: 'ask_user_question',
        answers: askAnswers, questions: JSON.parse(askCall.data.arguments).questions,
      }) }],
    } },
  }
  const live = projectEvent('s1', lateReply)
  assert.equal(live?.kind, 'tool.end')
  assert.deepEqual(live?.data.questionResponse, expectedResponse)
  const [row] = projectHistory([{ event: lateReply }])
  assert.equal(row?.seq, 27)
  assert.equal(row?.role, 'tool')
  assert.deepEqual(row?.questionResponse, expectedResponse)
})

test('failed, pending or unrelated tools do not produce answered question rows', () => {
  const other = { ...askCall, data: { ...askCall.data, name: 'other-tool' } }
  const failed = { ...askResult, data: { message: { ...askResult.data.message, isError: true } } }
  const pending = { ...askResult, data: { message: { ...askResult.data.message,
    content: JSON.stringify({ pending: true, answers: askAnswers }),
  } } }
  for (const [call, result] of [[other, askResult], [askCall, failed], [askCall, pending]] as const) {
    assert.equal(projectHistory([{ event: call }, { event: result }]).some(row => row.questionResponse), false)
  }
})

test('oversized question answers fit the projection and retain a prefix', () => {
  const fullText = '你🪴"\n'.repeat(70_000)
  const result = { ...askResult, data: { message: { ...askResult.data.message,
    content: JSON.stringify({ answers: [{ id: 'notes', selected: [], custom: fullText }] }),
  } } }
  const row = projectHistory([{ event: askCall }, { event: result }]).at(-1)!
  assert.equal(row.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(row), 'utf8') <= MAX_MESSAGE_PROJECTION_BYTES)
  const text = row.questionResponse?.items[0]?.custom ?? ''
  assert.ok(text.length > 0 && text.length < fullText.length && fullText.startsWith(text))
  const live = projectEvent('s1', result, askCall)
  assert.equal(live?.data.truncated, true)
  assert.deepEqual(live?.data.questionResponse, row.questionResponse)
})

test('turn/end error projects Chinese failure text with original code into both live event and history', () => {
  const errEvent = {
    type: 'turn/end',
    seq: 9,
    time: 1234,
    data: {
      turn: 1,
      reason: {
        kind: 'error',
        error: { code: 'SERVER', message: '502 Bad Gateway' },
      },
    },
  }
  const live = projectEvent('s1', errEvent)
  assert.deepEqual(live, {
    kind: 'turn.end',
    data: {
      ok: false,
      text: '上游模型服务异常：502 Bad Gateway（SERVER）',
      ts: 1234,
    },
  })
  const history = projectHistory([{ event: errEvent }])
  assert.deepEqual(history, [{
    seq: 9,
    ts: 1234,
    role: 'error',
    text: '上游模型服务异常：502 Bad Gateway（SERVER）',
  }])

  // 用户主动停止不生成聊天时间线错误行
  const userAborted = {
    type: 'turn/end',
    seq: 10,
    time: 1235,
    data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  }
  assert.equal(turnEndFailureText(userAborted.data), undefined)
  assert.deepEqual(projectHistory([{ event: userAborted }]), [])
})

test('retryActivityText formats llm/retry progress and failure reason within 160 code points', () => {
  const text = retryActivityText({
    retry: 2,
    maxRetries: 5,
    mode: 'normal',
    failure: { code: 'RATE_LIMIT', message: '429 Too Many Requests' },
  })
  assert.equal(text, '正在重试模型请求（2/5）：请求频率超限或并发受限：429 Too Many Requests（RATE_LIMIT）')
})
