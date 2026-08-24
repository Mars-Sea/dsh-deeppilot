import assert from 'node:assert/strict'
import test from 'node:test'
import { helloTokenAccepted } from '../src/connection.ts'
import { requestToken } from '../src/index.ts'
import { bridgeDataDir } from '../src/token.ts'

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

test('bridge data is stored under the pocket-bridge directory', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/harness-pocket-test-home'
    assert.equal(bridgeDataDir(), '/tmp/harness-pocket-test-home/pocket-bridge')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
