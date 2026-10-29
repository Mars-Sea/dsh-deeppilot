import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginUpdater, PluginUpdateError, readTargetProtocol, supportsPluginUpdate, updateRegistryPlan, type PluginUpdateRegistries, type PluginManagerForUpdate, type UpdateChangeResult } from '../src/plugin-update.ts'
import { pluginUpdateRows, setPluginUpdater } from '../src/wire-plugin-update.ts'
import type { FrameContext } from '../src/wire-registry.ts'
import { Context, Service } from '@deepseek-ai/cordis'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'

const FROM = '0.9.12', TO = '0.9.13', REGISTRY = 'https://registry.example.test/team/'
const MIRROR = 'https://mirror.example.test/'
const INTEGRITY = 'sha512-' + Buffer.alloc(64, 7).toString('base64')
const manifestFor = (version = TO) => ({ name: 'dsh-deeppilot', version, dsh: { bundle: { patch: './cordis.patch.yml' } },
  deepPilot: { protocolVersion: 2 }, dist: { integrity: INTEGRITY, tarball: REGISTRY + 'download.tgz' } })
const applied = (version: string): UpdateChangeResult => ({ changed: true, application: 'applied', stage: 'enable', target: 'dsh-deeppilot', version })
function fixture() {
  const journalPath = join(mkdtempSync(join(tmpdir(), 'deeppilot-plugin-update-')), 'update-journal.json')
  const calls: { version: string; registry?: string | null; requestId?: string }[] = []
  const manifests: string[] = []
  let bundleVersion = FROM
  const manager: PluginManagerForUpdate = {
    async listVersions() { return { status: 'listed', installed: FROM, registry: REGISTRY, versions: [{ version: TO, bundle: true }] } },
    async registries() { return { registry: REGISTRY, fallbackRegistries: [], resolved: REGISTRY } },
    async listBundles() { return [{ name: 'dsh-deeppilot', version: bundleVersion }] },
    async updateBundle(_name, version, options) {
      calls.push({ version, ...options })
      bundleVersion = version
      return { from: FROM, to: version, step: 'install', result: applied(version) }
    },
  }
  const fetcher: typeof fetch = async (input) => {
    manifests.push(String(input))
    return Response.json(manifestFor())
  }
  const make = (currentVersion = FROM) => new PluginUpdater({ manager, currentVersion, journalPath, fetch: fetcher })
  return { manager, calls, manifests, journalPath, fetcher, make }
}
function dropMemory(path: string) {
  const cells = (globalThis as Record<symbol, unknown>)[Symbol.for('deeppilot.plugin-update.cells.v1')] as Map<string, unknown>
  cells.delete(path)
}

function wireFixture(updater: PluginUpdater, manage = true, bridge = {} as HostBridge) {
  const frames: Array<{ type: string; payload: any }> = []
  const connection = new AbortController()
  setPluginUpdater(bridge, updater)
  const context = {
    bridge, signal: connection.signal, deviceId: 'device-a',
    canReceive: (scope: string) => scope === 'sessions.read' || (manage && scope === 'sessions.manage'),
    send: (type: string, payload: unknown) => { frames.push({ type, payload }) },
    fail: (code: string, message: string) => { frames.push({ type: 's2c.error', payload: { code, message } }) },
  } as unknown as FrameContext
  return { context, frames, connection }
}
const applyRow = pluginUpdateRows.find(row => row.type === 'c2s.plugin.update.apply')!
const checkRow = pluginUpdateRows.find(row => row.type === 'c2s.plugin.update.check')!

test('目标校验和耐久记录先于接受回执，预检中的不同请求返回 E_BUSY', async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const updater = new PluginUpdater({ manager: f.manager, currentVersion: FROM, journalPath: f.journalPath,
    fetch: async (...args) => { await gate; return f.fetcher(...args) } })
  const wire = wireFixture(updater)
  const running = applyRow.handle(wire.context, { version: TO, clientRequestId: 'preflight-1' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(wire.frames.length, 0, '目标尚未核验时不能发 accepted 回执')
  await assert.rejects(updater.apply('device-a', TO, 'preflight-2'), { code: 'E_BUSY' })
  const duplicate = updater.apply('device-a', TO, 'preflight-1')
  release()
  await running
  const accepted = await duplicate
  assert.equal(accepted.phase, 'preparing')
  assert.equal(wire.frames[0]?.type, 's2c.ack')
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).records[0].clientRequestId, 'preflight-1')
  await updater.settled()
  assert.equal(f.calls.length, 1)
  wire.connection.abort()
})

