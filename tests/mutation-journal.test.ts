/**
 * mutation journal（DispatchJournal + scheduleMutationCodec）的覆盖。
 *
 * 盘点发现迁移前 mutation 侧只有一个内存用例，持久化 reload、persistValues、
 * unhealthy、过期、容量、validSendId 守卫、并发 in-flight 全部无覆盖——
 * 这些分支现在由 dispatch-journal 的核心统一实现，因此逐条补上。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DispatchJournal,
  openDispatchJournal,
  scheduleMutationCodec,
  type MutationDispatchResult,
} from '../src/dispatch-journal.ts'

const id = (time = Date.now()) => `${time}-${randomUUID()}`
const RETENTION_MS = 7 * 24 * 3600 * 1000

/** mutation 实例：request 即内容，与 host-bridge 的三个调用点一致。 */
function makeJournal(path?: string, persistValues = false): DispatchJournal<unknown, MutationDispatchResult<unknown>> {
  return new DispatchJournal({
    path,
    codec: scheduleMutationCodec(persistValues),
    joinInFlight: false,
    maxFileBytes: 4 * 1024 * 1024,
  })
}

test('duplicate id replays without re-running; changed content is rejected', async () => {
  const journal = makeJournal()
  const sendId = id()
  let calls = 0
  const run = async () => { calls += 1; return { ok: true as const, value: { sessionId: 's' } } }
  const first = await journal.dispatch('device', sendId, { sessionId: 's' }, run)
  const second = await journal.dispatch('device', sendId, { sessionId: 's' }, run)
  assert.deepEqual(first, { ok: true, value: { sessionId: 's' } }, '首次执行不标 replayed')
  assert.deepEqual(second, { ok: true, value: undefined, replayed: true }, '重放时 value 不落盘即消失')
  assert.equal(calls, 1)
  const changed = await journal.dispatch('device', sendId, { sessionId: 's', id: 'other' }, run)
  assert.deepEqual(changed, { ok: false, code: 'E_PROTOCOL', message: 'clientRequestId was reused with different content', replayed: true })
})

test('rejected operation persists its code and replays it', async () => {
  const journal = makeJournal()
  const sendId = id()
  const first = await journal.dispatch('device', sendId, { sessionId: 's' }, async () => ({ ok: false as const, code: 'E_BUSY', message: 'busy' }))
  assert.deepEqual(first, { ok: false, code: 'E_BUSY', message: 'busy' })
  const replay = await journal.dispatch('device', sendId, { sessionId: 's' }, async () => ({ ok: true as const, value: 1 }))
  assert.deepEqual(replay, { ok: false, code: 'E_BUSY', replayed: true })
})

test('invalid clientRequestId is refused before anything is persisted', async () => {
  const journal = makeJournal()
  let calls = 0
  const result = await journal.dispatch('device', 'not-a-send-id', { sessionId: 's' }, async () => { calls += 1; return { ok: true as const, value: 1 } })
  assert.deepEqual(result, { ok: false, code: 'E_PROTOCOL', message: 'invalid clientRequestId' })
  assert.equal(calls, 0)
})

