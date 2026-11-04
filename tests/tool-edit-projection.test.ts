import { test } from 'node:test'
import assert from 'node:assert'
import { projectEvent, projectHistory, limitMessageProjection } from '../src/host-bridge.ts'
import { MAX_TOOL_EDIT_TEXT_BYTES, toolEditOf } from '../src/host-event-projection.ts'

// 工具改动对比：Bridge 把 str_replace_editor 的参数归一化成 tool.edit（PROTOCOL.md「工具改动对比」）。

const args = (value: Record<string, unknown>) => JSON.stringify(value)

test('toolEditOf：三种编辑操作归一化，参数名不外泄', () => {
  assert.deepEqual(
    toolEditOf('str_replace_editor', args({ command: 'str_replace', path: 'a.ts', old_str: 'x', new_str: 'y' })),
    { path: 'a.ts', operation: 'replace', oldText: 'x', newText: 'y' },
  )
  assert.deepEqual(
    toolEditOf('str_replace_editor', args({ command: 'str_replace', path: 'a.ts', old_str: 'x' })),
    { path: 'a.ts', operation: 'replace', oldText: 'x', newText: '' },
    'new_str 缺失视为删除',
  )
  assert.deepEqual(
    toolEditOf('str_replace_editor', args({ command: 'create', path: 'b.md', file_text: '# t' })),
    { path: 'b.md', operation: 'create', newText: '# t' },
  )
  assert.deepEqual(
    toolEditOf('str_replace_editor', args({ command: 'insert', path: 'c.ts', new_str: 'z', insert_line: 3 })),
    { path: 'c.ts', operation: 'insert', newText: 'z', insertLine: 3 },
  )
})

test('toolEditOf：view、其他工具、坏参数一律不附带', () => {
  assert.equal(toolEditOf('str_replace_editor', args({ command: 'view', path: 'a.ts' })), undefined)
  assert.equal(toolEditOf('bash', args({ command: 'str_replace', path: 'a.ts', old_str: 'x' })), undefined)
  assert.equal(toolEditOf('str_replace_editor', '{not json'), undefined)
  assert.equal(toolEditOf('str_replace_editor', args({ command: 'str_replace', old_str: 'x' })), undefined, '缺 path')
  assert.equal(toolEditOf('str_replace_editor', args({ command: 'create', path: 'a' })), undefined, '缺 file_text')
  assert.equal(toolEditOf('str_replace_editor', '[1]'), undefined)
})

test('toolEditOf：单侧超过 16 KiB 时两侧正文都不发，只标 truncated', () => {
  const big = 'a'.repeat(MAX_TOOL_EDIT_TEXT_BYTES + 1)
  assert.deepEqual(
    toolEditOf('str_replace_editor', args({ command: 'str_replace', path: 'a.ts', old_str: 'x', new_str: big })),
    { path: 'a.ts', operation: 'replace', truncated: true },
  )
  // 中文按 UTF-8 字节计：6000 个汉字约 18 KB，超限。
  assert.equal(
    toolEditOf('str_replace_editor', args({ command: 'create', path: 'z.md', file_text: '中'.repeat(6000) }))?.truncated,
    true,
  )
  const exact = 'a'.repeat(MAX_TOOL_EDIT_TEXT_BYTES)
  assert.equal(
    toolEditOf('str_replace_editor', args({ command: 'create', path: 'z.md', file_text: exact }))?.newText,
    exact,
    '恰好 16 KiB 仍发送',
  )
})

test('实时 tool.start 与历史工具行都带 tool.edit，结果合并后保留', () => {
  const callArgs = args({ command: 'str_replace', path: 'src/a.ts', old_str: 'old', new_str: 'new' })
  const start = projectEvent('s1', {
    type: 'tool/call', seq: 7, time: 1,
    data: { name: 'str_replace_editor', arguments: callArgs, callId: 'c7' },
  } as any)
  const liveTool = start!.data.tool as { edit?: unknown; summary: string }
  assert.deepEqual(liveTool.edit, { path: 'src/a.ts', operation: 'replace', oldText: 'old', newText: 'new' })
  assert.ok(liveTool.summary.length > 0, 'summary 照旧保留，旧客户端不受影响')

  const rows = projectHistory([
    { event: { type: 'tool/call', seq: 1, time: 1, data: { name: 'str_replace_editor', arguments: callArgs, callId: 'c1' } } },
    { event: { type: 'tool/result', seq: 2, time: 2, data: { callId: 'c1', message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } } } },
    { event: { type: 'tool/call', seq: 3, time: 3, data: { name: 'bash', arguments: args({ command: 'ls' }), callId: 'c3' } } },
  ] as any)
  const editRow = rows.find((row) => row.seq === 1)
  assert.equal(editRow?.tool?.state, 'ok')
  assert.deepEqual(editRow?.tool?.edit, { path: 'src/a.ts', operation: 'replace', oldText: 'old', newText: 'new' })
  assert.equal(rows.find((row) => row.seq === 3)?.tool?.edit, undefined, '非编辑工具不带 edit')
})

test('整条消息超过上限时先丢改动正文，保留路径与 truncated', () => {
  const limited = limitMessageProjection({
    seq: 1, role: 'tool', ts: 1,
    tool: {
      name: 'str_replace_editor', state: 'ok', summary: 's'.repeat(300 * 1024),
      edit: { path: 'a.ts', operation: 'replace', oldText: 'x', newText: 'y' },
    },
  })
  assert.deepEqual(limited.tool?.edit, { path: 'a.ts', operation: 'replace', truncated: true })
})