test('候选回退源协议、身份或强摘要分歧及不可读取时，受理前拒绝安装', async () => {
  const mismatches = [
    () => Response.json({ ...manifestFor(), deepPilot: { protocolVersion: 3 } }),
    () => Response.json({ ...manifestFor(), dist: { integrity: 'sha512-' + Buffer.alloc(64, 8).toString('base64') } }),
    () => Response.json({ ...manifestFor(), dist: { integrity: 'sha1-' + Buffer.alloc(20).toString('base64') } }),
    () => Response.json({ ...manifestFor(), dist: {} }),
    () => Response.json({ ...manifestFor(), name: 'other' }),
    () => Response.json({ ...manifestFor(), version: FROM }),
    () => new Response('not found', { status: 404 }),
    () => { throw new Error('upstream secret must not leak') },
  ]
  for (const mismatch of mismatches) {
    const f = fixture()
    f.manager.registries = async () => ({ registry: REGISTRY, fallbackRegistries: [MIRROR], resolved: 'https://registry.npmjs.org/' })
    const updater = new PluginUpdater({ manager: f.manager, currentVersion: FROM, journalPath: f.journalPath,
      fetch: async input => String(input).startsWith(MIRROR) ? mismatch() : Response.json(manifestFor()) })
    const wire = wireFixture(updater)
    await applyRow.handle(wire.context, { version: TO, clientRequestId: 'fallback-1' })
    assert.equal(wire.frames.some(frame => frame.type === 's2c.ack'), false)
    assert.equal(wire.frames.at(-1)?.type, 's2c.error')
    assert.match(wire.frames.at(-1)?.payload.message, /软件源|协议|完整性/)
    assert.doesNotMatch(JSON.stringify(wire.frames), /upstream secret/)
    assert.equal(f.calls.length, 0)
    wire.connection.abort()
  }
})

// 发布包不依赖宿主的可选管理包；本地兼容性审计直接对照指定的真实 alpha2 导出。
const alpha2Manager = process.env.DSH_ALPHA2_PLUGIN_MANAGER ?? ''
test('源计划与真实 alpha2 公开函数一致，覆盖 null、私有源、归一化及二阶段回退',
  { skip: !existsSync(join(alpha2Manager, 'lib/types/registry.js')) }, async () => {
    assert.equal(JSON.parse(readFileSync(join(alpha2Manager, 'package.json'), 'utf8')).version, '0.2.2-alpha.2')
    const host = await import(pathToFileURL(join(alpha2Manager, 'lib/types/registry.js')).href)
    const npm = 'https://registry.npmjs.org/'
    const configurations: PluginUpdateRegistries[] = [
      { registry: null, fallbackRegistries: [MIRROR], resolved: npm },
      { registry: MIRROR, fallbackRegistries: [npm, MIRROR], resolved: npm },
      { registry: null, fallbackRegistries: [MIRROR], resolved: REGISTRY },
      { registry: npm, fallbackRegistries: [MIRROR], resolved: null },
      { registry: 'https://REGISTRY.EXAMPLE.test/team', fallbackRegistries: [REGISTRY, MIRROR], resolved: npm },
    ]
    for (const config of configurations) {
      for (const requested of [undefined, null, npm, MIRROR, REGISTRY, 'https://outside.example.test/']) {
        const planned = updateRegistryPlan(requested, config)
        assert.deepEqual(planned, host.registryPlan(requested, config))
        const resolved = (source: string | null) => source === null ? config.resolved : source
        for (const hit of planned) {
          for (const next of host.registryPlan(hit, config)) assert.ok(planned.map(resolved).includes(resolved(next)))
        }
      }
    }
  })

