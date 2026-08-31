import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeRelayBaseUrl } from '../src/relay-url.ts'

test('relay base URL normalization trims whitespace and every trailing slash', () => {
  assert.equal(normalizeRelayBaseUrl('  https://relay.example.test///  '), 'https://relay.example.test')
  assert.equal(normalizeRelayBaseUrl('https://relay.example.test/path'), 'https://relay.example.test/path')
  assert.equal(normalizeRelayBaseUrl('////'), '')
})

test('relay base URL normalization handles a pathological trailing-slash run', () => {
  const suffix = '/'.repeat(200_000)
  assert.equal(normalizeRelayBaseUrl(`https://relay.example.test${suffix}`), 'https://relay.example.test')
})
