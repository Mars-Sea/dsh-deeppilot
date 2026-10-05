/**
 * 落盘跨平台行为与降级策略的回归测试（issue #20 / #26）。
 *
 * 这两条都发生在 Linux CI 上复现不出来的地方，所以走注入点而不是真去弄坏
 * 文件系统：平台差异用 `fsyncFileDescriptor` 注入点模拟，落盘时机用注入同一个
 * hook 控制——两条都仍然走真实的 fsyncDirectory（含其容忍逻辑），否则测的就
 * 是注入函数自己而不是待测代码。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  DispatchJournal,
  fsyncDirectory,
  isToleratedDirectoryFsyncError,
  openDispatchJournal,
  promptDeliveryCodec,
  type DeliveryReceipt,
} from '../src/dispatch-journal.ts'

/** 13 位纪元 + UUID：与 wire 层强制的 clientSendId 形状一致。 */
function sendId(at = Date.now()): string {
  return `${at}-${randomUUID()}`
}

async function scratch(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'pbb-dj-'))
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}) } }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code + ': simulated'), { code })
}

const op = async () => ({ ok: true as const, value: 7 })

// ---------- 目录 fsync 的容忍边界 ----------

test('目录 fsync：Windows 那三个 errno 被容忍，其余照旧抛出', () => {
  // issue #20 / #26 实测 Windows 抛 EPERM；EISDIR / EINVAL 是同一现象的变体。
  for (const code of ['EPERM', 'EISDIR', 'EINVAL']) {
    assert.equal(isToleratedDirectoryFsyncError(errno(code)), true, code)
  }
  // 真·写坏了必须照旧暴露，否则一次磁盘故障会被静默吞掉。
  for (const code of ['EIO', 'ENOSPC', 'EBADF', 'ENOTDIR']) {
    assert.equal(isToleratedDirectoryFsyncError(errno(code)), false, code)
  }
  assert.equal(isToleratedDirectoryFsyncError(new Error('boom')), false)
  assert.equal(isToleratedDirectoryFsyncError(undefined), false)
})

test('目录 fsync 在真实目录上成功（本平台支持时）', async () => {
  const { dir, cleanup } = await scratch()
  assert.doesNotThrow(() => { fsyncDirectory(dir) })
  await cleanup()
})

// ---------- #20 / #26 的主回归：Windows 上投递必须真的发生 ----------

test('目录 fsync 抛 EPERM 时投递照常发生，回执是 accepted 而不是 unknown', async () => {
  const { dir, cleanup } = await scratch()
  const path = join(dir, 'prompt-deliveries-v1.json')
  let fsyncAttempts = 0
  const journal = new DispatchJournal({
    path,
    codec: promptDeliveryCodec,
    // 模拟 Windows：目录 fd 的 fsync 抛 EPERM。
    fsyncFileDescriptor: () => { fsyncAttempts += 1; throw errno('EPERM') },
    log: () => {},
  })
  // 只替换 fd 上的 fsync 一步：EPERM 必须由真实的 fsyncDirectory 自己吞掉。
  let calls = 0
  const receipt = await journal.dispatch('device-1', sendId(), { sessionId: 's-1', content: { text: 'hi' } }, async () => {
    calls += 1
    return { ok: true as const, value: 3 }
  })
  assert.equal(fsyncAttempts, 2, '预留一次、落结果一次')
  assert.equal(calls, 1, 'operation 必须真的被调用——修复前这里是 0')
  assert.deepEqual(receipt, { clientSendId: (receipt as DeliveryReceipt).clientSendId, status: 'accepted', userSeq: 3 })
  await cleanup()
})

test('目录 fsync 抛真 errno（EIO）时仍然报错，不被静默吞掉', async () => {
  const { dir, cleanup } = await scratch()
  const journal = new DispatchJournal({
    path: join(dir, 'prompt-deliveries-v1.json'),
    codec: promptDeliveryCodec,
    fsyncFileDescriptor: () => { throw errno('EIO') },
    log: () => {},
  })
  let calls = 0
  const receipt = await journal.dispatch('device-1', sendId(), { sessionId: 's-1', content: { text: 'hi' } }, async () => {
    calls += 1
    return { ok: true as const, value: 3 }
  })
  assert.equal(calls, 0, '没落盘就不能跑上游')
  assert.equal(receipt.status, 'unknown')
  await cleanup()
})

