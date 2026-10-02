/**
 * TransportReconciler 的单测：用可录制的假 spec 驱动协调器。
 *
 * 重点是三个**刻意保留**的差异（见 src/transport-reconciler.ts 文件头）：
 * `skipWhenDisabled`、`applyKey` 时机、有无错误分支。它们决定了「reconcile
 * 等待期间又来一次 volatile-update」时的行为，任何一次统一都必须是显式决策，
 * 因此各有断言把守。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TransportReconciler, type TransportSpec, type TransportStatus } from '../src/transport-reconciler.ts'
import type { Config } from '../src/config.ts'

interface FakeStatus extends TransportStatus {
  phase: 'idle' | 'starting' | 'online' | 'disabled' | 'error'
  label?: string
}

interface FakeSpec extends TransportSpec<string, FakeStatus> {
  calls: string[]
  /** 让 begin() 挂起，用来制造「在途」状态。 */
  releaseBegin?: () => void
}

/** 造一个可录制的 spec；每次 construct 返回一个新实例名。 */
function makeSpec(overrides: Partial<TransportSpec<string, FakeStatus>> = {}): FakeSpec {
  const calls: string[] = []
  let instances = 0
  const spec: FakeSpec = {
    calls,
    keyOf: (config: Config) => {
      const local = (config as unknown as { transport?: Record<string, unknown> }).transport ?? {}
      return { ...local }
    },
    skipWhenDisabled: true,
    applyKey: 'before-teardown',
    construct: (target) => {
      calls.push('construct:' + String(target.enabled))
      instances += 1
      return 'instance-' + String(instances)
    },
    begin: async () => { calls.push('begin') },
    stop: async (instance) => { calls.push('stop:' + String(instance ?? 'none')) },
    disabledStatus: (target) => { calls.push('disabledStatus'); return { phase: 'disabled', label: String(target.port), updatedAt: 0 } },
    startingStatus: () => ({ phase: 'starting', updatedAt: 0 }),
    statusOf: (instance) => instance === undefined
      ? { phase: 'idle', updatedAt: 0 }
      : { phase: 'online', label: instance, updatedAt: 0 },
    ...overrides,
  }
  return spec
}

const config = (transport: Record<string, unknown>): Config =>
  ({ transport }) as unknown as Config

const initialStatus: FakeStatus = { phase: 'idle', updatedAt: 0 }

test('首次 reconcile：构造 + 启动，状态取实例的', async () => {
  const spec = makeSpec()
  const logs: string[] = []
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true, port: 1 }), (m) => logs.push(m), initialStatus)
  await reconciler.reconcile()
  assert.deepEqual(spec.calls, ['construct:true', 'begin'])
  assert.equal(reconciler.status().phase, 'online')
  assert.equal(reconciler.status().label, 'instance-1')
})

test('配置不变：完全空转', async () => {
  const spec = makeSpec()
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true }), () => {}, initialStatus)
  await reconciler.reconcile()
  const before = spec.calls.length
  await reconciler.reconcile()
  await reconciler.reconcile()
  assert.equal(spec.calls.length, before, '差分键未变时不得有任何动作')
})

test('配置变化：先拆旧的，再起新的', async () => {
  let port = 1
  const spec = makeSpec()
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true, port }), () => {}, initialStatus)
  await reconciler.reconcile()
  port = 2
  await reconciler.reconcile()
  assert.deepEqual(spec.calls, ['construct:true', 'begin', 'stop:instance-1', 'construct:true', 'begin'])
  assert.equal(reconciler.status().label, 'instance-2')
})

test('skipWhenDisabled=true：未启用直接置 disabled，不构造', async () => {
  const spec = makeSpec({ skipWhenDisabled: true })
  const logs: string[] = []
  const reconciler = new TransportReconciler(spec, () => config({ enabled: false, port: 7 }), (m) => logs.push(m), initialStatus)
  await reconciler.reconcile()
  assert.deepEqual(spec.calls, ['disabledStatus'])
  assert.equal(reconciler.status().phase, 'disabled')
  assert.equal(reconciler.status().label, '7')
  assert.deepEqual(logs, ['transport disabled'])
})

test('skipWhenDisabled=false（Funnel 式）：未启用仍然构造', async () => {
  const spec = makeSpec({ skipWhenDisabled: false })
  const reconciler = new TransportReconciler(spec, () => config({ enabled: false }), () => {}, initialStatus)
  await reconciler.reconcile()
  assert.deepEqual(spec.calls, ['construct:false', 'begin'])
  assert.equal(reconciler.status().phase, 'online')
})

