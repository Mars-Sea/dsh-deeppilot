import assert from 'node:assert/strict'
import test from 'node:test'
import { DshCommandApi } from '../src/command-api.ts'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import { registryRowFor, scopeRejection, capabilityRejection, validatePayload, type FrameContext } from '../src/wire-registry.ts'
import { pushScopeFor } from '../src/connection-policy.ts'

function fixture() {
  const calls: Array<{ namespace: string; method: string; args: Record<string, unknown>; peer: unknown; signal: AbortSignal }> = []
  const peer = { id: 'synthetic-owner' }
  let peers = 0
  const services: Record<string, any> = {
    commands: {}, sessionController: { projections: async () => ({ values: { permissions: { currentValue: 'workspace-write' } } }) },
    permissionPresets: { resolve: (value: string) => ({ sandbox: value === 'full' ? 'danger-full-access' : 'workspace-write' }) },
    connection: { createPeer: (options: unknown) => { peers++; assert.deepEqual(options, { principal: { kind: 'owner' }, interactions: 'none' }); return peer } },
    typertGateway: { invoke: async (request: typeof calls[number]) => {
      calls.push(request)
      assert.equal(request.peer, peer)
      assert.ok(request.signal instanceof AbortSignal)
      if (request.method === 'list') return [{ name: 'compact', description: 'compress', definitionId: '@deepseek-ai/dsh-command-compact', private: 'omit' },
        { name: 'plan', description: 'plan', input: { hint: '[text]', attachments: true, private: 'omit' } }]
      if (request.method === 'execute') return { commandId: 'c1', result: { kind: 'success', text: 'done', sourceEventSeq: 4, private: 'omit' }, private: 'omit' }
      if (request.method === 'upload') return { receiptId: 'receipt-1' }
      if (request.method === 'catalog') return { options: [{ value: 'workspace-write', name: 'Workspace' }, { value: 'full', name: 'Full' }, { value: 'auto', name: 'Auto' }] }
      if (request.method === 'record') return { ok: true, value: { recorded: true } }
      throw new Error('unexpected endpoint')
    } },
  }
  const api = new DshCommandApi({ get: (name: string) => services[name] } as never)
  return { api, services, calls, peers: () => peers }
}

test('命令目录经官方一元入口解析冷会话，字段投影且不参与审批竞争', async () => {
  const f = fixture()
  assert.equal(f.api.available, true)
  assert.deepEqual(await f.api.list('cold-session'), { commands: [
    { name: 'compact', description: 'compress', definitionId: '@deepseek-ai/dsh-command-compact' },
    { name: 'plan', description: 'plan', input: { hint: '[text]', attachments: true } },
  ], permissions: true, export: false })
  assert.deepEqual(f.calls[0].args, { agentId: 'cold-session' })
  await f.api.list('another-session')
  assert.equal(f.peers(), 1)
  delete f.services.commands
  assert.equal(f.api.available, false)
})

test('拒绝无效或重名目录，执行响应不携带内部字段', async () => {
  const f = fixture()
  assert.deepEqual(await f.api.execute('s', '/compact', []), { commandId: 'c1', result: { kind: 'success', text: 'done', sourceEventSeq: 4 } })
  for (const rows of [[{ name: '../file', description: '' }], [{ name: 'a', description: '' }, { name: 'a', description: '' }]]) {
    f.services.typertGateway.invoke = async () => rows
    await assert.rejects(f.api.list('s'))
  }
})

test('附件准入先于上传；保留原始参数与附件顺序，正文按文本文件上传', async () => {
  const f = fixture()
  await assert.rejects(f.api.execute('s', '/compact', [], 'changed:definition'))
  const doc = { type: 'document', name: 'report.pdf', mediaType: 'text/plain', data: Buffer.from('提取正文').toString('base64') } as const
  await assert.rejects(f.api.execute('s', '/compact', [doc]))
  assert.equal(f.calls.some(c => c.method === 'upload'), false)
  const image = { type: 'image', name: 'a.png', mediaType: 'image/png', data: 'aGk=' } as const
  await f.api.execute('s', '/plan  keep spaces\nnext', [doc, image])
  assert.deepEqual(f.calls.find(c => c.method === 'upload')?.args, { agentId: 's', request: { name: 'report.pdf.txt', data: doc.data } })
  assert.deepEqual(f.calls.at(-1)?.args, { agentId: 's', line: '/plan  keep spaces\nnext', submittedAttachments: [
    { type: 'file', receiptId: 'receipt-1' }, { type: 'image', mediaType: 'image/png', data: 'aGk=' },
  ] })
  await assert.rejects(f.api.execute('s', '/missing', []))
})

