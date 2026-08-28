import assert from 'node:assert/strict'
import test from 'node:test'
import {
  pushTestSchema,
  reportSchema,
} from '../src/report-wire.ts'

// A minimal but well-formed report, used as the seed for every variant below.
function validReport(extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    serverVersion: '0.3.0',
    pluginVersion: '0.3.0',
    enabled: true,
    tokenPath: '/tmp/auth-token',
    tokenReady: true,
    activeConnections: 0,
    historyBufferMax: 2000,
    debug: false,
    lanAddresses: [],
    remote: {
      provider: 'tailscale-funnel' as const,
      phase: 'disabled' as const,
      updatedAt: 0,
    },
    devices: [],
    ...extra,
  }
}

test('reportSchema accepts a healthy report', () => {
  const parsed = reportSchema.parse(validReport())
  assert.equal(parsed.protocolVersion, 1)
  assert.equal(parsed.activeConnections, 0)
})

test('reportSchema rejects non-integer and negative counters', () => {
  // Every counter/time field must be a non-negative integer; a bare
  // `typeof number` check used to accept 1.5, -1, 1.2e3, and surface them
  // verbatim on the settings page.
  for (const [field, value] of [
    ['protocolVersion', 1.5],
    ['activeConnections', -1],
    ['historyBufferMax', 1200.5],
  ] as const) {
    assert.throws(
      () => reportSchema.parse(validReport({ [field]: value })),
      /invalid/,
      `${String(field)}=${String(value)} must be rejected`,
    )
  }
  // device.firstSeenTs/lastSeenTs and remote.updatedAt are ints too.
  assert.throws(() => reportSchema.parse(validReport({
    devices: [{ deviceId: 'd', deviceName: 'iPhone', appVersion: '1.0', firstSeenTs: 1.5, lastSeenTs: 100 }],
  })))
  assert.throws(() => reportSchema.parse(validReport({
    remote: { provider: 'tailscale-funnel', phase: 'online', publicURL: 'https://x.ts.net', updatedAt: -1 },
  })))
})

test('reportSchema accepts a large but finite update timestamp', () => {
  // Date.now() comfortably fits; the only failure mode is non-finite /
  // negative / non-integer, not magnitude.
  const parsed = reportSchema.parse(validReport({
    remote: { provider: 'tailscale-funnel', phase: 'disabled', updatedAt: 1.7e12 },
  }))
  assert.equal(parsed.remote.updatedAt, 1.7e12)
})

test('pushTestSchema accepts a 10-hex-char token fingerprint and drops anything else silently', () => {
  // The wire codec only ever drops invalid fields; a bad fingerprint must not
  // nuke the whole result row. The fix is to narrow the regex from
  // `{1,32}` (which accepted anything 1..32 hex) down to the documented
  // 10 hex chars.
  const base = {
    transport: 'apns' as const,
    overall: 'sent' as const,
    results: [{
      name: 'iPhone',
      environment: 'production',
      outcome: 'sent',
      tokenFingerprint: '0123456789',
    }],
  }
  const ok = pushTestSchema.parse(base)
  assert.equal(ok.results[0]?.tokenFingerprint, '0123456789')

  for (const fingerprint of ['012345678', '0123456789a', 'ghijklmnop', '0123456789X']) {
    const parsed = pushTestSchema.parse({
      ...base,
      results: [{ ...base.results[0], tokenFingerprint: fingerprint }],
    })
    assert.equal(
      'tokenFingerprint' in (parsed.results[0] ?? {}),
      false,
      `fingerprint ${JSON.stringify(fingerprint)} must be dropped, not surfaced`,
    )
  }
})