test('全部候选源协议及强摘要一致时允许更新，镜像下载地址可不同', async () => {
  const f = fixture(), seen: string[] = []
  f.manager.registries = async () => ({ registry: REGISTRY, fallbackRegistries: [MIRROR, MIRROR], resolved: 'https://registry.npmjs.org/' })
  const updater = new PluginUpdater({ manager: f.manager, currentVersion: FROM, journalPath: f.journalPath, fetch: async input => {
    seen.push(String(input))
    return Response.json({ ...manifestFor(), dist: { integrity: INTEGRITY, tarball: String(input) + '.tgz' } })
  } })
  await updater.apply('device-a', TO, 'same-facts-1')
  assert.deepEqual(seen, [REGISTRY + 'dsh-deeppilot/' + TO, MIRROR + 'dsh-deeppilot/' + TO])
  await updater.settled()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].registry, REGISTRY)
})

test('私有默认源及配置集合外的源保持单源，不访问宿主不会尝试的公共源', async () => {
  for (const privateDefault of [true, false]) {
    const f = fixture(), seen: string[] = []
    f.manager.registries = async () => privateDefault
      ? { registry: null, fallbackRegistries: [MIRROR], resolved: REGISTRY }
      : { registry: 'https://registry.npmjs.org/', fallbackRegistries: [MIRROR], resolved: 'https://registry.npmjs.org/' }
    f.manager.listVersions = async () => ({ status: 'listed', installed: FROM, registry: privateDefault ? null : REGISTRY, versions: [{ version: TO, bundle: true }] })
    const updater = new PluginUpdater({ manager: f.manager, currentVersion: FROM, journalPath: f.journalPath, fetch: async input => {
      seen.push(String(input))
      assert.equal(String(input), REGISTRY + 'dsh-deeppilot/' + TO)
      return Response.json(manifestFor())
    } })
    await updater.apply('device-a', TO, 'private-1')
    await updater.settled()
    assert.equal(f.calls[0].registry, privateDefault ? null : REGISTRY)
    assert.equal(seen.length, 1)
  }
})

test('无法解析默认源及预检期间源配置变化时拒绝安装', async () => {
  for (const changed of [false, true]) {
    const f = fixture()
    let lookups = 0
    f.manager.listVersions = async () => ({ status: 'listed', installed: FROM, registry: changed ? REGISTRY : null, versions: [{ version: TO, bundle: true }] })
    f.manager.registries = async () => ({ registry: changed ? REGISTRY : null,
      fallbackRegistries: changed && ++lookups > 1 ? [MIRROR] : [], resolved: changed ? 'https://registry.npmjs.org/' : null })
    const updater = f.make()
    await assert.rejects(updater.apply('device-a', TO, 'registry-changed-1'), PluginUpdateError)
    assert.equal(f.calls.length, 0)
  }
})

test('只读 check 不订阅管理进度，manage 观察者能收到更新终态', async () => {
  assert.deepEqual(checkRow.scopes, ['sessions.read'])
  const f = fixture(), updater = f.make()
  const reader = wireFixture(updater, false)
  const manager = wireFixture(updater)
  await checkRow.handle(reader.context, {})
  await checkRow.handle(manager.context, {})
  await applyRow.handle(manager.context, { version: TO, clientRequestId: 'scope-1' })
  await updater.settled()
  assert.equal(reader.frames.filter(frame => frame.type === 's2c.plugin.update.status').length, 1)
  assert.equal(reader.frames.some(frame => frame.type === 's2c.plugin.update.progress'), false)
  assert.ok(manager.frames.some(frame => frame.payload.phase === 'restart-required'))
  reader.connection.abort()
  manager.connection.abort()
})

