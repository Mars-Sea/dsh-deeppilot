import assert from 'node:assert/strict'
import test from 'node:test'
import { runRelayProbe } from '../src/relay-test.ts'
import type { RelayProbeOptions } from '../src/relay-test.ts'
import { pushTestSchema } from '../src/report-wire.ts'

const URL_BASE = 'https://relay.example.test'

/** Minimal fetch mock driven by a routing function. */
function fetchMock(route: (path: string, init: RequestInit | undefined) => { status: number; body: unknown }) {
  return (async (input: any, init?: any) => {
    const path = String(input).replace(URL_BASE, '')
    const outcome = route(path, init)
    const ResponseLike = {
      status: outcome.status,
      json: async () => outcome.body,
    }
    return ResponseLike as unknown as Response
  }) as typeof fetch
}

const baseOptions = (): RelayProbeOptions => ({
  url: URL_BASE,
  clientId: 'u_client_0001',
  enrollKey: 'distribute-me-2026',
})

test('probe passes when health and enrollment both succeed', async () => {
  let enrolledBody: any
  const result = await runRelayProbe({
    ...baseOptions(),
    onEnrolled: (token) => { /* capture below via closure */ },
    fetchImpl: fetchMock((path, init) => {
      if (path === '/healthz') return { status: 200, body: { ok: true } }
      enrolledBody = JSON.parse(String(init?.body ?? '{}'))
      return { status: 200, body: { token: 'rl_issued' } }
    }),
  })
  assert.equal(result.overall, 'ok')
  assert.equal(result.tokenIssued, true)
  assert.deepEqual(result.steps.map((s) => [s.id, s.ok]), [['health', true], ['enroll', true]])
  assert.equal(typeof result.steps[0].latencyMs, 'number')
  // Wire shape sent to the relay matches the enroll contract.
  assert.equal(enrolledBody.clientId, 'u_client_0001')
  assert.equal(enrolledBody.enrollKey, 'distribute-me-2026')
})

test('a key mismatch is reported as a failed enroll step with guidance', async () => {
  const result = await runRelayProbe({
    ...baseOptions(),
    fetchImpl: fetchMock((path) => {
      if (path === '/healthz') return { status: 200, body: { ok: true } }
      return { status: 403, body: { error: 'invalid enroll key' } }
    }),
  })
  assert.equal(result.overall, 'failed')
  assert.equal(result.steps[0].ok, true)
  assert.equal(result.steps[1].ok, false)
  assert.match(result.steps[1].message, /密钥不匹配/)
  assert.equal(result.tokenIssued, false)
})

test('unreachable relay fails the health step without throwing', async () => {
  const result = await runRelayProbe({
    ...baseOptions(),
    fetchImpl: (async () => { throw new Error('connect ECONNREFUSED') }) as typeof fetch,
  })
  assert.equal(result.overall, 'failed')
  assert.match(result.steps[0].message, /无法连接中继/)
  // Enrollment still attempted? Health failing must not block the second step.
  assert.equal(result.steps.length, 2)
})

test('manual token skips enrollment; missing key explains why it cannot run', async () => {
  const manual = await runRelayProbe({
    url: URL_BASE,
    manualToken: true,
    fetchImpl: fetchMock((path) => (path === '/healthz' ? { status: 200, body: { ok: true } } : { status: 500, body: {} })),
  })
  assert.equal(manual.overall, 'ok')
  assert.equal(manual.steps[1].message.includes('跳过注册验证'), true)

  const noKey = await runRelayProbe({
    url: URL_BASE,
    fetchImpl: fetchMock(() => ({ status: 200, body: { ok: true } })),
  })
  assert.equal(noKey.overall, 'failed')
  assert.match(noKey.steps[1].message, /尚无注册密钥/)
})


// ---- testPush wire contract ----

test('pushTestSchema accepts the delivery report and rejects junk', () => {
  const valid = pushTestSchema.parse({
    transport: 'relay',
    overall: 'sent',
    results: [{ name: 'iPhone', environment: 'production', outcome: 'sent' }],
  })
  assert.equal(valid.overall, 'sent')
  assert.equal(valid.results[0].outcome, 'sent')

  const withMessage = pushTestSchema.parse({
    transport: 'none',
    overall: 'not-configured',
    message: '推送未启用',
    results: [],
  })
  assert.equal(withMessage.message, '推送未启用')

  assert.throws(() => pushTestSchema.parse({ transport: 'pigeon', overall: 'sent', results: [] }))
  assert.throws(() => pushTestSchema.parse({ transport: 'apns', overall: 'exploded', results: [] }))
})
