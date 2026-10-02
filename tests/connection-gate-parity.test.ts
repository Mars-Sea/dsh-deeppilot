/**
 * 连接门迁移的对等测试。
 *
 * 两种模式：
 * - 记录模式（`RECORD=1`）：跑当前实现，把每个场景的输出签名写进
 *   `tests/connection-gate.snapshot.json`；
 * - 断言模式（默认）：读快照并逐个场景比对。
 *
 * 迁移期先记录一次（此刻仍是旧路径在服务），切到 ConnectionGate 之后重跑即
 * 得对等结论。通过后本文件与快照一并删除，场景集与签名由常驻的
 * tests/connection-parity.test.ts 继续把守。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { runAllScenarios, type ScenarioResult } from './connection-gate-scenarios.ts'

const SNAPSHOT = new URL('./connection-gate.snapshot.json', import.meta.url)
const RECORD = process.env.RECORD === '1'

test('连接门对等快照', async (t) => {
  const results = await runAllScenarios()

  if (RECORD || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(results, null, 2) + '\n')
    t.diagnostic('snapshot written: ' + Object.keys(results).length + ' scenarios')
    return
  }

  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, ScenarioResult>
  assert.deepEqual(Object.keys(results).sort(), Object.keys(expected).sort(), '场景集合必须与快照一致')
  for (const [name, want] of Object.entries(expected)) {
    await t.test(name, async () => {
      assert.deepEqual(results[name], want, name)
    })
  }
})