test('并发失败及历史终态重放不会注销同连接当前更新的共享观察者', async () => {
  for (const replayHistory of [false, true]) {
    const f = fixture()
    if (replayHistory) writeFileSync(f.journalPath, JSON.stringify({ version: 1, records: [{ clientRequestId: 'history-1', fromVersion: FROM, toVersion: TO,
      phase: 'failed', startedAt: Date.now(), message: '旧更新失败', ownerKey: (await import('node:crypto')).createHash('sha256').update('device-a').digest('hex') }] }))
    let finish!: () => void, start!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const started = new Promise<void>(resolve => { start = resolve })
    const original = f.manager.updateBundle
    f.manager.updateBundle = async (...args) => { start(); await gate; return original(...args) }
    const updater = f.make(), wire = wireFixture(updater)
    await applyRow.handle(wire.context, { version: TO, clientRequestId: 'observed-1' })
    await started
    await applyRow.handle(wire.context, { version: TO, clientRequestId: replayHistory ? 'history-1' : 'other-1' })
    if (!replayHistory) assert.equal(wire.frames.at(-1)?.payload.code, 'E_BUSY')
    finish()
    await updater.settled()
    assert.equal(wire.frames.filter(frame => frame.type === 's2c.plugin.update.progress' && frame.payload.clientRequestId === 'observed-1' && frame.payload.phase === 'restart-required').length, 1)
    wire.connection.abort()
  }
})

test('checking is read-only and uses exact version metadata from the listing registry', async () => {
  const f = fixture(), updater = f.make()
  const status = await updater.check('device-a')
  assert.equal(status.currentVersion, FROM)
  assert.deepEqual(status.versions, [{ version: TO, compatible: true, protocolVersion: 2 }])
  assert.equal(status.protocolCompatible, true)
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.manifests, [REGISTRY + 'dsh-deeppilot/' + TO])
})

test('real incompatible is an optional object; bundle=false and missing protocol stay unselectable', async () => {
  const f = fixture()
  f.manager.listVersions = async () => ({ status: 'listed', installed: FROM, registry: REGISTRY, versions: [
    { version: TO, bundle: true, incompatible: { name: 'dsh-deeppilot', version: TO, runtimeVersion: '0.1.0', requirements: { 'engines.dsh': '>=1' } } },
  ] })
  const updater = f.make()
  assert.equal((await updater.check('device-a')).compatible, false)
  await assert.rejects(updater.apply('device-a', TO, 'incompatible-1'), { code: 'E_UNSUPPORTED' })
  await updater.settled()
  assert.equal(f.calls.length, 0)
  assert.equal((await updater.check('device-a')).journal, undefined)
})

test('self-unload leaves the operation running; a new module instance sees the final result', async () => {
  const f = fixture()
  let start!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const paused = new Promise<void>(resolve => { finish = resolve })
  const original = f.manager.updateBundle
  f.manager.updateBundle = async (...args) => { start(); await paused; return original(...args) }
  const oldModule = f.make()
  const progress: string[] = []
  const unsubscribe = oldModule.subscribe('device-a', event => progress.push(event.phase))
  const accepted = await oldModule.apply('device-a', TO, 'hmr-1')
  assert.equal(accepted.phase, 'preparing')
  assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).records[0].clientRequestId, 'hmr-1')
  await started
  unsubscribe() // Old connection/plugin disposal must not cancel the host task.
  const newModule = f.make(TO)
  assert.equal((await newModule.check('device-a')).journal?.phase, 'installing')
  finish()
  await oldModule.settled()
  const status = await newModule.check('device-a')
  assert.equal(status.journal?.phase, 'done')
  assert.equal(status.journal?.clientRequestId, 'hmr-1')
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].registry, REGISTRY)
  assert.ok(progress.includes('installing'))
  assert.equal((await newModule.apply('device-a', TO, 'hmr-1')).phase, 'done')
  assert.equal(f.calls.length, 1)
})

test('duplicate request ids join one durable update and reject changed target or owner', async () => {
  const f = fixture(), updater = f.make()
  await Promise.all([updater.apply('device-a', TO, 'once-1'), updater.apply('device-a', TO, 'once-1')])
  await assert.rejects(updater.apply('device-a', '0.9.14', 'once-1'), (e: unknown) => e instanceof PluginUpdateError && e.code === 'E_PROTOCOL')
  await assert.rejects(updater.apply('device-b', TO, 'once-1'), (e: unknown) => e instanceof PluginUpdateError && e.code === 'E_FORBIDDEN')
  await assert.rejects(updater.apply('device-a', TO, 'once-2'), /正在进行/)
  await updater.settled()
  assert.equal(f.calls.length, 1)
  assert.equal((await updater.check('device-b')).journal, undefined)
})

