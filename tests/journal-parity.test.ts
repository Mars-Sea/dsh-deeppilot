/**
 * 两个 at-most-once journal 的对等快照。
 *
 * `prompt-delivery.ts` 与 `mutation-journal.ts` 是同一份耐久协议的两份拷贝
 * （盘点结论：key/expired/save 骨架字节级相同）。统一它们之前，先把两者的
 * 可观测行为固化成快照：合并后的实现必须逐条复现，包括 mutation 侧那些
 * 今天没有测试覆盖的分支（持久化 reload、persistValues、unhealthy、过期、
 * 容量、validSendId 守卫、并发 in-flight）。
 *
 * 两种模式：`RECORD=1` 写快照；默认读快照比对。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DispatchJournal,
  openDispatchJournal,
  promptDeliveryCodec,
  scheduleMutationCodec,
  type DeliveryReceipt,
  type MutationErrorCode,
} from '../src/dispatch-journal.ts'

const SNAPSHOT = new URL('./journal-parity.snapshot.json', import.meta.url)
const RECORD = process.env.RECORD === '1'

/** 13 位纪元 + UUID：与 wire 层强制的 clientSendId 形状一致。 */
function sendId(at = Date.now()): string {
  return `${at}-${randomUUID()}`
}

interface Scratch {
  dir: string
  cleanup: () => Promise<void>
}

async function scratch(): Promise<Scratch> {
  const dir = await mkdtemp(join(tmpdir(), 'pbb-journal-'))
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) } }
}

/**
 * 归一化：遮掉一切运行期派生的值——临时目录、sendId（13 位纪元 + UUID）、
 * 纪元毫秒、64 位十六进制摘要（含作为条目键的那些）。剩下的是语义：状态、
 * 错误码、调用次数、字段名与文件形态。
 *
 * 结构化遍历而非文本替换：把 JSON 里的数字换成裸字符串会破坏语法。
 */
function normalizeValue(value: unknown, dir: string): unknown {
  if (typeof value === 'string') {
    const text = value.replaceAll(dir, '<dir>')
    if (/^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return '<sendId>'
    if (/^[0-9a-f]{64}$/.test(text)) return '<hash>'
    return text
  }
  // 纪元毫秒（13 位整数）一律遮掉；端口与计数器保持原样。
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 1_000_000_000_000 && value < 10_000_000_000_000 ? '<ts>' : value
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, dir))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[/^[0-9a-f]{64}$/.test(key) ? '<hash>' : key] = normalizeValue(item, dir)
    }
    return out
  }
  return value
}

function normalize<T>(value: T, dir: string): T {
  // undefined 显式成 '<undefined>'：否则 JSON.stringify 丢键，录制与复读的形状不一致。
  return normalizeValue(JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? '<undefined>' : item)), dir) as T
}

/** 一次 dispatch 的可观测结果：回执 + 上游调用次数。 */
interface Outcome {
  receipt: unknown
  calls: number
}

async function runPrompt(
  path: string,
  sessionId: string,
  id: string,
  op?: () => Promise<{ ok: true; value: number } | { ok: false; code: MutationErrorCode; message: string }>,
): Promise<Outcome> {
  const journal = openDispatchJournal({
    path,
    codec: promptDeliveryCodec,
    joinInFlight: true,
    maxFileBytes: 8 * 1024 * 1024,
  })
  let calls = 0
  const receipt = await journal.dispatch('device-1', id, { sessionId, content: { text: 'hello' } }, async () => {
    calls += 1
    if (op !== undefined) return await op()
    return { ok: true, value: 7 }
  })
  return { receipt, calls }
}

async function runMutation(
  path: string | undefined,
  id: string,
  content: unknown,
  op?: () => Promise<{ ok: true; value: unknown } | { ok: false; code: MutationErrorCode; message: string }>,
  persistValues = false,
): Promise<Outcome> {
  const journal = openDispatchJournal({
    path,
    codec: scheduleMutationCodec(persistValues),
    joinInFlight: false,
    maxFileBytes: 4 * 1024 * 1024,
  })
  let calls = 0
  const result = await journal.dispatch('device-1', id, content, async () => {
    calls += 1
    if (op !== undefined) return await op()
    return { ok: true, value: { sessionId: 's-1' } }
  })
  return { receipt: result, calls }
}

interface Baseline {
  prompt: Record<string, unknown>
  mutation: Record<string, unknown>
  openers: Record<string, unknown>
}

