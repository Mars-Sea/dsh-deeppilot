import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePairingQRPayload, selectPairingTargets } from '../src/pairing-qr.ts'

const grant = () => ({ code: 'x'.repeat(43), expiresAt: Date.now() + 60_000, audience: 'deeppilot:test' })

test('pairing QR uses a versioned JSON payload and keeps credentials out of the URL', () => {
  const pairing = grant()
  const encoded = encodePairingQRPayload('https://phone.example.ts.net', pairing)
  assert.deepEqual(JSON.parse(encoded), {
    v: 2,
    type: 'deeppilot-pairing',
    host: 'https://phone.example.ts.net',
    code: pairing.code,
    expiresAt: pairing.expiresAt,
    audience: pairing.audience,
  })
  assert.equal(encoded.includes('?code='), false)
})

test('pairing QR supports LAN HTTP but rejects malformed or credentialed hosts', () => {
  assert.doesNotThrow(() => encodePairingQRPayload('http://192.168.1.149:3080', grant()))
  assert.throws(() => encodePairingQRPayload('not a URL', grant()))
  assert.throws(() => encodePairingQRPayload('https://user:pass@phone.example', grant()))
})

test('pairing targets list the independent LAN endpoint before Funnel', () => {
  assert.deepEqual(selectPairingTargets(
    { phase: 'online', endpoints: ['http://192.168.1.149:3098', 'http://10.0.0.8:3098'] },
    { phase: 'online', publicURL: 'https://phone.example.ts.net' },
  ), [
    { host: 'http://192.168.1.149:3098', kind: 'lan' },
    { host: 'http://10.0.0.8:3098', kind: 'lan' },
    { host: 'https://phone.example.ts.net', kind: 'public' },
  ])
})

test('pairing targets hide failed listeners and reject malformed reported URLs', () => {
  assert.deepEqual(selectPairingTargets(
    { phase: 'error', endpoints: ['http://192.168.1.149:3098'] },
    { phase: 'error', publicURL: 'https://phone.example.ts.net' },
  ), [])
  assert.deepEqual(selectPairingTargets(
    { phase: 'online', endpoints: ['not a url', 'http://user:pass@192.168.1.149:3098'] },
    { phase: 'online', publicURL: 'javascript:alert(1)' },
  ), [])
})
