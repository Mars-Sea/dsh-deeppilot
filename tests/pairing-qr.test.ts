import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePairingQRPayload, isLanTlsFingerprint, selectPairingTargets } from '../src/pairing-qr.ts'

const grant = () => ({ code: 'x'.repeat(43), expiresAt: Date.now() + 60_000, audience: 'deeppilot:test' })
const FINGERPRINT = 'sha256:' + 'A'.repeat(43)

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

test('pairing QR carries the LAN certificate pin and only accepts well-formed pins', () => {
  const pairing = grant()
  const encoded = JSON.parse(encodePairingQRPayload('https://192.168.1.149:3098', pairing, FINGERPRINT)) as Record<string, unknown>
  assert.equal(encoded.tlsFingerprint, FINGERPRINT)
  assert.throws(() => encodePairingQRPayload('https://192.168.1.149:3098', pairing, 'sha256:short'), TypeError)
  assert.throws(() => encodePairingQRPayload('https://192.168.1.149:3098', pairing, 'md5:' + 'A'.repeat(43)), TypeError)
  assert.equal(isLanTlsFingerprint(FINGERPRINT), true)
  assert.equal(isLanTlsFingerprint('sha256:' + 'A'.repeat(42)), false)
  assert.equal(isLanTlsFingerprint('sha256:' + 'A'.repeat(42) + '='), false)
  assert.equal(isLanTlsFingerprint(undefined), false)
})

test('pairing QR only encodes encrypted hosts and rejects malformed or credentialed hosts', () => {
  assert.doesNotThrow(() => encodePairingQRPayload('https://192.168.1.149:3098', grant()))
  assert.doesNotThrow(() => encodePairingQRPayload('wss://phone.example.ts.net', grant()))
  assert.throws(() => encodePairingQRPayload('http://192.168.1.149:3098', grant()), TypeError)
  assert.throws(() => encodePairingQRPayload('ws://192.168.1.149:3098', grant()), TypeError)
  assert.throws(() => encodePairingQRPayload('not a URL', grant()))
  assert.throws(() => encodePairingQRPayload('https://user:pass@phone.example', grant()))
})

test('pairing targets list the pinned LAN endpoint before Funnel', () => {
  assert.deepEqual(selectPairingTargets(
    { phase: 'online', endpoints: ['https://192.168.1.149:3098', 'https://10.0.0.8:3098'], tlsFingerprint: FINGERPRINT },
    { phase: 'online', publicURL: 'https://phone.example.ts.net' },
  ), [
    { host: 'https://192.168.1.149:3098', kind: 'lan', tlsFingerprint: FINGERPRINT },
    { host: 'https://10.0.0.8:3098', kind: 'lan', tlsFingerprint: FINGERPRINT },
    { host: 'https://phone.example.ts.net', kind: 'public' },
  ])
})

test('pairing targets never offer a LAN listener without a certificate pin', () => {
  assert.deepEqual(selectPairingTargets(
    { phase: 'online', endpoints: ['https://192.168.1.149:3098'] },
    { phase: 'online', publicURL: 'https://phone.example.ts.net' },
  ), [
    { host: 'https://phone.example.ts.net', kind: 'public' },
  ])
})

test('pairing targets hide failed listeners and reject plaintext or malformed reported URLs', () => {
  assert.deepEqual(selectPairingTargets(
    { phase: 'error', endpoints: ['https://192.168.1.149:3098'], tlsFingerprint: FINGERPRINT },
    { phase: 'error', publicURL: 'https://phone.example.ts.net' },
  ), [])
  assert.deepEqual(selectPairingTargets(
    { phase: 'online', endpoints: ['not a url', 'https://user:pass@192.168.1.149:3098', 'http://192.168.1.149:3098'], tlsFingerprint: FINGERPRINT },
    { phase: 'online', publicURL: 'javascript:alert(1)' },
  ), [])
  assert.deepEqual(selectPairingTargets(
    { phase: 'disabled', endpoints: [] },
    { phase: 'online', publicURL: 'http://phone.example.ts.net' },
  ), [])
})