test('protocol mismatch, absent declaration, wrong manifest identity and credentialed URL never install', async () => {
  for (const manifest of [
    { name: 'dsh-deeppilot', version: TO, dsh: { bundle: {} }, deepPilot: { protocolVersion: 3 } },
    { name: 'dsh-deeppilot', version: TO, dsh: { bundle: {} } },
    { name: 'other', version: TO, dsh: { bundle: {} }, deepPilot: { protocolVersion: 2 } },
    { name: 'dsh-deeppilot', version: FROM, dsh: { bundle: {} }, deepPilot: { protocolVersion: 2 } },
  ]) {
    const f = fixture()
    const updater = new PluginUpdater({ manager: f.manager, currentVersion: FROM, journalPath: f.journalPath, fetch: async () => Response.json(manifest) })
    await assert.rejects(updater.apply('device-a', TO, 'protocol-1'), PluginUpdateError)
    await updater.settled()
    assert.equal(f.calls.length, 0)
    assert.equal((await updater.check('device-a')).journal, undefined)
  }
  let fetched = false
  await assert.rejects(readTargetProtocol('https://secret:token@registry.example.test/', TO, async () => { fetched = true; throw new Error('unreachable') }))
  assert.equal(fetched, false)
})

test('non-HMR installation reports restart-required and reconnect after real restart reports done', async () => {
  const f = fixture()
  f.manager.updateBundle = async () => ({ from: FROM, to: TO, step: 'install', result: { ...applied(TO), application: 'restart-required', restartReason: 'no-hmr' } })
  const updater = f.make()
  await updater.apply('device-a', TO, 'restart-1')
  await updater.settled()
  assert.equal((await updater.check('device-a')).journal?.phase, 'restart-required')
  assert.equal((await f.make(TO).check('device-a')).journal?.phase, 'restart-required', 'a same-process module reload does not satisfy a host restart')
  dropMemory(f.journalPath)
  const restarted = f.make(TO)
  assert.equal((await restarted.check('device-a')).journal?.phase, 'done')
  assert.equal((await restarted.apply('device-a', TO, 'restart-1')).phase, 'done')
})

test('host applied without observed reload remains restart-required', async () => {
  const f = fixture(), updater = f.make()
  await updater.apply('device-a', TO, 'no-reload-1')
  await updater.settled()
  assert.equal((await updater.check('device-a')).journal?.phase, 'restart-required')
})

test('automatic rollback distinguishes applied, pending restart and failed restoration', async () => {
  for (const [application, phase] of [['applied', 'rolled-back'], ['restart-required', 'restart-required'], ['failed', 'failed']] as const) {
    const f = fixture()
    f.manager.updateBundle = async () => ({ from: FROM, to: TO, step: 'install',
      result: { ...applied(TO), application: 'failed', stage: 'enable' },
      restore: { ...applied(FROM), application } })
    const updater = f.make()
    await updater.apply('device-a', TO, 'restore-1')
    await updater.settled()
    assert.equal((await updater.check('device-a')).journal?.phase, phase)
    dropMemory(f.journalPath)
    assert.equal((await f.make().check('device-a')).journal?.phase, application === 'restart-required' ? 'rolled-back' : phase)
  }
})

test('interrupted journal is retained with request correlation and never automatically retried', async () => {
  const f = fixture()
  writeFileSync(f.journalPath, JSON.stringify({ version: 1, records: [{ clientRequestId: 'crash-1', fromVersion: FROM, toVersion: TO,
    phase: 'installing', startedAt: Date.now(), message: '安装中', ownerKey: (await import('node:crypto')).createHash('sha256').update('device-a').digest('hex') }] }))
  const updater = f.make()
  assert.equal((await updater.check('device-a')).journal?.phase, 'failed')
  assert.match((await updater.apply('device-a', TO, 'crash-1')).message, /无法确认/)
  await updater.settled()
  assert.equal(f.calls.length, 0)
})

