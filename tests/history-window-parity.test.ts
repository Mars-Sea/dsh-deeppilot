/**
 * 历史分页窗口的差分基线。
 *
 * `dsh-api-proxy.ts` 的 history 适配器里那段「按块累积 → 投影够了就停 → 从头
 * 裁剪」的循环，是 session 历史分页策略的属主，却住在 host adapter 里：它与
 * 自己依赖的投影规则（projectHistory）分居两地，每轮还对累计窗口重跑一次投影
 * （稀疏投影时最坏 O(N²/L)）。盘点还确认 `projectHistory` 是顺序依赖的——
 * tool/call 与 tool/result 靠 toolByCall 配对，因此「从后往前取末尾 L 条」
 * 并不等价于现算法。
 *
 * 本文件把现算法逐字抄成 `legacyWindow`，用确定性随机事件流驱动它并固化输出。
 * 新实现（historyWindow）必须在这份语料上逐条一致——尤其是会切断 call/result
 * 配对与触发过冲裁剪的边界。
 *
 * 两种模式：`RECORD=1` 写快照；默认读快照比对。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { historyWindow, projectHistory, type HistoryWindow } from '../src/host-event-projection.ts'

const SNAPSHOT = new URL('./history-window-parity.snapshot.json', import.meta.url)
const RECORD = process.env.RECORD === '1'

interface RawEvent {
  type: string
  seq: number
  time?: number
  data?: unknown
}

/** 确定性 PRNG：同一份语料每次运行完全一致。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const EVENT_KINDS = [
  'user/message',
  'assistant/message',
  'assistant/chunk',
  'tool/call',
  'tool/result',
  'system/message',
  'turn/start',
  'turn/end',
  'unknown/kind',
] as const

/**
 * 造一条原始事件。刻意覆盖三类危险形状：
 * - 空投影事件（system/turn/chunk）与有投影事件相邻；
 * - tool/call 与 tool/result 成对、拆开、或只有其一；
 * - 重复 seq 与缺字段的脏事件。
 */
function makeEvent(random: () => number, index: number): unknown {
  const roll = random()
  if (roll < 0.04) return { type: 'user/message' }              // 缺 seq
  if (roll < 0.07) return null                                   // 非对象
  if (roll < 0.10) return { type: 'not-an-object', seq: index }  // data 缺省
  const kind = EVENT_KINDS[Math.floor(random() * EVENT_KINDS.length)]!
  const seq = random() < 0.08 ? Math.max(1, index - 1) : index   // 偶发重复 seq
  const base = { type: kind, seq, time: 1_700_000_000_000 + index }
  if (kind === 'user/message') return { ...base, data: { kind: 'user', text: 'u' + index } }
  if (kind === 'assistant/message') {
    // 一半是空 assistant（投影被跳过），一半有正文。
    return random() < 0.5 ? { ...base, data: { text: '' } } : { ...base, data: { text: 'a' + index } }
  }
  if (kind === 'assistant/chunk') return { ...base, data: { kind: 'text', text: 'c' + index } }
  if (kind === 'tool/call') return { ...base, data: { name: 'bash', arguments: '{}', callId: 'c' + index } }
  if (kind === 'tool/result') {
    const data: Record<string, unknown> = { message: { content: 'ok' } }
    // 六成指向「前一个 call」，四成指向不存在的 call（退化为独立 result 行）。
    if (random() < 0.6) data.callId = 'c' + String(Math.max(1, index - 1))
    else data.callId = 'c-missing-' + index
    return { ...base, data }
  }
  return { ...base, data: {} }
}

/** 被测实现：默认新 historyWindow；LEGACY=1 时跑抄下来的旧算法。 */
function underTest(source: RawEvent[], before: number | undefined, limit: number): { events: Array<{ event: RawEvent }>; hasMore: boolean } {
  if (process.env.LEGACY === '1') return legacyWindow(source, before, limit)
  return historyWindow(source, { beforeSeq: before, limit })
}

/** 现算法，逐字抄自 dsh-api-proxy.ts 的 sessions.history。 */
function legacyWindow(source: RawEvent[], before: number | undefined, limit: number): HistoryWindow {
  const filtered = source
    .filter((event): event is RawEvent =>
      typeof event === 'object' && event !== null
      && typeof (event as { type?: unknown }).type === 'string'
      && typeof (event as { seq?: unknown }).seq === 'number')
    .filter((event) => before === undefined || event.seq < before)
  let end = filtered.length
  let events: HistoryWindow['events'] = []
  while (end > 0 && projectHistory(events).length < limit) {
    const start = Math.max(0, end - limit)
    events = [
      ...filtered.slice(start, end).map((event) => ({ event })),
      ...events,
    ]
    end = start
  }
  let trimmed = false
  while (events.length > 0 && projectHistory(events).length > limit) {
    events = events.slice(1)
    trimmed = true
  }
  return { events, hasMore: end > 0 || trimmed }
}

interface Case {
  label: string
  source: unknown[]
  before: number | undefined
  limit: number
}

/** 语料：若干条随机事件流 × 若干 (beforeSeq, limit) 组合。 */
function buildCases(): Case[] {
  const cases: Case[] = []
  const sizes = [0, 1, 2, 3, 5, 8, 13, 21, 40]
  const limits = [1, 2, 3, 5, 8]
  for (const [streamIndex, size] of sizes.entries()) {
    const random = makeRandom(1000 + streamIndex * 7919)
    const source: unknown[] = []
    for (let index = 1; index <= size; index += 1) source.push(makeEvent(random, index))
    for (const limit of limits) {
      cases.push({ label: `s${size}-l${limit}-all`, source, before: undefined, limit })
      if (size > 2) {
        cases.push({ label: `s${size}-l${limit}-b${Math.ceil(size / 2)}`, source, before: Math.ceil(size / 2), limit })
      }
    }
  }
  return cases
}

/**
 * 输出签名：可观测契约 = 窗口投影出的消息行 + hasMore。
 *
 * 刻意不记录窗口的原始下标：旧算法按 limit 整数倍从末端取块，窗口里会多带若干
 * 投影为空的前导事件，而新实现按消息归属取起点。两者投影出的消息完全相同，
 * 原始下标是是实现细节。hasMore 的语义按用户选定的 A 收敛为「窗口之前还有能
 * 产出消息的事件」。
 */
function signature(result: HistoryWindow): Record<string, unknown> {
  return {
    hasMore: result.hasMore,
    messages: projectHistory(result.events).map((message) => ({
      seq: message.seq,
      role: message.role,
      ...(message.tool !== undefined ? { tool: { name: message.tool.name, state: message.tool.state } } : {}),
    })),
  }
}

test('历史分页窗口与固化快照一致', async (t) => {
  const cases = buildCases()
  const actual = cases.map((testCase) => ({
    label: testCase.label,
    ...signature(underTest(testCase.source as RawEvent[], testCase.before, testCase.limit)),
  }))

  if (RECORD || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 1) + '\n')
    t.diagnostic('history window baseline written: ' + actual.length + ' cases')
    return
  }

  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as unknown[]
  assert.equal(actual.length, expected.length, '语料规模必须一致')
  for (const [index, want] of expected.entries()) {
    await t.test(cases[index]!.label, () => assert.deepEqual(actual[index], want))
  }
})
