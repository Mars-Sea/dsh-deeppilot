/**
 * settings-page 的表面基线。
 *
 * 固化宿主依赖、文案键和诊断条目，防止页面改版时无意丢失能力。
 * 经批准的布局或文案调整需审阅快照差异；浏览器里的真实布局与交互由
 * tests/e2e/settings-page.spec.ts 覆盖，静态表面不代替渲染验证。
 *
 * 两种模式：`RECORD=1` 写快照；默认读快照比对。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/** 页面这次的「表面」由一个 module 簇构成：组件 + props 接口 + view model。 */
const SOURCES = [
  new URL('../src/client/settings-page.ts', import.meta.url),
  new URL('../src/client/settings-props.ts', import.meta.url),
  new URL('../src/client/settings-view-models.ts', import.meta.url),
]
const SNAPSHOT = new URL('./settings-page-surface.snapshot.json', import.meta.url)
const RECORD = process.env.RECORD === '1'

interface Surface {
  props: string[]
  i18nKeys: string[]
  guardCount: number
  diagKeys: string[]
}

function collect(): Surface {
  const raw = SOURCES.map((url) => readFileSync(url, 'utf8')).join('\n')
  // 剥掉注释与模块路径字面量：否则 JSDoc 里的「settings-props.ts」和 import
  // 里的 './settings-props.ts' 都会被 props 匹配误捕获成 props.ts。
  // 注释剥离必须避开 URL 里的 `//`（href: 'https://…'），否则会把同一行
  // 后面的 key 一起吃掉；因此只剥前面不是冒号/单词字符的 `//`。
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\w])\/\/[^\n]*/g, '$1 ')
    .replace(/'[^'\n]*\.ts'/g, "''")
  const props = new Set<string>()
  for (const match of source.matchAll(/\bprops\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    props.add(match[1]!)
  }
  // 宽口径：页面里任何形如 `namespace.key` 的字符串字面量都算 i18n key。
  // 理由是提取后一部分 key 会从 `t(props.t, 'x.y')` 搬进导出的 key 对照表，
  // 窄口径会漏掉它们—— surface 要钉的是「页面引用了哪些 key」，不是调用形状。
  const i18nKeys = new Set<string>()
  const messageSource = source + readFileSync(new URL('../src/client/device-actions.ts', import.meta.url), 'utf8')
  for (const match of messageSource.matchAll(/'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g)) {
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
  // `advanced.summary` 是唯一被剔除的 key：它在迁移前只出现在一句注释里
  // （`// …collapse into t(props.t, 'advanced.summary')`），真实调用用的是
  // `connection.optionsSummary`。列入剔除表比留一个假事实在基线上更好。
  const COMMENT_ONLY_KEYS = ['advanced.summary']
  assert.deepEqual(actual.props, expected.props, 'props 面必须不变')
  assert.deepEqual(
    actual.i18nKeys.filter((key) => !COMMENT_ONLY_KEYS.includes(key)),
    expected.i18nKeys.filter((key) => !COMMENT_ONLY_KEYS.includes(key)),
    'i18n key 集合必须不变',
  )
  assert.deepEqual(actual.diagKeys, expected.diagKeys, '诊断条目集合必须不变')
  // 守卫数量是提取的收益指标：归一化后应显著下降，不允许上升。
  assert.ok(actual.guardCount <= expected.guardCount,
    `inline 守卫从 ${expected.guardCount} 增加到 ${actual.guardCount}：归一化 seam 没有收敛它们`)
})
