import { test } from 'node:test'
import assert from 'node:assert'
import { projectEvent, projectHistory } from '../src/host-bridge.ts'
import { MAX_TOOL_TARGET_LABEL_BYTES, MAX_TOOL_TARGET_VALUE_BYTES, toolTargetOf } from '../src/host-event-projection.ts'

// 工具操作对象：Bridge 把宿主工具参数归一化成 tool.target（PROTOCOL.md「Message 投影 · tool.target」）。

const args = (value: Record<string, unknown>) => JSON.stringify(value)
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

test('toolTargetOf：规则表内的工具按类别归一化，参数名不外泄', () => {
  assert.deepEqual(toolTargetOf('read', args({ file_path: '/r/ios/A.swift', limit: 20 })), { kind: 'path', value: '/r/ios/A.swift' })
  assert.deepEqual(toolTargetOf('write', args({ file_path: 'b.md', content: '# t' })), { kind: 'path', value: 'b.md' })
  assert.deepEqual(toolTargetOf('edit', args({ file_path: 'c.ts', old_string: 'x', new_string: 'y' })), { kind: 'path', value: 'c.ts' })
  assert.deepEqual(toolTargetOf('str_replace_editor', args({ command: 'view', path: 'd.ts' })), { kind: 'path', value: 'd.ts' })
  assert.deepEqual(
    toolTargetOf('bash', args({ command: 'npm test\n  --watch=false', description: 'Run tests', timeoutMs: 1000 })),
    { kind: 'command', value: 'npm test --watch=false', label: 'Run tests' },
    '空白折叠成一行，description 作 label',
  )
  assert.deepEqual(toolTargetOf('bash', args({ command: 'ls' })), { kind: 'command', value: 'ls' }, '没有 description 不带 label')
  assert.deepEqual(
    toolTargetOf('grep', args({ pattern: 'MathView', path: '/r/ios/Sources', include: '*.swift' })),
    { kind: 'pattern', value: 'MathView', scope: '/r/ios/Sources' },
  )
  assert.deepEqual(toolTargetOf('glob', args({ pattern: '**/*.ts' })), { kind: 'pattern', value: '**/*.ts' })
  assert.deepEqual(toolTargetOf('web_fetch', args({ url: 'https://example.com/a' })), { kind: 'url', value: 'https://example.com/a' })
  assert.deepEqual(toolTargetOf('web_search', args({ query: 'swiftui timeline' })), { kind: 'text', value: 'swiftui timeline' })
  assert.deepEqual(toolTargetOf('send_message', args({ agent_id: 'a-1', message: 'hi' })), { kind: 'text', value: 'a-1' })
  assert.deepEqual(toolTargetOf('send_message', args({ target: 'reviewer', agent_id: 'a-1' })), { kind: 'text', value: 'reviewer' })
  assert.deepEqual(toolTargetOf('spawn_teammate', args({ name: 'reviewer', prompt: 'p' })), { kind: 'text', value: 'reviewer' })
  assert.deepEqual(toolTargetOf('subagent', args({ description: 'Audit docs', prompt: 'p' })), { kind: 'text', value: 'Audit docs' })
  assert.deepEqual(toolTargetOf('job_output', args({ job_id: 'job-7' })), { kind: 'text', value: 'job-7' })
})

test('named send_message targets survive live projection and result merging alongside older arguments', () => {
  for (const targetArgs of [
    { agent: 'reviewer' },
    { target: 'reviewer' },
    { agent_id: 'reviewer' },
    { agent: 'reviewer', target: 'stale-target', agent_id: 'stale-id' },
  ]) {
    const call = { type: 'tool/call', seq: 1, data: { name: 'send_message', callId: 'message-1', arguments: args({ ...targetArgs, message: 'hello' }) } }
    const target = { kind: 'text', value: 'reviewer' }
    assert.deepEqual(toolTargetOf('send_message', call.data.arguments), target)
    assert.deepEqual((projectEvent('s1', call)!.data.tool as { target?: unknown }).target, target)
    const history = projectHistory([
      { event: call },
      { event: { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'message-1', content: 'delivered' } } } },
    ])
    assert.equal(history.length, 1)
    assert.equal(history[0]!.tool?.state, 'ok')
    assert.deepEqual(history[0]!.tool?.target, target)
  }
})

