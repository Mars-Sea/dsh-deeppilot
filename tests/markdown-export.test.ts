import assert from 'node:assert/strict'
import test from 'node:test'
import { DshCommandApi } from '../src/command-api.ts'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import { registryRowFor, validatePayload, type FrameContext } from '../src/wire-registry.ts'
import type { SessionExportFormat } from '../src/protocol.ts'

const row = registryRowFor('c2s.session.export')!

function fixture(body: Uint8Array | string, contentType: string, status = 200) {
  const requests: Request[] = []
  const peer = { principal: { kind: 'owner' } }
  const services: Record<string, any> = {
    commands: {}, typertGateway: { invoke() {} }, sessionController: {},
    sessionQuery: { readSession() {} },
    connection: {
      operator: peer,
      fetchRoutes: new Map([['/api/session.markdown', { methods: new Set(['GET', 'HEAD']), fetch() {} }]]),
      createSharedFetchHandler: (prefix: string) => {
        assert.equal(prefix, '/api')
        return { fetch: async (request: Request, owner: unknown) => {
          assert.equal(owner, peer)
          requests.push(request)
          const responseBody = typeof body === 'string' ? body : new Uint8Array(body)
          return new Response(status === 204 ? null : responseBody, { status, headers: { 'content-type': contentType } })
        } }
      },
    },
  }
  const ctx = { get: (key: string) => services[key] } as never
  return { api: new DshCommandApi(ctx), ctx, services, requests }
}

function frameContext(exportSession: (...args: any[]) => Promise<Response>, sessionMarkdown?: boolean) {
  const sent: Array<{ type: string; payload: any }> = []
  let waits = 0
  const context = {
    bridge: { exportSession, capabilities: { sessionMarkdown } },
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
    fail: (code: string, message: string) => sent.push({ type: 's2c.error', payload: { code, message } }),
    waitForWritable: async () => { waits++ },
  } as unknown as FrameContext
  return { context, sent, waits: () => waits }
}

test('缺省 ZIP 保留原 URL、二进制分块和逐字节一致的最终回执', async () => {
  const archive = Uint8Array.from({ length: 150_001 }, (_, index) => index % 256)
  const f = fixture(archive, 'application/zip')
  const calls: any[][] = []
  const frame = frameContext(async (...args) => { calls.push(args); return f.api.export(args[0], args[1], args[2]) })
  const payload = { sessionId: 's /?中文' }
  assert.deepEqual(validatePayload(row, payload), { ok: true, value: payload })
  await row.handle(frame.context, payload)
  assert.equal(f.requests[0]!.url, 'http://localhost/api/session.export?includeDescendants=true&sessionId=' + encodeURIComponent(payload.sessionId))
  assert.equal(calls[0]!.length, 2)
  const expected: Array<{ type: string; payload: unknown }> = []
  for (let offset = 0; offset < archive.length; offset += 48 * 1024) {
    expected.push({ type: 's2c.session.export.chunk', payload: { index: expected.length, data: Buffer.from(archive.subarray(offset, offset + 48 * 1024)).toString('base64') } })
  }
  expected.push({ type: 's2c.ack', payload: { sessionId: payload.sessionId, fileName: 'dsh-session-log.zip', chunks: 4, bytes: archive.length } })
  assert.equal(JSON.stringify(frame.sent), JSON.stringify(expected))
  assert.deepEqual(Buffer.concat(frame.sent.slice(0, -1).map(item => Buffer.from(item.payload.data, 'base64'))), Buffer.from(archive))
  assert.equal(frame.waits(), 4)
})

test('Markdown 使用官方正文路由、正确编码会话 ID 并传递取消信号', async () => {
  const body = '# 会话\n\n你好\n'
  const f = fixture(body, 'text/markdown; charset=utf-8')
  const controller = new AbortController()
  const response = await f.api.export('s /?中文', controller.signal, 'markdown')
  assert.equal(f.requests[0]!.url, 'http://localhost/api/session.markdown?sessionId=' + encodeURIComponent('s /?中文'))
  assert.equal(f.requests[0]!.method, 'GET')
  assert.equal(await response.text(), body)
  controller.abort()
  assert.equal(f.requests[0]!.signal.aborted, true)
})

test('两种格式拒绝不匹配、缺失或伪装的媒体类型', async () => {
  const cases: Array<[SessionExportFormat, string]> = [
    ['markdown', 'application/zip'], ['markdown', 'text/html'], ['markdown', 'text/plain'],
    ['markdown', 'text/markdown-invalid'], ['markdown', 'application/json; note=text/markdown'], ['markdown', ''],
    ['zip', 'text/markdown; charset=utf-8'],
  ]
  for (const [format, contentType] of cases) {
    await assert.rejects(fixture('body', contentType).api.export('s', new AbortController().signal, format), { code: 'command/export-unavailable' })
  }
})

test('Markdown 拒绝 HTTP 失败与无正文响应', async () => {
  for (const status of [404, 500, 204]) {
    await assert.rejects(fixture('body', 'text/markdown', status).api.export('s', new AbortController().signal, 'markdown'), { code: 'command/export-unavailable' })
  }
})

