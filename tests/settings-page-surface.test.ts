/**
 * settings-page 的表面基线。
 *
 * 盘点确认 `settings-page.ts` 是全仓唯一没有任何测试的 client module：它的
 * props 面无类型（20 个属性全凭运行期 typeof 守卫），渲染树也从未被驱动过。
 * 项目测试不渲染 React，因此本轮能钉的基线是**静态表面**——页面引用了哪些
 * props、哪些 i18n key。
 *
 * 提取（类型化 props + 抽 view model）之后这层必须保持不变：任何一个 prop
 * 丢失、任何一个 key 改名，都会以显式 diff 出现在这里，而不是静默变成页面
 * 上的诊断行或缺文案。
 *
 * 两种模式：`RECORD=1` 写快照；默认读快照比对。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SOURCE = new URL('../src/client/settings-page.ts', import.meta.url)
const SNAPSHOT = new URL('./settings-page-surface.snapshot.json', import.meta.url)
const RECORD = process.env.RECORD === '1'

interface Surface {
  props: string[]
  i18nKeys: string[]
  guardCount: number
  diagKeys: string[]
}

function collect(): Surface {
  const source = readFileSync(SOURCE, 'utf8')
  const props = new Set<string>()
  for (const match of source.matchAll(/\bprops\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    props.add(match[1]!)
  }
  // 宽口径：页面里任何形如 `namespace.key` 的字符串字面量都算 i18n key。
  // 理由是提取后一部分 key 会从 `t(props.t, 'x.y')` 搬进导出的 key 对照表，
  // 窄口径会漏掉它们—— surface 要钉的是「页面引用了哪些 key」，不是调用形状。
  const i18nKeys = new Set<string>()
  for (const match of source.matchAll(/'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g)) {
    i18nKeys.add(match[1]!)
  }
  // 守卫数量：提取会把这批 typeof 检查收敛到一处，数字应当下降。
  const guardCount = [...source.matchAll(/typeof props\./g)].length
  const diagKeys = new Set<string>()
  for (const match of source.matchAll(/diag\.(missing[A-Za-z0-9_]*)/g)) {
    diagKeys.add(match[1]!)
  }
  return {
    props: [...props].sort(),
    i18nKeys: [...i18nKeys].sort(),
    guardCount,
    diagKeys: [...diagKeys].sort(),
  }
}

test('settings-page 的表面与固化快照一致', (t) => {
  const actual = collect()

  if (RECORD || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 1) + '\n')
    t.diagnostic('settings-page surface written: '
      + actual.props.length + ' props, '
      + actual.i18nKeys.length + ' i18n keys, '
      + actual.guardCount + ' inline guards')
    return
  }

  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Surface
  assert.deepEqual(actual.props, expected.props, 'props 面必须不变')
  assert.deepEqual(actual.i18nKeys, expected.i18nKeys, 'i18n key 集合必须不变')
  assert.deepEqual(actual.diagKeys, expected.diagKeys, '诊断条目集合必须不变')
  // 守卫数量是提取的收益指标：归一化后应显著下降，不允许上升。
  assert.ok(actual.guardCount <= expected.guardCount,
    `inline 守卫从 ${expected.guardCount} 增加到 ${actual.guardCount}：归一化 seam 没有收敛它们`)
})
