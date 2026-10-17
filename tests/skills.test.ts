import assert from 'node:assert/strict'
import test from 'node:test'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import { capabilityRejection, registryRowFor, scopeRejection, validatePayload } from '../src/wire-registry.ts'
import { pushScopeFor } from '../src/connection-policy.ts'
import type { ApiProxyLike, MuxFrameLike } from '../src/host-api.ts'

test('目录和会话变更经过既有推送权限门，且不暴露目录内容', async () => {
  const events: MuxFrameLike[] = [
    { type: 'skills/changed' },
    { type: 'session/projection', sessionId: 's', key: 'workingDirectory', value: '/private/project' },
    { type: 'session/event', sessionId: 's', event: { type: 'agent-preset/selected', seq: 1, data: { private: 'preset' } } },
  ]
  const proxy = {
    sessions: { list: async () => ({ result: { ok: true, value: { items: [] } } }) },
    events: { host: async function* () {}, mux: async function* () { yield* events } },
  } as unknown as ApiProxyLike
  const bridge = new HostBridge(proxy, 100)
  const received: unknown[] = []
  const denied: unknown[] = []
  for (const [allowed, output] of [[true, received], [false, denied]] as const) {
    bridge.addSink({
      push: (type, payload) => { if (type === 's2c.skills.changed') output.push(payload) },
      canReceive: () => allowed, lastCursor: () => 0, replay: () => {}, replayDone: () => {}, resync: () => {},
    })
  }
  bridge.start()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(received, [{}, { sessionId: 's' }, { sessionId: 's' }])
  assert.deepEqual(denied, [])
  bridge.dispose()
})

test('技能目录按会话读取、传入取消信号，且晚挂载服务可恢复能力', async () => {
  const services: Record<string, unknown> = { sessionController: {} }
  const proxy = new DshApiProxy({ get: (key: string) => services[key] } as never)
  const bridge = new HostBridge(proxy, 100)
  assert.equal(bridge.capabilities.skills, false)
  assert.equal((await bridge.sessionSkills('one')).ok, false)
  services.sessionSkillCatalog = {
    list: async (request: { sessionId: string }, signal: AbortSignal) => {
      assert.ok(signal instanceof AbortSignal)
      assert.deepEqual(request, { sessionId: 'two' })
      return { skills: [{ name: 'review', description: '检查代码', modelInvocable: false, path: '/private/SKILL.md', body: '不应传送的正文' }] }
    },
  }
  assert.equal(bridge.capabilities.skills, true)
  assert.deepEqual(await bridge.sessionSkills('two'), {
    ok: true, value: { skills: [{ name: 'review', description: '检查代码', modelInvocable: false }] },
  })
  delete services.sessionSkillCatalog
  assert.equal(bridge.capabilities.skills, false)
  bridge.dispose()
})

test('目录帧要求读取权限，旧主机降级，非法会话被拒绝', () => {
  const row = registryRowFor('c2s.session.skills')!
  assert.deepEqual(row.scopes, ['sessions.read'])
  assert.equal(scopeRejection(row, new Set(['prompt.send']))?.code, 'E_FORBIDDEN')
  assert.equal(validatePayload(row, {}).ok, false)
  assert.equal(validatePayload(row, { sessionId: '' }).ok, false)
  assert.equal(validatePayload(row, { sessionId: 's' }).ok, true)
  assert.equal(capabilityRejection(row, { skills: false } as never)?.code, 'E_UNSUPPORTED')
  assert.equal(pushScopeFor('s2c.skills.changed'), 'sessions.read')
})

test('技能路径不能充当可调用名称，主机错误保留分类', async () => {
  const services: Record<string, unknown> = { sessionController: {}, sessionSkillCatalog: {
    list: async () => ({ skills: [{ name: '../secret', description: 'bad', modelInvocable: true }] }),
  } }
  const proxy = new DshApiProxy({ get: (key: string) => services[key] } as never)
  const bridge = new HostBridge(proxy, 100)
  assert.equal((await bridge.sessionSkills('s')).ok, false)
  services.sessionSkillCatalog = { list: async () => { throw Object.assign(new Error('gone'), { code: 'session/not-found' }) } }
  assert.deepEqual(await bridge.sessionSkills('missing'), { ok: false, code: 'E_NOT_FOUND', message: 'gone' })
  bridge.dispose()
})