// ---------- #26 的次生问题：healthy 曾是进程终态 ----------
//
// 这两条模拟的是**真·磁盘故障**（EIO / ENOSPC），不是 Windows 那种平台差异：
// 平台差异已被容忍、根本到不了这里，一次 save() 失败也不会再拉黑整个进程。

test('一次瞬时磁盘错误不再让整个进程永久失去投递能力', async () => {
  const { dir, cleanup } = await scratch()
  const path = join(dir, 'prompt-deliveries-v1.json')
  const logs: string[] = []
  let failNext = true
  const journal = new DispatchJournal({
    path,
    codec: promptDeliveryCodec,
    // 第一次 save 抛错，之后恢复正常。
    fsyncFileDescriptor: () => { if (failNext) { failNext = false; throw errno('ENOSPC') } },
    log: (message) => { logs.push(message) },
  })

  const first = await journal.dispatch('device-1', sendId(), { sessionId: 's-1', content: { text: 'a' } }, op)
  assert.equal(first.status, 'unknown', '首次落盘失败：上游没跑，回执 unknown')
  assert.equal(logs.length, 1, '失败必须被记录，否则又是一次无法诊断的 unknown')
  assert.match(logs[0] ?? '', /ENOSPC/)

  // 修复前 healthy 会被永久置 false，这里一路短路到 DSH 重启：
  // 永远返回 unknown，operation 永不执行。
  let calls = 0
  const second = await journal.dispatch('device-1', sendId(), { sessionId: 's-2', content: { text: 'b' } }, async () => {
    calls += 1
    return { ok: true as const, value: 11 }
  })
  assert.equal(calls, 1, '恢复后必须能真的投递')
  assert.equal(second.status, 'accepted')
  assert.equal((second as DeliveryReceipt).userSeq, 11)
  await cleanup()
})

test('磁盘持续故障时每次都如实报 unknown，而不是变成无声的成功', async () => {
  const { dir, cleanup } = await scratch()
  let calls = 0
  const journal = new DispatchJournal({
    path: join(dir, 'prompt-deliveries-v1.json'),
    codec: promptDeliveryCodec,
    fsyncFileDescriptor: () => { throw errno('EIO') },
    log: () => {},
  })
  for (let i = 0; i < 3; i += 1) {
    const receipt = await journal.dispatch('device-1', sendId(), { sessionId: 's-1', content: { text: 'x' + i } }, async () => {
      calls += 1
      return { ok: true as const, value: 1 }
    })
    assert.equal(receipt.status, 'unknown')
  }
  assert.equal(calls, 0, '没落盘就不许跑上游')
  await cleanup()
})

test('构造期的文件损坏仍然永久降级：宁可整进程不投递也不按错格式续写', async () => {
  const { dir, cleanup } = await scratch()
  const path = join(dir, 'corrupt.json')
  await writeFile(path, '{not json')
  const journal = new DispatchJournal({ path, codec: promptDeliveryCodec, log: () => {} })
  const receipt = await journal.dispatch('device-1', sendId(), { sessionId: 's-1', content: { text: 'x' } }, op)
  assert.equal(receipt.status, 'unknown')
  // 同一 id 重放仍是 unknown：降级期间不允许把新请求当成没发生过。
  assert.equal(journal.lookup('device-1', sendId(), 's-1')?.status, 'unknown')
  await cleanup()
})

test('openDispatchJournal 是单例：log 必须首次构造时就带上', async () => {
  const { dir, cleanup } = await scratch()
  const path = join(dir, 'single.json')
  const first = openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true, log: () => {} })
  const second = openDispatchJournal({ path, codec: promptDeliveryCodec, joinInFlight: true })
  assert.equal(first, second, '事后补传 log 不会换实例')
  await cleanup()
})