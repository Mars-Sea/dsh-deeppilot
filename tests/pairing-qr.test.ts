import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePairingQRPayload, selectPairingTarget } from '../src/pairing-qr.ts'

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

test('pairing target prefers Funnel and falls back from loopback to a private Host address', () => {
  assert.deepEqual(selectPairingTarget(
    { phase: 'online', publicURL: 'https://phone.example.ts.net' },
    ['192.168.1.149'],
    'http://127.0.0.1:3080',
  ), { host: 'https://phone.example.ts.net', kind: 'public' })
  assert.deepEqual(selectPairingTarget(
    { phase: 'disabled' },
    ['192.168.1.149'],
    'http://127.0.0.1:3080',
  ), { host: 'http://192.168.1.149:3080', kind: 'lan' })
  assert.deepEqual(selectPairingTarget(
    { phase: 'disabled' },
    ['192.168.1.149'],
    'http://macbook.local:3080',
  ), { host: 'http://macbook.local:3080', kind: 'lan' })
})

test('browsing DSH through the Funnel address stays a public target even if the phase flapped', () => {
  assert.deepEqual(selectPairingTarget(
    { phase: 'error', publicURL: 'https://phone.example.ts.net' },
    ['192.168.1.149'],
    'https://phone.example.ts.net',
  ), { host: 'https://phone.example.ts.net', kind: 'public' })
})