test('damaged journal fails closed and registry errors do not leak credentials', async () => {
  const f = fixture()
  writeFileSync(f.journalPath, 'not-json')
  f.manager.listVersions = async () => { throw new Error('https://secret:token@example.test/ authToken=supersecret') }
  const updater = f.make()
  const status = await updater.check('device-a')
  assert.doesNotMatch(JSON.stringify(status), /secret|token/)
  await assert.rejects(updater.apply('device-a', TO, 'damaged-1'), /更新日志无法读取/)
  assert.equal(f.calls.length, 0)
  assert.equal(readFileSync(f.journalPath, 'utf8'), 'not-json')
  assert.equal(supportsPluginUpdate({ listVersions() {} }), false)
  assert.equal(supportsPluginUpdate(f.manager), true)
})

test('wire reconnect check receives the terminal outcome after the original socket is gone', async () => {
  const f = fixture()
  let start!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const paused = new Promise<void>(resolve => { finish = resolve })
  const original = f.manager.updateBundle
  f.manager.updateBundle = async (...args) => { start(); await paused; return original(...args) }
  const oldModule = f.make(), oldBridge = {} as HostBridge
  setPluginUpdater(oldBridge, oldModule)
  const frames: Array<{ type: string; payload: any }> = []
  const oldConnection = new AbortController()
  const context = (bridge: HostBridge, signal: AbortSignal) => ({
    bridge, signal, deviceId: 'device-a', canReceive: () => true,
    send(type: string, payload: unknown) { frames.push({ type, payload }) },
    fail(code: string, message: string) { assert.fail(code + ': ' + message) },
  }) as unknown as FrameContext
  const apply = pluginUpdateRows.find(row => row.type === 'c2s.plugin.update.apply')!
  const check = pluginUpdateRows.find(row => row.type === 'c2s.plugin.update.check')!
  assert.deepEqual(apply.scopes, ['sessions.manage'])
  assert.equal(apply.widgetPolicy, 'deny')
  assert.equal(apply.validate?.({ version: TO, clientRequestId: [] }).ok, false)
  await apply.handle(context(oldBridge, oldConnection.signal), { version: TO, clientRequestId: 'wire-hmr-1' })
  assert.equal(frames[0].type, 's2c.ack')
  assert.equal(frames[0].payload.accepted, true)
  await started
  oldConnection.abort()
  const newModule = f.make(TO), newBridge = {} as HostBridge
  setPluginUpdater(newBridge, newModule)
  const reconnected = new AbortController()
  const newContext = context(newBridge, reconnected.signal)
  await check.handle(newContext, {})
  await check.handle(newContext, {}) // One observer despite repeated checks.
  assert.equal(frames.at(-1)?.payload.journal.phase, 'installing')
  frames.length = 0
  finish()
  await oldModule.settled()
  const done = frames.filter(frame => frame.type === 's2c.plugin.update.progress' && frame.payload.phase === 'done')
  assert.equal(done.length, 1)
  assert.equal(done[0].payload.clientRequestId, 'wire-hmr-1')
  await apply.handle(newContext, { version: TO, clientRequestId: 'wire-hmr-1' })
  assert.equal(frames.at(-1)?.payload.phase, 'done', 'duplicate emits durable outcome as well as ACK')
  reconnected.abort()
})

