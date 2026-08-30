import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DeviceStore, MAX_DEVICES } from '../src/token.ts'
import { createTestIdentity } from './auth-fixture.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pbb-token-'))
}

test('device registry is capped and refuses silent identity eviction', async () => {
  const dir = await makeTempDir()
  try {
    const store = await DeviceStore.load(join(dir, 'devices.json'))
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