test('format 仅接受 zip、markdown 或缺省，非法值以 E_PROTOCOL 拒绝', () => {
  for (const format of ['zip', 'markdown', undefined]) assert.equal(validatePayload(row, { sessionId: 's', ...(format === undefined ? {} : { format }) }).ok, true)
  for (const format of ['pdf', 'Markdown', '', null, 0, false, [], {}]) {
    const result = validatePayload(row, { sessionId: 's', format })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'E_PROTOCOL')
  }
})

test('显式格式保留相同分块，最终回执携带匹配的文件名与媒体类型', async () => {
  for (const format of ['zip', 'markdown'] as const) {
    const body = Buffer.from('正文\n')
    const calls: any[][] = []
    const f = frameContext(async (...args) => { calls.push(args); return new Response(body) }, true)
    await row.handle(f.context, { sessionId: 's', format })
    assert.equal(calls[0]![2], format)
    assert.deepEqual(f.sent, [
      { type: 's2c.session.export.chunk', payload: { index: 0, data: body.toString('base64') } },
      { type: 's2c.ack', payload: { sessionId: 's', fileName: format === 'markdown' ? 'dsh-session.md' : 'dsh-session-log.zip', chunks: 1, bytes: body.length,
        mediaType: format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/zip' } },
    ])
  }
})

test('Markdown 能力缺省或 false 时拒绝，且不调用导出入口', async () => {
  for (const capability of [undefined, false]) {
    let calls = 0
    const f = frameContext(async () => { calls++; return new Response('unexpected') }, capability)
    await row.handle(f.context, { sessionId: 's', format: 'markdown' })
    assert.equal(calls, 0)
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0]!.payload.code, 'E_UNSUPPORTED')
  }
})

test('能力探测核对已注册 GET 路由与读取依赖，导出方法存在不足以宣告支持', () => {
  const f = fixture('body', 'text/markdown')
  assert.equal(f.api.markdownAvailable, true)
  const route = f.services.connection.fetchRoutes.get('/api/session.markdown')
  f.services.connection.fetchRoutes.delete('/api/session.markdown')
  assert.equal(f.api.markdownAvailable, false)
  f.services.connection.fetchRoutes.set('/api/session.markdown', route)
  route.methods = new Set(['HEAD'])
  assert.equal(f.api.markdownAvailable, false)
  route.methods.add('GET')
  delete route.fetch
  assert.equal(f.api.markdownAvailable, false)
  route.fetch = () => {}
  delete f.services.sessionQuery
  assert.equal(f.api.markdownAvailable, false)
  f.services.sessionQuery = { readSession() {} }
  assert.equal(f.api.markdownAvailable, true)
  delete f.services.connection.fetchRoutes
  assert.equal(f.api.markdownAvailable, false)
  f.services.connection.fetchRoutes = { get: 'unknown-registry' }
  assert.equal(f.api.markdownAvailable, false)
})

test('正文媒体类型不符经 wire 错误域上报，不能发送成功回执', async () => {
  const f = fixture('fallback html', 'text/html')
  const frame = frameContext((id, signal, format) => f.api.export(id, signal, format), true)
  await row.handle(frame.context, { sessionId: 's', format: 'markdown' })
  assert.deepEqual(frame.sent, [{ type: 's2c.error', payload: { code: 'E_INTERNAL', message: '主机未能生成会话对话正文' } }])
})

test('实际 Bridge 和代理完整转发格式，省略格式的 RPC 不增字段', async () => {
  const f = fixture('# 正文', 'text/markdown; charset=utf-8')
  const proxy = new DshApiProxy(f.ctx)
  const bridge = new HostBridge(proxy, 100)
  try {
    assert.equal(bridge.capabilities.sessionMarkdown, true)
    const frame = frameContext((...args) => (bridge.exportSession as (...args: any[]) => Promise<Response>)(...args), true)
    await row.handle(frame.context, { sessionId: 's', format: 'markdown' })
    assert.equal(new URL(f.requests[0]!.url).pathname, '/api/session.markdown')
    assert.equal(frame.sent.at(-1)!.payload.mediaType, 'text/markdown; charset=utf-8')
    // 单独核对 Bridge 的 RPC 载荷，确保缺省请求没有被自动补上 format。
    const requests: any[] = []
    const captureBridge = new HostBridge({ commands: { export: async (request: unknown) => { requests.push(request); return new Response('zip') } }, sessions: {} } as never, 100)
    try {
      await captureBridge.exportSession('s', new AbortController().signal)
      assert.deepEqual(requests[0].payload, { sessionId: 's' })
      await (captureBridge.exportSession as (...args: any[]) => Promise<Response>)('s', new AbortController().signal, 'zip')
      assert.deepEqual(requests[1].payload, { sessionId: 's', format: 'zip' })
    } finally { captureBridge.dispose() }
  } finally { bridge.dispose() }
})
