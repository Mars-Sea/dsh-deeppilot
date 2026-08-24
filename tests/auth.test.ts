import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { helloTokenAccepted } from '../src/connection.ts'
import { requestToken } from '../src/index.ts'
import { bridgeDataDir, migrateLegacyBridgeDataDir } from '../src/token.ts'

const expected = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'

test('HTTP authentication prefers Bearer and keeps legacy query support', () => {
  assert.equal(requestToken({ url: '/phone', headers: { authorization: `Bearer ${expected}` } }), expected)
  assert.equal(requestToken({ url: `/phone?token=${expected}`, headers: {} }), expected)
  assert.equal(requestToken({ url: '/phone', headers: {} }), null)
  assert.equal(requestToken({
    url: '/phone?token=legacy',
    headers: { authorization: `Bearer ${expected}` },
  }), expected)
})

test('hello authentication requires the token only for an untrusted upgrade', () => {
  assert.equal(helloTokenAccepted(true, undefined, expected), true)
  assert.equal(helloTokenAccepted(false, expected, expected), true)
  assert.equal(helloTokenAccepted(false, 'wrong', expected), false)
  assert.equal(helloTokenAccepted(undefined, undefined, expected), false)
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
