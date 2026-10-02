/**
 * host-event-projection 的边界用例。
 *
 * 重点覆盖盘点确认过的缺口：孤立 tool/call 行保持 running、过冲裁剪、
 * 页大小下限、beforeSeq 裁剪、脏事件过滤，以及 hasMore 的新语义（窗口起点
 * 之前只剩投影为空的事件时为 false，客户端不会收到空页）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  historyWindow,
  normalizePageLimit,
  projectHistory,
} from '../src/host-event-projection.ts'

const event = (seq: number, type: string, data?: unknown): unknown => ({ type, seq, time: 1, data })

const userMessage = (seq: number) => event(seq, 'user/message', { kind: 'user', text: 'u' + seq })
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

test('window keeps enough context to pair a call with its result', () => {
  // call 在 result 前一条：窗口必须把 call 一起带上，否则 result 会退化为独立行。
  const source = [assistant(1, 'a'), toolCall(2, 'c1'), toolResult(3, 'c1'), userMessage(4)]
  const window = historyWindow(source, { limit: 1 })
  const messages = projectHistory(window.events as never)
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.seq, 4, '只要最后一条消息')
  // 再要一条：call+result 必须成对出现，而不是两个独立行。
  const two = historyWindow(source, { limit: 2 })
  const twoMessages = projectHistory(two.events as never)
  assert.deepEqual(twoMessages.map((m) => [m.seq, m.tool?.name, m.tool?.state]), [
    [2, 'bash', 'ok'],
    [4, undefined, undefined],
  ])
  assert.equal(two.hasMore, true, 'seq 1 的 assistant 还在窗口之前')
})

test('a nonsense limit falls back to the default page size, not to NaN slicing', () => {
  const source = [userMessage(1), userMessage(2)]
  for (const limit of [0, -5]) {
    const window = historyWindow(source, { limit })
    assert.equal(projectHistory(window.events as never).length, 1, 'limit=' + String(limit))
  }
  for (const limit of [NaN, Infinity, 'nope', 0.5]) {
    const window = historyWindow(source, { limit: limit as number })
    assert.equal(projectHistory(window.events as never).length, 2, 'limit=' + String(limit) + ' 回落默认页大小')
  }
})

test('beforeSeq is exclusive and filters unprojectable events', () => {
  const source = [
    null,                                   // 非对象
    { type: 'user/message' },               // 缺 seq
    userMessage(1),
    event(2, 'weird/kind'),
    userMessage(3),
  ]
  const all = historyWindow(source, { limit: 10 })
  assert.deepEqual(all.events.map((entry) => entry.event.seq), [1, 2, 3])
  assert.equal(all.hasMore, false)
  const page = historyWindow(source, { beforeSeq: 3, limit: 10 })
  assert.deepEqual(page.events.map((entry) => entry.event.seq), [1, 2], 'beforeSeq 是排他的')
  assert.equal(page.hasMore, false)
})

test('hasMore is false when only empty-projection events remain before the window', () => {
  // 窗口之前只剩 system/message 与 turn/*：旧实现会报 true，让客户端多跑一趟空页。
  const source = [event(1, 'system/message'), event(2, 'turn/start'), userMessage(3)]
  const window = historyWindow(source, { limit: 1 })
  assert.deepEqual(projectHistory(window.events as never).map((m) => m.seq), [3])
  assert.equal(window.hasMore, false, '没有更多可投影的历史，不应让客户端翻空页')
})

test('hasMore is true when a real message remains before the window', () => {
  const source = [userMessage(1), event(2, 'system/message'), userMessage(3)]
  const window = historyWindow(source, { limit: 1 })
  assert.deepEqual(window.events.map((entry) => entry.event.seq), [3])
  assert.equal(window.hasMore, true)
})

test('empty and single-event sources', () => {
  assert.deepEqual(historyWindow([], { limit: 10 }), { events: [], hasMore: false })
  const one = historyWindow([userMessage(7)], { limit: 10 })
  assert.equal(one.events.length, 1)
  assert.equal(one.hasMore, false)
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
  const window = historyWindow(source, { limit: 1 })
  assert.equal(projectHistory(window.events as never).length, 1)
})
