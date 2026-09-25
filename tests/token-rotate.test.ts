import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeviceStore, MAX_DEVICES, deviceDisplayName } from '../src/token.ts'
import { createTestIdentity } from './auth-fixture.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pbb-token-'))
}

test('device registry is capped and refuses silent identity eviction', async () => {
  const dir = await makeTempDir()
  const store = await DeviceStore.load(join(dir, 'devices.json'))
  try {
    for (let i = 0; i < MAX_DEVICES; i++) {
      const identity = createTestIdentity()
      store.register({ publicKey: identity.publicKey, deviceName: `Phone ${i}`, appVersion: '0.1.0' }, i + 1)
    }
    const rows = store.list()
    assert.equal(rows.length, MAX_DEVICES, 'registry stays at the cap')
    const overflow = createTestIdentity()
    assert.throws(
      () => store.register({ publicKey: overflow.publicKey, deviceName: 'Overflow', appVersion: '0.1.0' }, 10_000),
      /registry is full/,
    )
    assert.deepEqual(store.list().map((row) => row.deviceId), rows.map((row) => row.deviceId))
  } finally {
    await store.drain()
    await rm(dir, { recursive: true, force: true })
  }
})

test('device scopes update and revocation fail closed', async () => {
  const dir = await makeTempDir()
  try {
    const store = await DeviceStore.load(join(dir, 'devices-v2.json'))
    const identity = createTestIdentity()
    const paired = store.register({
      publicKey: identity.publicKey,
      deviceName: 'iPhone',
      appVersion: '2.0',
    }, 1)
    assert.deepEqual(store.setScopes(paired.deviceId, ['sessions.read', 'prompt.send', 'invalid']), [
      'sessions.read',
      'prompt.send',
    ])
    assert.deepEqual(store.authorized(paired.deviceId)?.scopes, ['sessions.read', 'prompt.send'])
    assert.equal(store.revoke(paired.deviceId, 2), true)
    assert.equal(store.authorized(paired.deviceId), undefined)
    assert.equal(store.setScopes(paired.deviceId, ['sessions.read']), null)
    await store.drain()
    const reloaded = await DeviceStore.load(join(dir, 'devices-v2.json'))
    assert.equal(reloaded.authorized(paired.deviceId), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('custom device names persist, survive reconnects, and can be cleared', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'devices-v2.json')
    const store = await DeviceStore.load(path)
    const identity = createTestIdentity()
    const paired = store.register({
      publicKey: identity.publicKey,
      deviceName: 'iPhone',
      appVersion: '1.0',
    }, 1)

    assert.equal(await store.setCustomName(paired.deviceId, '  工作手机  '), '工作手机')
    store.markAuthenticated(paired.deviceId, 'iPhone 15 Pro', '1.1', 2)
    assert.equal(deviceDisplayName(store.authorized(paired.deviceId)!), '工作手机')
    await store.drain()

    const reloaded = await DeviceStore.load(path)
    assert.equal(reloaded.list()[0]?.customName, '工作手机')
    assert.equal(deviceDisplayName(reloaded.list()[0]!), '工作手机')

    assert.equal(await store.setCustomName(paired.deviceId, null), 'iPhone 15 Pro')
    await store.drain()
    assert.equal((await DeviceStore.load(path)).list()[0]?.customName, undefined)

    assert.equal(store.revoke(paired.deviceId, 3), true)
    assert.equal(await store.setCustomName(paired.deviceId, 'blocked'), null)
    await store.drain()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrent registrations never leave a half-written devices-v2.json behind', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'devices-v2.json')
    const store = await DeviceStore.load(path)
    // Fire 40 registrations with no awaiting in between; serialized flushes must
    // still land a parseable document.
    for (let i = 0; i < 40; i++) {
      const identity = createTestIdentity()
      store.register({ publicKey: identity.publicKey, deviceName: `N${i}`, appVersion: '1' }, i)
    }
    await store.drain()
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { version: number; devices: Array<{ deviceId: string }> }
    assert.equal(parsed.version, 2)
    assert.equal(new Set(parsed.devices.map((d) => d.deviceId)).size, 40)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
