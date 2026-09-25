import assert from 'node:assert/strict'
import test from 'node:test'
import {
  pushTestSchema,
  reportSchema,
  REPORT_HOST_CONTRIBUTION,
  REPORT_REMOTE_CONTRIBUTION,
} from '../src/report-wire.ts'

// A minimal but well-formed report, used as the seed for every variant below.
function validReport(extra: Record<string, unknown> = {}) {
  return {
    protocolVersion: 2,
    serverVersion: '0.3.0',
    pluginVersion: '0.3.0',
    enabled: true,
    identityPath: '/tmp/devices-v2.json',
    pairingReady: true,
    activeConnections: 0,
    historyBufferMax: 2000,
    debug: false,
    lanAddresses: [],
    local: {
      phase: 'online' as const,
      port: 3098,
      endpoints: ['https://192.168.1.149:3098'],
      tlsFingerprint: 'sha256:' + 'A'.repeat(43),
      updatedAt: 0,
    },
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
  assert.equal(parsed.protocolVersion, 2)
  assert.equal(parsed.activeConnections, 0)
  assert.equal(parsed.local.tlsFingerprint, 'sha256:' + 'A'.repeat(43))
  assert.equal(parsed.local.tlsIdentityRegenerated, undefined)
})

test('reportSchema carries the optional custom device name and rejects malformed labels', () => {
  const parsed = reportSchema.parse(validReport({
    devices: [{
      deviceId: 'd',
      deviceName: '工作手机',
      customName: 'Work phone',
      appVersion: '1.0',
      firstSeenTs: 1,
      lastSeenTs: 2,
      fingerprint: 'abcdef012345',
    }],
  }))
  assert.equal(parsed.devices[0]?.deviceName, '工作手机')
  assert.equal(parsed.devices[0]?.customName, 'Work phone')

  for (const customName of ['', 'x'.repeat(65), 'bad\nname', ' padded ']) {
    assert.throws(() => reportSchema.parse(validReport({
      devices: [{
        deviceId: 'd', deviceName: 'iPhone', customName, appVersion: '1.0',
        firstSeenTs: 1, lastSeenTs: 2, fingerprint: 'abcdef012345',
      }],
    })), /device\.customName/)
  }
})

test('reportSchema carries the LAN TLS identity fields and rejects wrong types', () => {
  const regenerated = reportSchema.parse(validReport({
    local: { phase: 'online', port: 3098, endpoints: [], tlsFingerprint: 'sha256:x', tlsIdentityRegenerated: true, updatedAt: 0 },
  }))
  assert.equal(regenerated.local.tlsIdentityRegenerated, true)
  const plain = reportSchema.parse(validReport({
    local: { phase: 'disabled', port: 3098, endpoints: [], updatedAt: 0 },
  }))
  assert.equal(plain.local.tlsFingerprint, undefined)
  assert.throws(() => reportSchema.parse(validReport({
    local: { phase: 'online', port: 3098, endpoints: [], tlsFingerprint: 42, updatedAt: 0 },
  })), /local\.tlsFingerprint/)
  assert.throws(() => reportSchema.parse(validReport({
    local: { phase: 'online', port: 3098, endpoints: [], tlsIdentityRegenerated: 'yes', updatedAt: 0 },
  })), /local\.tlsIdentityRegenerated/)
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
  assert.throws(() => reportSchema.parse(validReport({
    local: { phase: 'online', port: -1, endpoints: [], updatedAt: 0 },
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

/** Every strict codec reachable from one invocation, with a diagnostic label. */
function strictCodecs(): { subject: string; codec: Record<string, unknown> }[] {
  const found: { subject: string; codec: Record<string, unknown> }[] = []
  for (const descriptor of REPORT_HOST_CONTRIBUTION.invocations) {
    found.push({ subject: `${descriptor.id} result`, codec: descriptor.result as unknown as Record<string, unknown> })
    for (const parameter of descriptor.parameters) {
      found.push({
        subject: `${descriptor.id} ${parameter.wire}`,
        codec: parameter.codec as unknown as Record<string, unknown>,
      })
    }
    if (descriptor.invocation.kind === 'context') {
      found.push({
        subject: `${descriptor.id} context`,
        codec: descriptor.invocation.codec as unknown as Record<string, unknown>,
      })
    }
  }
  return found
}

test('every strict codec materializes through the rc.2 create contract', () => {
  const codecs = strictCodecs()
  assert.equal(codecs.length, 12, 'the contribution declares twelve strict codecs')
  for (const { subject, codec } of codecs) {
    assert.equal(codec.mode, 'strict', `${subject} stays strict`)
    const create = codec.create as (() => { parse?: unknown }) | undefined
    assert.equal(typeof create, 'function', `${subject} exposes create()`)
    const materialized = create?.()
    assert.equal(
      typeof materialized?.parse,
      'function',
      `${subject} create() materializes a parseable schema`,
    )
    assert.equal('schema' in codec, false, `${subject} has no removed schema field`)
  }
})

test('the host contribution deliberately declares no typert schemas', () => {
  // This Remote contributes only hand-written codecs.
  assert.deepEqual(REPORT_HOST_CONTRIBUTION.schemas, [])
  assert.deepEqual(REPORT_HOST_CONTRIBUTION.model, { services: [], events: [], objects: [] })
})

test('the host and client halves publish the same descriptor set', () => {
  // The Client bundle mounts these descriptors; a host-only edit would leave
  // the settings page calling methods the Gateway no longer advertises.
  assert.deepEqual(
    REPORT_REMOTE_CONTRIBUTION.descriptors,
    REPORT_HOST_CONTRIBUTION.invocations,
  )
})