test('toolTargetOf：规则表外、坏参数、缺参数一律不附带', () => {
  assert.equal(toolTargetOf('todo_write', args({ todos: [] })), undefined)
  assert.equal(toolTargetOf('ask_user_question', args({ questions: [] })), undefined)
  assert.equal(toolTargetOf('read', '{not json'), undefined)
  assert.equal(toolTargetOf('read', '[1]'), undefined)
  assert.equal(toolTargetOf('read', args({ file_path: '   ' })), undefined, '空白值视为缺失')
  assert.equal(toolTargetOf('bash', args({ command: 3 })), undefined, '非字符串视为缺失')
  assert.equal(toolTargetOf('grep', args({ path: '/r' })), undefined, '缺 pattern')
  assert.equal(toolTargetOf(undefined, args({ file_path: 'a' })), undefined)
  assert.equal(toolTargetOf('read', undefined), undefined)
})

test('toolTargetOf：超长路径保留结尾，命令与说明砍结尾，均按 UTF-8 字节计', () => {
  const longPath = '/r/' + 'd/'.repeat(800) + 'Views/A.swift'
  const path = toolTargetOf('read', args({ file_path: longPath }))!.value
  assert.ok(path.startsWith('…'))
  assert.ok(path.endsWith('/Views/A.swift'), '文件名完整')
  assert.ok(bytes(path) <= MAX_TOOL_TARGET_VALUE_BYTES)

  const command = toolTargetOf('bash', args({ command: '中'.repeat(600), description: '说'.repeat(200) }))!
  assert.ok(command.value.endsWith('…'))
  assert.ok(bytes(command.value) <= MAX_TOOL_TARGET_VALUE_BYTES)
  assert.ok(command.label!.endsWith('…'))
  assert.ok(bytes(command.label!) <= MAX_TOOL_TARGET_LABEL_BYTES)

  const exact = 'a'.repeat(MAX_TOOL_TARGET_VALUE_BYTES)
  assert.equal(toolTargetOf('read', args({ file_path: exact }))!.value, exact, '恰好 1 KiB 原样发送')

  const scope = toolTargetOf('grep', args({ pattern: 'x', path: '/' + '路'.repeat(500) + '/end' }))!.scope!
  assert.ok(scope.startsWith('…') && scope.endsWith('/end'))
  assert.ok(bytes(scope) <= MAX_TOOL_TARGET_VALUE_BYTES)
})

test('实时 tool.start 与历史工具行都带 tool.target，结果合并后保留，独立结果行不带', () => {
  const callArgs = args({ file_path: 'ios/Sources/Views/A.swift' })
  const start = projectEvent('s1', {
    type: 'tool/call', seq: 7, time: 1,
    data: { name: 'read', arguments: callArgs, callId: 'c7' },
  } as any)
  const liveTool = start!.data.tool as { target?: unknown; summary: string }
  assert.deepEqual(liveTool.target, { kind: 'path', value: 'ios/Sources/Views/A.swift' })
  assert.ok(liveTool.summary.length > 0, 'summary 照旧保留，旧客户端不受影响')

  const rows = projectHistory([
    { event: { type: 'tool/call', seq: 1, time: 1, data: { name: 'read', arguments: callArgs, callId: 'c1' } } },
    { event: { type: 'tool/result', seq: 2, time: 2, data: { callId: 'c1', message: { role: 'tool', content: [{ type: 'text', text: 'import SwiftUI' }] } } } },
    { event: { type: 'tool/result', seq: 3, time: 3, data: { callId: 'missing', message: { role: 'tool', content: [{ type: 'text', text: 'orphan' }] } } } },
  ] as any)
  const readRow = rows.find((row) => row.seq === 1)
  assert.equal(readRow?.tool?.state, 'ok')
  assert.equal(readRow?.tool?.summary, 'import SwiftUI', 'summary 换成结果摘要')
  assert.deepEqual(readRow?.tool?.target, { kind: 'path', value: 'ios/Sources/Views/A.swift' }, 'target 不随结果变化')
  assert.equal(rows.find((row) => row.seq === 3)?.tool?.target, undefined, '独立结果行不带 target')
})