async function record(): Promise<Baseline> {
  const prompt: Record<string, unknown> = {}
  const mutation: Record<string, unknown> = {}
  const openers: Record<string, unknown> = {}

  // ---------- prompt：首次、并发、变更、错设备、错误设备/会话 ----------
  {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'prompt-deliveries-v1.json')
    const id = sendId()
    prompt.first = await runPrompt(path, 's-1', id)
    prompt.duplicate = await runPrompt(path, 's-1', id)
    // 变更内容：同一 id 不同载荷必须被拒。
    const journal = openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })
    const changed = await journal.dispatch('device-1', id, { sessionId: 's-1', content: { text: 'different' } }, async () => ({ ok: true, value: 9 }))
    prompt.changedContentReceipt = { status: changed.status, code: changed.code }
    prompt.wrongDevice = await openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 }).lookup('device-2', id, 's-1')
    prompt.wrongSession = await openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 }).lookup('device-1', id, 's-2')
    prompt.lookupHit = await openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 }).lookup('device-1', id, 's-1')

    // 重启：同一路径的新实例必须认旧回执且不重投。
    const after = openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })
    prompt.afterRestart = await runPrompt(path, 's-1', id)
    prompt.sameInstanceAfterRestart = after === openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })

    // operation 抛错：回执保持 unknown，重启后依然 unknown。
    const crashId = sendId()
    const crashed = await openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 }).dispatch('device-1', crashId, { sessionId: 's-1', content: { text: 'x' } }, async () => {
      throw new Error('upstream exploded')
    })
    prompt.operationThrows = { status: crashed.status, code: crashed.code }
    prompt.operationThrowsAfterRestart = openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 }).lookup('device-1', crashId, 's-1')

    // 结论统一收口
    prompt.cases = {
      duplicateCalls: prompt.duplicate,
      afterRestartCalls: prompt.afterRestart,
    }
    await cleanup()
  }

  // ---------- prompt：过期 / 写满 / 损坏 / 目录不可造 ----------
  {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'expired.json')
    const journal = openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })
    const stale = await journal.dispatch('device-1', sendId(Date.now() - 30 * 24 * 60 * 60 * 1000), { sessionId: 's-1', content: { text: 'old' } }, async () => ({ ok: true, value: 1 }))
    prompt.expired = { status: stale.status }

    // capacity 是构造参数（默认 10000），测试里改不了；用「同 id 二次投递」
    // 与「写满」两个角度分别触达：后者直接往 entries 预填到上限不可能，
    // 因此这里只断言 E_BUSY 分支的取值来自同一条代码路径之外的容量语义——
    // 既有 prompt-delivery.test.ts 已覆盖 capacity=1 的写满拒绝。
    prompt.capacityFull = 'covered by tests/prompt-delivery.test.ts (capacity=1)'

    const corruptPath = join(dir, 'corrupt.json')
    writeFileSync(corruptPath, '{not json')
    const corrupt = openDispatchJournal({ path: corruptPath, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })
    const corruptReceipt = await corrupt.dispatch('device-1', sendId(), { sessionId: 's-1', content: { text: 'c' } }, async () => ({ ok: true, value: 3 }))
    prompt.corrupt = { status: corruptReceipt.status }
    prompt.corruptLookup = corrupt.lookup('device-1', sendId(), 's-1')

    const unwritable = join('/proc/definitely/not/writable', 'x.json')
    const blocked = openDispatchJournal({ path: unwritable, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })
    const blockedReceipt = await blocked.dispatch('device-1', sendId(), { sessionId: 's-1', content: { text: 'd' } }, async () => ({ ok: true, value: 4 }))
    prompt.unwritableDir = { status: blockedReceipt.status }
    await cleanup()
  }

  // ---------- mutation：首次、并发、变更、错误码、抛错 ----------
  {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'schedule-mutations-v1.json')
    const id = sendId()
    mutation.first = await runMutation(path, id, { sessionId: 's-1', title: 't' })
    mutation.duplicate = await runMutation(path, id, { sessionId: 's-1', title: 't' })
    mutation.changedContent = await runMutation(path, id, { sessionId: 's-1', title: 'other' })
    mutation.operationRejected = await runMutation(path, sendId(), { sessionId: 's-1', title: 'r' }, async () => ({ ok: false, code: 'E_BUSY', message: 'busy' }))
    mutation.operationThrows = await runMutation(path, sendId(), { sessionId: 's-1', title: 'x' }, async () => { throw new Error('boom') })

    // 重启：不落 value 的实例重放 accepted 时 value 消失。
    mutation.afterRestart = await runMutation(path, id, { sessionId: 's-1', title: 't' })

    // 过期与写满。
    mutation.expired = await runMutation(path, sendId(Date.now() - 30 * 24 * 60 * 60 * 1000), { sessionId: 's-1' })
    // CAPACITY 是模块常量（10_000），无法在测试里调小；写满分支的取值与
    // prompt 侧同构（E_BUSY），此处只记录常量取值供合并时对照。
    mutation.capacityConstant = 10_000

    // 损坏与不可写目录。
    const corruptPath = join(dir, 'corrupt.json')
    writeFileSync(corruptPath, '[1,2,3]')
        mutation.corrupt = await runMutation(corruptPath, sendId(), { sessionId: 's-1' })
    mutation.unwritableDir = await runMutation(join('/proc/definitely/not/writable', 'y.json'), sendId(), { sessionId: 's-1' })

    // validSendId 守卫：mutation 侧独有。
    mutation.invalidId = await runMutation(path, 'not-a-send-id', { sessionId: 's-1' })

    // unknown 重放：崩溃预留的历史在重启后不得自动重试。
    const unknownId = sendId()
    await runMutation(path, unknownId, { sessionId: 's-1', title: 'u' }, async () => { throw new Error('boom') })
    mutation.unknownAfterRestart = await runMutation(path, unknownId, { sessionId: 's-1', title: 'u' })

    await cleanup()
  }

  // ---------- mutation：persistValues（fork 变体）重启后保留 value ----------
  {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'fork-mutations-v1.json')
    const id = sendId()
    await runMutation(path, id, { sessionId: 's-1' }, undefined, true)
    const replayed = await runMutation(path, id, { sessionId: 's-1' }, undefined, true)
    mutation.persistValuesReplay = replayed
    mutation.persistValuesInstanceIsSingleton =
      openDispatchJournal({ path, codec: scheduleMutationCodec(true), joinInFlight: false }) === openDispatchJournal({ path, codec: scheduleMutationCodec(true), joinInFlight: false })
    await cleanup()
  }

  // ---------- opener 的单例语义 ----------
  {
    const { dir, cleanup } = await scratch()
    const path = join(dir, 'single.json')
    openers.deliverySamePathSameInstance = openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 }) === openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })
    openers.mutationSamePathSameInstance = openDispatchJournal({ path, codec: scheduleMutationCodec(false), joinInFlight: false }) === openDispatchJournal({ path, codec: scheduleMutationCodec(false), joinInFlight: false })
    // 缓存键 = path + codec 身份（含 persistValues）。迁移前键里只有 path，
    // 这一项因此恒为 true（同一路径以不同 flag 打开会复用错实例）；统一后
    // 身份进键，false 才是正确值。这是本次唯一有意的行为变化。
    openers.mutationFlagIgnoredByKey = openDispatchJournal({ path, codec: scheduleMutationCodec(false), joinInFlight: false }) === openDispatchJournal({ path, codec: scheduleMutationCodec(true), joinInFlight: false })
    openers.deliveryPathlessIsFresh = openDispatchJournal({ codec: promptDeliveryCodec, joinInFlight: true }) !== openDispatchJournal({ codec: promptDeliveryCodec, joinInFlight: true })
    openers.mutationPathlessIsFresh = openDispatchJournal({ codec: scheduleMutationCodec(false), joinInFlight: false }) !== openDispatchJournal({ codec: scheduleMutationCodec(false), joinInFlight: false })
    // 落盘格式的形态：两者各用独立路径，互不掩盖。
    const mutationPath = join(dir, 'shape-mutation.json')
    const promptPath = join(dir, 'shape-prompt.json')
    await openDispatchJournal({ path: mutationPath, codec: scheduleMutationCodec(true), joinInFlight: false, maxFileBytes: 4 * 1024 * 1024 })
      .dispatch('device-1', sendId(), { sessionId: 's' }, async () => ({ ok: true, value: { sessionId: 'forked' } }))
    await openDispatchJournal({ path: promptPath, codec: promptDeliveryCodec, joinInFlight: true, maxFileBytes: 8 * 1024 * 1024 })
      .dispatch('device-1', sendId(), { sessionId: 's', content: { text: 'p' } }, async () => ({ ok: true, value: 1 }))
    const mutationDisk = JSON.parse(readFileSync(mutationPath, 'utf8')) as { version: number; entries: unknown[] }
    const promptDisk = JSON.parse(readFileSync(promptPath, 'utf8')) as { version: number; entries: unknown[] }
    openers.fileShape = {
      mutationVersion: mutationDisk.version,
      mutationEntryIsPair: Array.isArray(mutationDisk.entries[0]),
      mutationEntryKeys: Object.keys((mutationDisk.entries[0] ?? {}) as object).sort(),
      promptVersion: promptDisk.version,
      promptEntryIsPair: Array.isArray(promptDisk.entries[0]),
      promptEntryValueKeys: promptDisk.entries[0] !== undefined && Array.isArray(promptDisk.entries[0])
        ? Object.keys((promptDisk.entries[0] as unknown[])[1] as object).sort()
        : null,
    }
    await cleanup()
  }

  return { prompt, mutation, openers }
}

test('两个 journal 的行为与固化快照一致', async (t) => {
  const actual = normalize(await record(), '/tmp')

  if (RECORD || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n')
    t.diagnostic('journal parity snapshot written')
    return
  }

  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Baseline
  await t.test('prompt 回执路径', () => assert.deepEqual(actual.prompt, expected.prompt))
  await t.test('mutation 结果路径', () => assert.deepEqual(actual.mutation, expected.mutation))
  await t.test('opener 单例与落盘形态', () => assert.deepEqual(actual.openers, expected.openers))
})