test('权限目录结合当前投影和实际沙盒判断确认；反馈走独立记录通道', async () => {
  const f = fixture()
  assert.deepEqual(await f.api.permissions('s'), { currentValue: 'workspace-write', options: [
    { value: 'workspace-write', name: 'Workspace', confirmation: false }, { value: 'full', name: 'Full', confirmation: true }, { value: 'auto', name: 'Auto', confirmation: true },
  ] })
  await f.api.feedback('s', '  反馈内容  ', 'other')
  assert.deepEqual(f.calls.at(-1)?.args, { request: { sessionId: 's', text: '反馈内容', category: 'other' } })
  f.services.typertGateway.invoke = async () => ({ ok: false, error: { code: 'session-not-found' } })
  await assert.rejects(f.api.feedback('missing', '', 'other'))
})

test('旧主机可使用 operator，完整日志复用官方归档路由和取消信号', async () => {
  const f = fixture()
  const controller = new AbortController()
  const owner = { kind: 'owner' }
  f.services.connection = { operator: owner, createSharedFetchHandler: (prefix: string) => ({ fetch: async (request: Request, peer: unknown) => {
    assert.equal(prefix, '/api'); assert.equal(peer, owner)
    assert.equal(new URL(request.url).searchParams.get('sessionId'), 's /?')
    assert.equal(new URL(request.url).searchParams.get('includeDescendants'), 'true')
    controller.abort(); assert.equal(request.signal.aborted, true)
    return new Response('zip', { headers: { 'content-type': 'application/zip' } })
  } }) }
  assert.equal(await (await f.api.export('s /?', controller.signal)).text(), 'zip')
})

test('命令帧能力、权限和附件形状保持拒绝边界', () => {
  for (const name of ['commands', 'permissions', 'command', 'feedback', 'export']) {
    const row = registryRowFor('c2s.session.' + name)!
    assert.equal(row.stage, 'authenticated')
    assert.equal(row.widgetPolicy ?? 'deny', 'deny')
    assert.equal(capabilityRejection(row, { commands: false } as never)?.code, 'E_UNSUPPORTED')
    assert.equal(scopeRejection(row, new Set())?.code, 'E_FORBIDDEN')
    assert.equal(validatePayload(row, {}).ok, false)
  }
  const row = registryRowFor('c2s.session.command')!
  assert.equal(validatePayload(row, { sessionId: 's', line: ' /compact' }).ok, false)
  assert.equal(validatePayload(row, { sessionId: 's', line: '/Users/a' }).ok, false)
  assert.equal(validatePayload(row, { sessionId: 's', line: '/compact', attachments: [{ type: 'image', name: 'x', mediaType: 'text/plain', data: '!!!' }] }).ok, false)
  assert.equal(validatePayload(row, { sessionId: 's', line: '/plan x', attachments: [] }).ok, true)
  assert.equal(validatePayload(registryRowFor('c2s.session.feedback')!, { sessionId: 's', text: '', category: 'invalid' }).ok, false)
  assert.equal(pushScopeFor('s2c.commands.changed'), 'sessions.read')
})

function exportContext(response: Response, signal?: AbortSignal) {
  const sent: Array<{ type: string; payload: any; message?: string }> = []
  let waits = 0
  const context = { signal, bridge: { exportSession: async () => response }, send: (type: string, payload: unknown) => sent.push({ type, payload }),
    fail: (code: string, message?: string) => sent.push({ type: 'error', payload: code, message }), waitForWritable: async () => { waits++ } } as unknown as FrameContext
  return { context, sent, waits: () => waits }
}

test('完整归档分块有序、每块最多48KiB，最终确认前等待背压', async () => {
  const archive = Buffer.alloc(150_001, 7)
  const f = exportContext(new Response(archive))
  await registryRowFor('c2s.session.export')!.handle(f.context, { sessionId: 's' })
  const chunks = f.sent.filter(f => f.type.endsWith('.chunk'))
  assert.deepEqual(chunks.map(f => f.payload.index), [0, 1, 2, 3])
  const restored = Buffer.concat(chunks.map(f => Buffer.from(f.payload.data, 'base64')))
  assert.deepEqual(restored, archive)
  assert.ok(chunks.every(f => Buffer.from(f.payload.data, 'base64').length <= 48 * 1024))
  assert.equal(f.waits(), 4)
  assert.deepEqual(f.sent.at(-1), { type: 's2c.ack', payload: { sessionId: 's', fileName: 'dsh-session-log.zip', chunks: 4, bytes: archive.length } })
})

