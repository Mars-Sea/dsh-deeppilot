import { test } from 'node:test'
import assert from 'node:assert'
import { notificationParagraphs, notificationPlainText } from '../src/notification-text.ts'

test('links keep only their label; URL-encoded paths never reach the banner', () => {
  // 回归：回复以文件链接结尾时，横幅曾显示 "code-provider/docs/%E6%8F%90…md#L7))。"
  const reply = '已把这次修复记进提交历史。\n\n详情见 [提交历史.md](code-provider/docs/%E6%8F%90%E4%BA%A4%E5%8E%86%E5%8F%B2.md#L7)。'
  assert.equal(notificationPlainText(reply, 'last'), '详情见 提交历史.md。')
})

test('link targets with one level of parentheses are removed whole', () => {
  assert.equal(notificationPlainText('看 [文档](https://example.com/a_(b)) 即可', 'all'), '看 文档 即可')
})

test('last picks the final non-empty paragraph; code-only tails are skipped', () => {
  const reply = '我先检查了配置。\n\n测试全部通过，可以合并。\n\n```ts\nconst x = 1\n```'
  assert.equal(notificationPlainText(reply, 'last'), '测试全部通过，可以合并。')
  assert.equal(notificationPlainText('```sh\nnpm test\n```', 'last'), '')
  // 未闭合的围栏一直丢到文末。
  assert.equal(notificationPlainText('结论在这里。\n\n```\nunfinished', 'last'), '结论在这里。')
})

test('block markers, emphasis and inline code are stripped', () => {
  const reply = [
    '## 结果',
    '',
    '> **已完成**：改了 `host-bridge.ts`',
    '',
    '- [x] 第一项',
    '- 第二项 *重点* 与 ~~旧值~~',
    '1. 有序项',
  ].join('\n')
  assert.deepEqual(notificationParagraphs(reply), [
    '结果',
    '已完成：改了 host-bridge.ts',
    '第一项 第二项 重点 与 旧值 有序项',
  ])
})

test('snake_case, arithmetic and prose pipes are left alone', () => {
  assert.equal(notificationPlainText('调用 read_file 与 2 * 3 * 4，选 a | b', 'all'), '调用 read_file 与 2 * 3 * 4，选 a | b')
})

test('tables become space-separated cells; rules and images vanish', () => {
  const reply = '| 项 | 结果 |\n| --- | :-: |\n| 构建 | 通过 |\n\n---\n\n![截图](shot.png)'
  assert.deepEqual(notificationParagraphs(reply), ['项 结果 构建 通过'])
})

test('autolinks and HTML tags are unwrapped; bad percent runs stay as-is', () => {
  assert.equal(notificationPlainText('见 <https://example.com/x>，<br>换行', 'all'), '见 https://example.com/x，换行')
  assert.equal(notificationPlainText('路径 docs/%E6%8F%90 与 100%FF', 'all'), '路径 docs/提 与 100%FF')
})

test('all joins paragraphs into one line', () => {
  assert.equal(notificationPlainText('第一段\n第一段续\n\n第二段', 'all'), '第一段 第一段续 第二段')
})