test('applyKey=before-teardown：拆除在途期间的新触发被短路', async () => {
  let releaseStop!: () => void
  let stopBlocked = false
  const spec = makeSpec({
    applyKey: 'before-teardown',
    stop: async (instance) => {
      // 只阻塞对首个真实实例的拆除，制造「在途」窗口。
      if (instance === 'instance-1') {
        stopBlocked = true
        await new Promise<void>((resolve) => { releaseStop = resolve })
      }
    },
  })
  let port = 1
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true, port }), () => {}, initialStatus)
  await reconciler.reconcile()

  port = 2
  const first = reconciler.reconcile()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(stopBlocked, '拆除应当已在途')
  // 键在拆除前已写入：这一次触发必须短路，不得再构造。
  const second = reconciler.reconcile()
  releaseStop()
  await Promise.all([first, second])
  assert.equal(spec.calls.filter((call) => call.startsWith('construct')).length, 2)
})

test('applyKey=after-construct（Funnel 式）：拆除在途期间的新触发会重来', async () => {
  let releaseStop!: () => void
  let stopBlocked = false
  const spec = makeSpec({
    applyKey: 'after-construct',
    stop: async (instance) => {
      if (instance === 'instance-1') {
        stopBlocked = true
        await new Promise<void>((resolve) => { releaseStop = resolve })
      }
    },
  })
  let port = 1
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true, port }), () => {}, initialStatus)
  await reconciler.reconcile()

  port = 2
  const first = reconciler.reconcile()
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(stopBlocked, '拆除应当已在途')
  // 键要等构造后才写：拆除在途期间它仍是旧值，因此这一次触发不会被短路，
  // 会再走一遍「拆除 → 构造 → 启动」。这正是 Funnel 路径的既有语义。
  const second = reconciler.reconcile()
  releaseStop()
  await Promise.all([first, second])
  assert.equal(spec.calls.filter((call) => call.startsWith('construct')).length, 3,
    '两次触发各自构造一次（含在途重入的那次）')
})

test('begin 抛错且有 errorStatus：落 error 状态并记日志', async () => {
  const spec = makeSpec({
    begin: async () => { throw new Error('EADDRINUSE') },
    errorStatus: (error) => ({ phase: 'error', label: String((error as Error).message), updatedAt: 0 }),
  })
  const logs: string[] = []
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true }), (m) => logs.push(m), initialStatus)
  await reconciler.reconcile()
  assert.equal(reconciler.status().phase, 'error')
  assert.equal(reconciler.status().label, 'EADDRINUSE')
  assert.deepEqual(logs, ['transport failed: Error: EADDRINUSE'])
})

test('begin 抛错且无 errorStatus：错误上抛，由 scheduleReconcile 兜住', async () => {
  const spec = makeSpec({ begin: async () => { throw new Error('boom') } })
  const logs: string[] = []
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true }), (m) => logs.push(m), initialStatus)
  reconciler.scheduleReconcile()
  await reconciler.settled()
  assert.deepEqual(logs, ['reconcile failed: Error: boom'])
  // 构造发生了、启动抛出、且没有错误分支 ⇒ 错误必须抛给调用方。
  assert.deepEqual(spec.calls, ['construct:true'])
})

test('dispose：拆掉实例并让后续 reconcile 空转', async () => {
  const spec = makeSpec()
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true }), () => {}, initialStatus)
  await reconciler.reconcile()
  await reconciler.dispose()
  assert.deepEqual(spec.calls, ['construct:true', 'begin', 'stop:instance-1'])
  await reconciler.reconcile()
  assert.equal(spec.calls.filter((call) => call.startsWith('construct')).length, 1, '销毁后不得再构造')
})

test('scheduleReconcile 串行：并发触发不重叠，冗余触发被差分短路', async () => {
  const order: string[] = []
  let firstStarted!: () => void
  let releaseFirst!: () => void
  const started = new Promise<void>((resolve) => { firstStarted = resolve })
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
  const spec = makeSpec({
    begin: async () => {
      order.push('begin')
      // 第一次 begin 挂住，制造并发窗口。
      if (order.filter((entry) => entry === 'begin').length === 1) {
        firstStarted()
        await gate
      }
    },
  })
  const reconciler = new TransportReconciler(spec, () => config({ enabled: true }), () => {}, initialStatus)
  reconciler.scheduleReconcile()
  reconciler.scheduleReconcile()
  reconciler.scheduleReconcile()
  await started
  releaseFirst()
  await reconciler.settled()
  // 三次触发串行执行；第一次完成后键已写入，后两次被差分短路。
  assert.deepEqual(spec.calls, ['construct:true'], '只构造一次')
  assert.deepEqual(order, ['begin'], 'begin 只跑了一次，没有重叠')
})
