import assert from 'node:assert/strict'
import test from 'node:test'
import { isTailscaleVersion } from '../src/tailscale-version.ts'

test('isTailscaleVersion accepts the Go module version forms a helper can report', () => {
  for (const value of [
    'v1.104.2',
    '1.104.2',
    'v1.104.2-pre.1',
    'v1.104.2-rc.3',
    'v0.0.0-20260101000000-abcdef123456',
    // A replaced module still reports a v-prefixed version; keep the check
    // permissive enough for the +incompatible suffix Go emits.
    'v2.0.0+incompatible',
  ]) {
    assert.equal(isTailscaleVersion(value), true, value)
  }
})

test('isTailscaleVersion rejects non-strings, markup and oversized values', () => {
  for (const value of [
    undefined,
    null,
    42,
    '',
    'v1',
    '1.104',
    'v1.104.2 ',
    ' v1.104.2',
    '<script>alert(1)</script>',
    'v1.104.2</span>',
    'v' + '1'.repeat(90),
  ]) {
    assert.equal(isTailscaleVersion(value), false, String(value))
  }
})
