import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helloTokenAccepted } from '../src/connection.ts'
import { Config, requestToken } from '../src/index.ts'
import { bridgeDataDir, ensurePrivateBridgeDataDir, migrateLegacyBridgeDataDir } from '../src/token.ts'
import { requestClientIdentity } from '../src/phone-http.ts'

const expected = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'

test('HTTP authentication accepts Bearer and rejects URL credentials', () => {
  assert.equal(requestToken({ url: '/phone', headers: { authorization: `Bearer ${expected}` } }), expected)
  assert.equal(requestToken({ url: `/phone?token=${expected}`, headers: {} }), null)
  assert.equal(requestToken({ url: '/phone', headers: {} }), null)
  assert.equal(requestToken({
    url: '/phone?token=legacy',
    headers: { authorization: `Bearer ${expected}` },
  }), expected)
})

test('forwarded client identity is trusted only from the loopback helper', () => {
  const helper = {
    headers: { 'x-deeppilot-client-ip': '203.0.113.8' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const direct = {
    headers: { 'x-deeppilot-client-ip': '203.0.113.8' },
    socket: { remoteAddress: '192.0.2.4' },
  }
  assert.equal(requestClientIdentity(helper as never), '203.0.113.8')
  assert.equal(requestClientIdentity(direct as never), '192.0.2.4')
})

test('hello authentication requires the token only for an untrusted upgrade', () => {
  assert.equal(helloTokenAccepted(true, undefined, expected), true)
  assert.equal(helloTokenAccepted(false, expected, expected), true)
  assert.equal(helloTokenAccepted(false, 'wrong', expected), false)
  assert.equal(helloTokenAccepted(undefined, undefined, expected), false)
})

test('configuration rejects unsupported providers and Funnel ports', () => {
  assert.throws(() => Config({ remote: { provider: 'typo' } } as never), TypeError)
  assert.throws(() => Config({ remote: { funnelPort: 444 } } as never), TypeError)
  assert.throws(() => Config({ push: { provider: 'apnz' } } as never), TypeError)
  assert.throws(() => Config({ remote: { maxConnectionsPerSource: 0 } } as never), TypeError)
  assert.throws(() => Config({ remote: { maxConnectionsPerSource: 17 } } as never), TypeError)
  assert.throws(() => Config({ remote: { maxConnectionsPerSource: 1.5 } } as never), TypeError)
  assert.equal(Config({ remote: { funnelPort: 8443 }, push: { provider: 'relay' } }).remote.funnelPort, 8443)
  assert.equal(Config({}).remote.maxConnectionsPerSource, 8)
  assert.equal(Config({ remote: { maxConnectionsPerSource: 12 } }).remote.maxConnectionsPerSource, 12)
})

test('bridge data is stored under the deeppilot directory', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/deeppilot-test-home'
    assert.equal(bridgeDataDir(), '/tmp/deeppilot-test-home/deeppilot')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('legacy plugin state migrates without overwriting canonical data', async () => {
  const previous = process.env.DSH_HOME
  const root = await mkdtemp(join(tmpdir(), 'deeppilot-migration-'))
  try {
    process.env.DSH_HOME = root
    const legacy = join(root, 'pocket-bridge')
    await mkdir(legacy)
    await writeFile(join(legacy, 'auth-token'), expected)
    assert.equal(await migrateLegacyBridgeDataDir(), legacy)
    assert.equal(await readFile(join(root, 'deeppilot', 'auth-token'), 'utf8'), expected)

    await mkdir(legacy)
    await writeFile(join(legacy, 'devices.json'), 'legacy')
    assert.equal(await migrateLegacyBridgeDataDir(), null)
    await assert.rejects(() => readFile(join(root, 'deeppilot', 'devices.json'), 'utf8'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('canonical bridge directory permissions are repaired to 0700', async () => {
  const previous = process.env.DSH_HOME
  const root = await mkdtemp(join(tmpdir(), 'deeppilot-mode-'))
  try {
    process.env.DSH_HOME = root
    const target = bridgeDataDir()
    await mkdir(target, { mode: 0o755 })
    await ensurePrivateBridgeDataDir()
    assert.equal((await stat(target)).mode & 0o777, 0o700)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