test('断线会取消等待中的归档读取，不把部分日志报为成功', async () => {
  const controller = new AbortController()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } })
  const f = exportContext(new Response(stream), controller.signal)
  const running = registryRowFor('c2s.session.export')!.handle(f.context, { sessionId: 's' })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await running
  assert.equal(cancelled, true)
  assert.equal(f.sent.some(f => f.type === 's2c.ack'), false)
  assert.equal(f.sent.at(-1)?.type, 'error')
  // 取消没有上游码可依，落回兜底文案；重点是它必须留在「不报成功」一侧。
  assert.equal(f.sent.at(-1)?.message, '会话日志导出失败，请重试')
})

test('归档失败按主机原因上报，不把不同故障压成同一句话', async () => {
  const sent: Array<{ type: string; payload: any; message?: string }> = []
  const context = {
    bridge: { exportSession: async () => { throw Object.assign(new Error('主机未能生成会话日志归档'), { code: 'command/export-unavailable' }) } },
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
    fail: (code: string, message?: string) => sent.push({ type: 'error', payload: code, message }),
  } as unknown as FrameContext
  await registryRowFor('c2s.session.export')!.handle(context, { sessionId: 's' })
  // 主机已经把失败原因说清楚了，桥接不再用一句「请重试」覆盖它；wire 码仍由域表决定。
  assert.deepEqual(sent, [{ type: 'error', payload: 'E_INTERNAL', message: '主机未能生成会话日志归档' }])
})

test('指令失败按域表翻译，不再一律压成 E_INTERNAL', async () => {
  const f = fixture()
  const proxy = new DshApiProxy({ get: (key: string) => f.services[key] } as never)
  const bridge = new HostBridge(proxy, 100)
  const doc = { type: 'document', name: 'a.txt', mediaType: 'text/plain', data: 'aGk=' }
  // 目录里没有这个指令：手机要能提示「换一个指令」，而不是笼统的失败。
  assert.deepEqual(await bridge.commandOperation('execute', { sessionId: 's', line: '/missing', attachments: [] }),
    { ok: false, code: 'E_NOT_FOUND', message: '当前会话没有这个指令' })
  // 定义不一致同样归 E_NOT_FOUND（目录已过期，重试无意义），而不是 E_BUSY。
  assert.deepEqual(await bridge.commandOperation('execute', { sessionId: 's', line: '/compact', attachments: [], expectedDefinitionId: 'stale' }),
    { ok: false, code: 'E_NOT_FOUND', message: '指令定义已变化，请重新选择' })
  // 附件与指令自身的声明不符，属请求形状问题。
  assert.deepEqual(await bridge.commandOperation('execute', { sessionId: 's', line: '/compact', attachments: [doc] }),
    { ok: false, code: 'E_PROTOCOL', message: '这个指令不接受附件' })
  bridge.dispose()
})

test('桥接命令 RPC 使用独立 request id，缺能力主机返回不支持', async () => {
  const f = fixture()
  const proxy = new DshApiProxy({ get: (key: string) => f.services[key] } as never)
  const bridge = new HostBridge(proxy, 100)
  assert.equal(bridge.capabilities.commands, true)
  assert.equal((await bridge.commandOperation('list', { sessionId: 's' })).ok, true)
  delete f.services.commands
  assert.equal(bridge.capabilities.commands, false)
  assert.deepEqual(await bridge.commandOperation('list', { sessionId: 's' }), { ok: false, code: 'E_UNSUPPORTED', message: '当前主机不支持手机指令' })
  bridge.dispose()
})

test('模型实时投影只推公开选择字段，并遵循会话读取权限', async () => {
  const proxy = {
    sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) },
    events: { host: async function* () {}, mux: async function* () {
      yield { type: 'session/projection', sessionId: 's', key: 'modelSelection', value: { next: { provider: 'p', model: 'm', reasoningEffort: 'high', secret: 'omit' } } }
    } },
  }
  const bridge = new HostBridge(proxy as never, 100)
  const values: unknown[] = []
  bridge.addSink({ push: (type, payload) => { if (type === 's2c.models.changed') values.push(payload) }, canReceive: () => true, lastCursor: () => 0, replay: () => {}, replayDone: () => {}, resync: () => {} })
  bridge.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(values, [{ sessionId: 's', current: { provider: 'p', model: 'm', reasoningEffort: 'high' } }])
  assert.equal(pushScopeFor('s2c.models.changed'), 'sessions.read')
  bridge.dispose()
})
