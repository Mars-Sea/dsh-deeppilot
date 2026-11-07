import assert from 'node:assert/strict'
import test from 'node:test'
import { DshReferenceApi, fileItems, sessionItems, unwrapRemote, FILE_REFERENCE_LIMIT, SESSION_REFERENCE_LIMIT } from '../src/reference-api.ts'
import { registryRowFor, scopeRejection, capabilityRejection, validatePayload, type FrameContext } from '../src/wire-registry.ts'

/** 伪造宿主：按需挂载两类引用服务，网关调用逐条记录，便于断言参数与调用身份。 */
function fixture(options: { files?: boolean; sessions?: boolean; reply?: (namespace: string) => unknown } = {}) {
  const calls: Array<{ namespace: string; method: string; args: Record<string, unknown>; peer: unknown }> = []
  const peer = { id: 'synthetic-owner' }
  const services: Record<string, any> = {
    connection: { createPeer: () => peer },
    typertGateway: { invoke: async (request: typeof calls[number] & { signal: AbortSignal }) => {
      calls.push(request)
      assert.equal(request.peer, peer)
      assert.ok(request.signal instanceof AbortSignal)
      return options.reply?.(request.namespace)
    } },
  }
  if (options.files !== false) services.fileReferences = {}
  if (options.sessions !== false) services.sessionReferenceResolver = {}
  const api = new DshReferenceApi({ get: (name: string) => services[name] } as never)
  return { api, calls }
}

const mention = '@[修复登录](dsh-session:abc_123)'

test('两类候选并行读取，参数用 agentId，两种网关返回形态都接受', async () => {
  const f = fixture({ reply: namespace => namespace === 'fileReferences'
    ? [{ path: 'src/a.ts', kind: 'file' }, { path: 'src', kind: 'directory' }]
    : { ok: true, value: [{ sessionId: 's2', label: 'raw', displayTitle: '修复登录', mention, sameWorkspace: true, cwd: '/Users/x', createdAt: 1 }] } })
  assert.equal(f.api.available, true)
  assert.deepEqual(await f.api.list('s1', 'sr'), {
    files: { available: true, items: [{ path: 'src/a.ts', kind: 'file' }, { path: 'src', kind: 'directory' }] },
    // 工作目录不下发，只留 sameWorkspace。
    sessions: { available: true, items: [{ sessionId: 's2', label: '修复登录', mention, sameWorkspace: true }] },
  })
  assert.deepEqual(f.calls.map(c => [c.namespace, c.method, c.args]).sort(), [
    ['fileReferences', 'list', { agentId: 's1', query: 'sr' }],
    ['sessionReferenceResolver', 'candidates', { agentId: 's1', query: 'sr' }],
  ])
})

test('单类失败只让该类为空，缺席的服务不被调用', async () => {
  const failing = fixture({ reply: namespace => {
    if (namespace === 'sessionReferenceResolver') throw new Error('timeout')
    return [{ path: 'a', kind: 'file' }]
  } })
  const result = await failing.api.list('s1', '')
  assert.deepEqual(result.files.items, [{ path: 'a', kind: 'file' }])
  assert.deepEqual(result.sessions, { available: true, items: [] })

  const filesOnly = fixture({ sessions: false, reply: () => [] })
  assert.equal(filesOnly.api.sessionsAvailable, false)
  assert.deepEqual((await filesOnly.api.list('s1', '')).sessions, { available: false, items: [] })
  assert.deepEqual(filesOnly.calls.map(c => c.namespace), ['fileReferences'])

  const none = fixture({ files: false, sessions: false })
  assert.equal(none.api.available, false)
})

test('unwrapRemote：成功取 value，失败抛出并带上游码，其余原样返回', () => {
  assert.deepEqual(unwrapRemote({ ok: true, value: [1] }), [1])
  assert.deepEqual(unwrapRemote([{ ok: true }]), [{ ok: true }])
  assert.throws(() => unwrapRemote({ ok: false, error: { code: 'x/denied', message: 'no' } }), (error: any) => error.code === 'x/denied')
})

test('候选行按形状过滤并截断到手机上限', () => {
  assert.deepEqual(fileItems([{ path: '', kind: 'file' }, { path: 'a', kind: 'link' }, { path: 'x'.repeat(4097), kind: 'file' }, null]), [])
  assert.equal(fileItems(Array.from({ length: 50 }, (_, i) => ({ path: `f${i}`, kind: 'file' }))).length, FILE_REFERENCE_LIMIT)
  assert.deepEqual(fileItems('nope'), [])

  // mention 必须是规范形状：带换行、错误协议或缺 sessionId 的都丢弃。
  assert.deepEqual(sessionItems([
    { sessionId: 's', label: 'a', mention: '@[a](http://x)' },
    { sessionId: 's', label: 'a', mention: '@[a\nb](dsh-session:s)' },
    { label: 'a', mention },
    { sessionId: 's', label: '', mention },
  ]), [])
  assert.deepEqual(sessionItems([{ sessionId: 's', label: 'a', mention, sameWorkspace: 'yes' }]), [{ sessionId: 's', label: 'a', mention, sameWorkspace: false }])
  assert.equal(sessionItems(Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}`, label: 'a', mention }))).length, SESSION_REFERENCE_LIMIT)
})

test('c2s.session.references 帧：能力、权限与查询形状', () => {
  const row = registryRowFor('c2s.session.references')!
  assert.equal(row.stage, 'authenticated')
  assert.equal(row.widgetPolicy ?? 'deny', 'deny')
  assert.equal(capabilityRejection(row, { references: false } as never)?.code, 'E_UNSUPPORTED')
  assert.equal(capabilityRejection(row, { references: true } as never), undefined)
  assert.equal(scopeRejection(row, new Set())?.code, 'E_FORBIDDEN')
  assert.equal(validatePayload(row, { sessionId: 's' }).ok, false)
  assert.equal(validatePayload(row, { sessionId: 's', query: 'a\nb' }).ok, false)
  assert.equal(validatePayload(row, { sessionId: 's', query: 'x'.repeat(1025) }).ok, false)
  assert.equal(validatePayload(row, { sessionId: 's', query: '' }).ok, true)
})

test('c2s.session.references 帧：回显 sessionId 与 query，失败按桥接码上报', async () => {
  const sent: Array<{ type: string; payload: any; message?: string }> = []
  const value = { files: { available: true, items: [] }, sessions: { available: false, items: [] } }
  let result: any = { ok: true, value }
  const context = {
    bridge: { referenceCandidates: async () => result },
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
    fail: (code: string, message?: string) => sent.push({ type: 'error', payload: code, message }),
  } as unknown as FrameContext
  const row = registryRowFor('c2s.session.references')!
  await row.handle(context, { sessionId: 's', query: 'src/' })
  assert.deepEqual(sent.pop(), { type: 's2c.session.references', payload: { sessionId: 's', query: 'src/', ...value } })
  result = { ok: false, code: 'E_UNSUPPORTED', message: '当前主机不支持引用文件或会话' }
  await row.handle(context, { sessionId: 's', query: '' })
  assert.deepEqual(sent.pop(), { type: 'error', payload: 'E_UNSUPPORTED', message: '当前主机不支持引用文件或会话' })
})
