import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DshApiProxy } from '../src/dsh-api-proxy.ts'
import { HostBridge } from '../src/host-bridge.ts'
import { registryRowFor, scopeRejection, type FrameContext } from '../src/wire-registry.ts'

function fixture(picker?: unknown) {
  const services = new Map<string, unknown>([['sessionController', {}]])
  if (picker !== undefined) services.set('directoryPickerController', picker)
  const proxy = new DshApiProxy({ get: (key: string) => services.get(key) } as never, { allowFileBrowse: () => false })
  const bridge = new HostBridge(proxy, 100)
  return { services, proxy, bridge }
}

test('phone directory RPC works with a native-only host and leaves its picker untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deeppilot-directory-rpc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project'))
  await writeFile(join(root, 'file.txt'), 'not a directory')
  let listCalls = 0
  const picker = { list: () => { listCalls++; throw new Error('native picker cannot browse') }, pick: async () => null }
  const { bridge, services } = fixture(picker)
  t.after(() => bridge.dispose())
  const sent: Array<{ type: string; payload: unknown }> = []
  const context = {
    bridge,
    send: (type: string, payload: unknown) => sent.push({ type, payload }),
    fail: (code: string, message?: string) => assert.fail(`${code}: ${message}`),
  } as unknown as FrameContext
  await registryRowFor('c2s.directory.list')!.handle(context, { path: root })
  assert.equal(sent[0]!.type, 's2c.directory.listing')
  assert.deepEqual((sent[0]!.payload as { entries: unknown[] }).entries,
    [{ name: 'project', path: join(root, 'project'), hidden: false }])
  assert.equal(listCalls, 0)
  assert.equal(services.get('directoryPickerController'), picker)
})

test('phone browsing remains available without any host picker; invalid paths retain wire errors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'deeppilot-directory-rpc-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const { bridge, proxy } = fixture()
  t.after(() => bridge.dispose())
  const listing = await bridge.listDirectory(root)
  assert.equal(listing.ok, true)
  if (listing.ok) {
    assert.equal(listing.value.path, root)
    assert.deepEqual(listing.value.entries, [])
    assert.equal(listing.value.truncated, false)
  }
  const invalid = await proxy.host!.listDirectory!({ payload: { path: 'relative/path' } })
  assert.equal(invalid.result?.ok, false)
  if (invalid.result && !invalid.result.ok) assert.equal(invalid.result.error.code, 'directory-unreadable')
  const native = await bridge.pickDirectory()
  assert.equal(native.ok, false)
  if (!native.ok) assert.equal(native.code, 'E_UNSUPPORTED')
})

test('native selection preserves chosen path, cancellation, lifetime and controller remount', async t => {
  const { bridge, proxy, services } = fixture()
  t.after(() => bridge.dispose())
  const controller = new AbortController()
  let seen: AbortSignal | undefined
  services.set('directoryPickerController', { pick: async (signal: AbortSignal) => { seen = signal; return '/chosen' } })
  assert.deepEqual(await proxy.host!.pickDirectory!({ payload: {} }, controller.signal),
    { result: { ok: true, value: { path: '/chosen' } } })
  assert.equal(seen, controller.signal)
  services.set('directoryPickerController', { pick: async () => null })
  assert.deepEqual(await bridge.pickDirectory(), { ok: true, value: null })
  services.delete('directoryPickerController')
  assert.equal((await bridge.pickDirectory()).ok, false)
})

test('directory browsing forwards cancellation and both directory verbs retain manage authorization', async t => {
  const { proxy, bridge } = fixture()
  t.after(() => bridge.dispose())
  const controller = new AbortController()
  controller.abort(Object.assign(new Error('departed'), { code: 'aborted' }))
  const reply = await proxy.host!.listDirectory!({ payload: { path: '/unused' } }, controller.signal)
  assert.deepEqual(reply, { result: { ok: false, error: { code: 'aborted', message: 'departed' } } })
  for (const verb of ['c2s.directory.list', 'c2s.directory.pick']) {
    const row = registryRowFor(verb)!
    assert.equal(row.stage, 'authenticated')
    assert.equal(scopeRejection(row, new Set(['sessions.read']))?.code, 'E_FORBIDDEN')
    assert.equal(scopeRejection(row, new Set(['sessions.manage'])), undefined)
  }
})
