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

test('every strict codec serves both host generations in the declared peer range', () => {
  // Through DSH 0.1.6-alpha.1 a strict codec published the schema value itself
  // and every consumer called `codec.schema.parse(value)`. From 0.1.6-alpha.2
  // the registry rejects a codec without `create()` and the Gateway parses
  // through `codec.create().parse(value)`. Both keys must survive: dropping
  // either one silently narrows the supported host range, and a unit suite
  // exercised against a single generation cannot see the loss.
  const codecs = strictCodecs()
  assert.equal(codecs.length, 9, 'the contribution declares nine strict codecs')
  for (const { subject, codec } of codecs) {
    assert.equal(codec.mode, 'strict', `${subject} stays strict`)
    // Generation <= 0.1.6-alpha.1: schema value published directly.
    const schema = codec.schema as { parse?: unknown } | undefined
    assert.equal(typeof schema?.parse, 'function', `${subject} exposes schema.parse for older hosts`)
    // Generation >= 0.1.6-alpha.2: registry validation and Gateway parsing.
    const create = codec.create as (() => { parse?: unknown }) | undefined
    assert.equal(typeof create, 'function', `${subject} exposes create() for 0.1.6-alpha.2+ hosts`)
    const materialized = create?.()
    assert.equal(
      typeof materialized?.parse,
      'function',
      `${subject} create() materializes a parseable schema`,
    )
    // One codec instance must behave identically through both access paths.
    assert.equal(materialized, schema, `${subject} create() returns the published schema`)
  }
})

test('the host contribution deliberately declares no typert schemas', () => {
  // 0.1.6-alpha.2 replaced a contributed schema's materialized `schema` field
  // with a lazy `create()` factory. This Remote contributes no schemas — its
  // codecs are hand-written and dependency-free — so that change must never
  // reach it. Asserting the empty list keeps a future contribution from
  // silently reintroducing the removed shape.
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