test('operation throw keeps the entry unknown and forbids automatic retry', async () => {
  const journal = makeJournal()
  const sendId = id()
  const crashed = await journal.dispatch('device', sendId, { sessionId: 's' }, async () => { throw new Error('upstream lost') })
  assert.deepEqual(crashed, { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically' })
  const replay = await journal.dispatch('device', sendId, { sessionId: 's' }, async () => ({ ok: true as const, value: 1 }))
  assert.deepEqual(replay, { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically', replayed: true })
})

test('status survives restart; value only survives when persistValues is on', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-'))
  try {
    const memoryPath = join(root, 'memory.json')
    const persistPath = join(root, 'persist.json')
    const memoryId = id(), persistId = id()
    await makeJournal(memoryPath, false).dispatch('d', memoryId, { sessionId: 's' }, async () => ({ ok: true, value: { sessionId: 'forked' } }))
    await makeJournal(persistPath, true).dispatch('d', persistId, { sessionId: 's' }, async () => ({ ok: true, value: { sessionId: 'forked' } }))

    const memoryReplay = await makeJournal(memoryPath, false).dispatch('d', memoryId, { sessionId: 's' }, async () => ({ ok: true, value: { sessionId: 'other' } }))
    assert.deepEqual(memoryReplay, { ok: true, value: undefined, replayed: true }, '不落 value 的变体重放时丢掉它')

    const persistReplay = await makeJournal(persistPath, true).dispatch('d', persistId, { sessionId: 's' }, async () => ({ ok: true, value: { sessionId: 'other' } }))
    assert.deepEqual(persistReplay, { ok: true, value: { sessionId: 'forked' }, replayed: true }, 'fork 变体必须跨重启重放 sessionId')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('unknown status replays as E_INTERNAL after a restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-unknown-'))
  try {
    const path = join(root, 'journal.json')
    const sendId = id()
    const journal = makeJournal(path, true)
    await journal.dispatch('d', sendId, { sessionId: 's' }, async () => { throw new Error('lost upstream reply') })
    const restarted = makeJournal(path, true)
    const replay = await restarted.dispatch('d', sendId, { sessionId: 's' }, async () => ({ ok: true, value: 1 }))
    assert.deepEqual(replay, { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically', replayed: true })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('expired ids, corrupt storage and unwritable directories never invoke upstream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-guard-'))
  try {
    let calls = 0
    const run = async () => { calls += 1; return { ok: true as const, value: 1 } }
    const expired = await makeJournal().dispatch('d', id(Date.now() - RETENTION_MS - 1000), { sessionId: 's' }, run)
    assert.deepEqual(expired, { ok: false, code: 'E_PROTOCOL', message: 'clientRequestId is outside the retry window' })

    const path = join(root, 'journal.json')
    writeFileSync(path, '[[[not a journal]]]')
    const corrupt = await makeJournal(path).dispatch('d', id(), { sessionId: 's' }, run)
    assert.deepEqual(corrupt, { ok: false, code: 'E_INTERNAL', message: 'mutation journal unavailable' })

    const blocked = join(root, 'not-directory')
    writeFileSync(blocked, 'file')
    // 路径不存在时加载被跳过，失败发生在首次预约写盘：消息与「文件损坏」不同。
    const unwritable = await makeJournal(join(blocked, 'journal')).dispatch('d', id(), { sessionId: 's' }, run)
    assert.deepEqual(unwritable, { ok: false, code: 'E_INTERNAL', message: 'mutation journal could not persist the request' })
    assert.equal(calls, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a concurrent duplicate is told the outcome is unknown, not run twice', async () => {
  const journal = makeJournal()
  const sendId = id()
  let calls = 0
  let finish!: () => void
  const wait = new Promise<void>((resolve) => { finish = resolve })
  const operation = async () => { calls += 1; await wait; return { ok: true as const, value: 1 } }
  const first = journal.dispatch('d', sendId, { sessionId: 's' }, operation)
  // 在途期间到达的重复：条目已预留为 unknown，重放即「不得自动重试」。
  const second = await journal.dispatch('d', sendId, { sessionId: 's' }, operation)
  assert.deepEqual(second, { ok: false, code: 'E_INTERNAL', message: 'mutation outcome is unknown; do not retry automatically', replayed: true })
  finish()
  assert.deepEqual(await first, { ok: true, value: 1 })
  assert.equal(calls, 1, '上游只跑一次')
})

test('the opener keys on path plus codec identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mutation-opener-'))
  try {
    const path = join(root, 'journal.json')
    const open = (persistValues: boolean) => openDispatchJournal({
      path,
      codec: scheduleMutationCodec(persistValues),
      joinInFlight: false,
      maxFileBytes: 4 * 1024 * 1024,
    })
    const memory = open(false)
    assert.equal(open(false), memory, '同路径同身份必须单例')
    assert.notEqual(open(true), memory, 'persistValues 不同必须是不同实例（迁移前键里只有 path，会复用错实例）')
    assert.notEqual(
      openDispatchJournal({ codec: scheduleMutationCodec(false), joinInFlight: false }),
      openDispatchJournal({ codec: scheduleMutationCodec(false), joinInFlight: false }),
      '无路径时每次新建',
    )
  } finally { rmSync(root, { recursive: true, force: true }) }
})