test('真实 Cordis 卸载消费上下文并重绑新 Bridge，宿主操作持续且恢复成功或回滚结果', { timeout: 10_000 }, async () => {
  for (const rollback of [false, true]) {
    const f = fixture(), root = new Context()
    root.provide('sessionController', {})
    // 管理器归根上下文所有；只替换消费它的插件，完全不读写真实 profile。
    class FakeManager extends Service implements PluginManagerForUpdate {
      constructor(ctx: Context) { super(ctx, 'pluginManager') }
      listVersions(name: string) { return f.manager.listVersions(name) }
      registries() { return f.manager.registries() }
      listBundles() { return f.manager.listBundles() }
      updateBundle(name: string, version: string, options?: { registry?: string | null; requestId?: string }) { return f.manager.updateBundle(name, version, options) }
    }
    new FakeManager(root)
    type Mounted = ReturnType<typeof wireFixture> & { updater: PluginUpdater; bridge: HostBridge }
    const fibers: Array<ReturnType<Context['plugin']>> = []
    const load = (version: string) => {
      let ready!: (mounted: Mounted) => void
      const mounted = new Promise<Mounted>(resolve => { ready = resolve })
      const fiber = root.plugin({
        name: 'deeppilot-update-lifecycle-test',
        apply(ctx: Context) {
          ctx.inject(['pluginManager'], scope => {
            const manager = scope.get('pluginManager') as unknown as PluginManagerForUpdate
            const updater = new PluginUpdater({ manager, currentVersion: version, journalPath: f.journalPath, fetch: f.fetcher })
            const bridge = new HostBridge(new DshApiProxy(scope), 100)
            const wire = wireFixture(updater, true, bridge)
            scope.effect(() => () => {
              wire.connection.abort()
              setPluginUpdater(bridge, undefined)
              bridge.dispose()
            }, '测试插件连接与桥接释放')
            ready({ ...wire, updater, bridge })
          })
        },
      })
      fibers.push(fiber)
      return { fiber, mounted }
    }
    const old = load(FROM)
    await old.fiber
    const previous = await old.mounted
    let start!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let reloaded!: Mounted
    const original = f.manager.updateBundle
    f.manager.updateBundle = async (...args) => {
      // 模拟宿主在 remove 阶段真正 dispose 旧插件，安装阶段绑定新实例后再返回结果。
      await old.fiber.dispose()
      assert.equal(previous.connection.signal.aborted, true)
      assert.ok(root.get('pluginManager'))
      const next = load(rollback ? FROM : TO)
      await next.fiber
      reloaded = await next.mounted
      assert.notEqual(reloaded.bridge, previous.bridge)
      await checkRow.handle(reloaded.context, {})
      assert.equal(reloaded.frames.at(-1)?.payload.journal.phase, 'installing')
      start()
      await gate
      if (!rollback) return original(...args)
      f.calls.push({ version: args[1], ...args[2] })
      return { from: FROM, to: TO, step: 'install', result: { ...applied(TO), application: 'failed' }, restore: applied(FROM) }
    }
    try {
      await applyRow.handle(previous.context, { version: TO, clientRequestId: 'cordis-hmr-1' })
      await started
      const oldFrames = previous.frames.length
      release()
      await previous.updater.settled()
      const phase = rollback ? 'rolled-back' : 'done'
      const terminalFrames = reloaded.frames.filter(frame => frame.type === 's2c.plugin.update.progress' && frame.payload.phase === phase)
      assert.equal(terminalFrames.length, 1)
      assert.equal(previous.frames.length, oldFrames, '旧连接释放后不再收到宿主异步进度')
      assert.equal((await reloaded.updater.check('device-a')).journal?.phase, phase)
      await applyRow.handle(reloaded.context, { version: TO, clientRequestId: 'cordis-hmr-1' })
      assert.equal(reloaded.frames.at(-1)?.payload.phase, phase)
      assert.equal(f.calls.length, 1)
      assert.equal(JSON.parse(readFileSync(f.journalPath, 'utf8')).records[0].phase, phase)
    } finally {
      release()
      await Promise.all(fibers.map(fiber => fiber.dispose()))
    }
  }
})

test('journal reservation failure prevents any host mutation', async () => {
  const f = fixture()
  writeFileSync(f.journalPath, 'path-blocker')
  const updater = new PluginUpdater({ manager: f.manager, currentVersion: FROM, journalPath: join(f.journalPath, 'blocked.json'), fetch: f.fetcher })
  await assert.rejects(updater.apply('device-a', TO, 'disk-1'), /尚未开始安装/)
  await updater.settled()
  assert.equal(f.calls.length, 0)
  assert.equal(readFileSync(f.journalPath, 'utf8'), 'path-blocker')
  assert.equal((await updater.check('device-a')).journal, undefined, '未受理请求不能留下内存日志')
  // 只解除本用例刚创建的临时阻塞文件，模拟磁盘恢复后以同编号重试。
  unlinkSync(f.journalPath)
  mkdirSync(f.journalPath)
  await updater.apply('device-a', TO, 'disk-1')
  await updater.settled()
  assert.equal(f.calls.length, 1)
})
