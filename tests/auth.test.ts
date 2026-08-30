import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sign } from 'node:crypto'
import { Config } from '../src/index.ts'
import { bridgeDataDir, ensurePrivateBridgeDataDir, migrateLegacyBridgeDataDir } from '../src/token.ts'
import { requestClientIdentity } from '../src/phone-http.ts'
import { PairingCodeManager, canonicalAuthChallenge, deviceIdForPublicKey, verifyAuthProof } from '../src/device-auth.ts'
import { createTestIdentity } from './auth-fixture.ts'

test('single-use pairing grants expire and cannot be replayed', () => {
  const manager = new PairingCodeManager()
  const grant = manager.issue(1_000)
  assert.equal(manager.consume(grant.code, 1_001), true)
  assert.equal(manager.consume(grant.code, 1_002), false)
  const expired = manager.issue(2_000)
  assert.equal(manager.consume(expired.code, expired.expiresAt + 1), false)
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

test('P-256 challenge proof binds every canonical authentication field', () => {
  const identity = createTestIdentity()
  const fields = {
    deviceId: identity.deviceId,
    deviceName: 'iPhone',
    appVersion: '2.0',
    nonce: 'n'.repeat(32),
    audience: 'deeppilot:test',
    issuedAt: 1000,
    expiresAt: 31_000,
  }
  const signature = sign('sha256', canonicalAuthChallenge(fields), identity.privateKey).toString('base64url')
  assert.equal(verifyAuthProof(identity.publicKey, fields, signature), true)
  assert.equal(verifyAuthProof(identity.publicKey, { ...fields, audience: 'deeppilot:other' }, signature), false)
  assert.equal(deviceIdForPublicKey(identity.publicKey), identity.deviceId)
  assert.equal(
    canonicalAuthChallenge({ ...fields, deviceId: 'device', deviceName: 'Mars iPhone', resumeCursor: 42 }).toString(),
    [
      'deeppilot-auth-v2',
      'device-id:ZGV2aWNl',
      `nonce:${'n'.repeat(32)}`,
      'audience:ZGVlcHBpbG90OnRlc3Q',
      'issued-at:1000',
      'expires-at:31000',
      'device-name:TWFycyBpUGhvbmU',
      'app-version:Mi4w',
      'resume-cursor:42',
    ].join('\n'),
  )
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
    await writeFile(join(legacy, 'tailscale-state'), 'state')
    assert.equal(await migrateLegacyBridgeDataDir(), legacy)
    assert.equal(await readFile(join(root, 'deeppilot', 'tailscale-state'), 'utf8'), 'state')

    await mkdir(legacy)
    await writeFile(join(legacy, 'other-state'), 'legacy')
    assert.equal(await migrateLegacyBridgeDataDir(), null)
    await assert.rejects(() => readFile(join(root, 'deeppilot', 'other-state'), 'utf8'))
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
