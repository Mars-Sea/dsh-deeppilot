import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_LOCAL_PORT,
  localEndpointURLs,
  localListenError,
  normalizeLocalPort,
} from '../src/local-policy.ts'

test('local port normalization keeps a stable cross-platform default', () => {
  assert.equal(normalizeLocalPort(undefined), DEFAULT_LOCAL_PORT)
  assert.equal(normalizeLocalPort(3098), 3098)
  assert.equal(normalizeLocalPort(65_535), 65_535)
  assert.equal(normalizeLocalPort(1023), DEFAULT_LOCAL_PORT)
  assert.equal(normalizeLocalPort(3098.5), DEFAULT_LOCAL_PORT)
})

test('local endpoints use the independent port and remove duplicate addresses', () => {
  assert.deepEqual(
    localEndpointURLs(['192.168.1.149', '10.0.0.8', '192.168.1.149'], 3098),
    ['http://192.168.1.149:3098', 'http://10.0.0.8:3098'],
  )
})

test('local listen errors explain common port failures', () => {
  const inUse = Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' })
  assert.equal(localListenError(inUse, 3098), 'local port 3098 is already in use')
  assert.equal(localListenError(new Error('other failure'), 3098), 'other failure')
})
