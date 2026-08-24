import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePairingQRPayload, selectPairingTarget } from '../src/pairing-qr.ts'

test('pairing QR uses a versioned JSON payload and keeps token out of the URL', () => {
  const token = 'x'.repeat(43)
  const encoded = encodePairingQRPayload('https://phone.example.ts.net', token)
  assert.deepEqual(JSON.parse(encoded), {
    v: 1,
    type: 'dsh-pocket-pairing',
    host: 'https://phone.example.ts.net',
    token,
  })
  assert.equal(encoded.includes('?token='), false)
})

test('pairing QR supports LAN HTTP but rejects malformed or credentialed hosts', () => {
  assert.doesNotThrow(() => encodePairingQRPayload('http://192.168.1.149:3080', 'x'.repeat(43)))
  assert.throws(() => encodePairingQRPayload('not a URL', 'x'.repeat(43)))
  assert.throws(() => encodePairingQRPayload('https://user:pass@phone.example', 'x'.repeat(43)))
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
