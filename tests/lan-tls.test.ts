import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicKey, X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import {
  LAN_TLS_CERT_FILE,
  LAN_TLS_COMMON_NAME,
  LAN_TLS_FINGERPRINT_PATTERN,
  LAN_TLS_KEY_FILE,
  loadOrCreateLanTlsIdentity,
  spkiFingerprint,
} from '../src/lan-tls.ts'
import { createPhoneServer, closeServer, listen } from '../src/phone-server.ts'

const YEAR_MS = 365 * 24 * 60 * 60_000

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'deeppilot-lan-tls-'))
}

test('LAN TLS identity is created once with a private key file and a pinnable EC P-256 leaf', async () => {
  const dir = await freshDir()
  const identity = await loadOrCreateLanTlsIdentity(dir)
  assert.equal(identity.regenerated, true)
  assert.equal(identity.resigned, false)
  assert.match(identity.fingerprint, LAN_TLS_FINGERPRINT_PATTERN)
  assert.equal(identity.fingerprint, spkiFingerprint(identity.cert))

  const cert = new X509Certificate(identity.cert)
  assert.equal(cert.subject, `CN=${LAN_TLS_COMMON_NAME}`)
  assert.equal(cert.publicKey.asymmetricKeyType, 'ec')
  assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, 'prime256v1')
  assert.ok(cert.validToDate.getTime() - Date.now() > 9 * YEAR_MS)
  assert.ok(cert.validFromDate.getTime() <= Date.now())

  if (process.platform !== 'win32') {
    const keyMode = (await stat(join(dir, LAN_TLS_KEY_FILE))).mode & 0o777
    assert.equal(keyMode, 0o600)
    const certMode = (await stat(join(dir, LAN_TLS_CERT_FILE))).mode & 0o777
    assert.equal(certMode, 0o600)
  }
  assert.match(await readFile(join(dir, LAN_TLS_KEY_FILE), 'utf8'), /-----BEGIN PRIVATE KEY-----/)
})

test('LAN TLS identity reloads unchanged and never flags a regeneration for a stable key', async () => {
  const dir = await freshDir()
  const first = await loadOrCreateLanTlsIdentity(dir)
  const second = await loadOrCreateLanTlsIdentity(dir)
  assert.equal(second.regenerated, false)
  assert.equal(second.resigned, false)
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(second.cert, first.cert)
  assert.equal(second.key, first.key)
})

test('an expiring certificate is re-signed with the same key so the pin survives', async () => {
  const dir = await freshDir()
  const first = await loadOrCreateLanTlsIdentity(dir)
  const renewed = await loadOrCreateLanTlsIdentity(dir, Date.now() + 10 * YEAR_MS)
  assert.equal(renewed.regenerated, false)
  assert.equal(renewed.resigned, true)
  assert.equal(renewed.fingerprint, first.fingerprint)
  assert.equal(renewed.key, first.key)
  assert.notEqual(renewed.cert, first.cert)
  assert.ok(renewed.notAfter > first.notAfter)
  // A certificate that no longer matches the key is treated the same way.
  const other = await loadOrCreateLanTlsIdentity(await freshDir())
  await writeFile(join(dir, LAN_TLS_CERT_FILE), other.cert)
  const repaired = await loadOrCreateLanTlsIdentity(dir)
  assert.equal(repaired.resigned, true)
  assert.equal(repaired.fingerprint, first.fingerprint)
})

test('a missing or corrupt private key regenerates the identity and reports it', async () => {
  const dir = await freshDir()
  const first = await loadOrCreateLanTlsIdentity(dir)
  await writeFile(join(dir, LAN_TLS_KEY_FILE), 'not a key\n')
  const regenerated = await loadOrCreateLanTlsIdentity(dir)
  assert.equal(regenerated.regenerated, true)
  assert.notEqual(regenerated.fingerprint, first.fingerprint)
  assert.equal(regenerated.fingerprint, spkiFingerprint(regenerated.cert))
  // The certificate on disk must now match the new key.
  const onDisk = await readFile(join(dir, LAN_TLS_CERT_FILE), 'utf8')
  assert.equal(spkiFingerprint(onDisk), regenerated.fingerprint)
})

test('spkiFingerprint hashes the SubjectPublicKeyInfo, not the whole certificate', async () => {
  const identity = await loadOrCreateLanTlsIdentity(await freshDir())
  const spki = createPublicKey(identity.cert).export({ type: 'spki', format: 'der' })
  const { createHash } = await import('node:crypto')
  assert.equal(identity.fingerprint, 'sha256:' + createHash('sha256').update(spki).digest('base64url'))
})

test('the TLS phone server presents the pinned leaf and refuses plaintext', async () => {
  const identity = await loadOrCreateLanTlsIdentity(await freshDir())
  const server = createPhoneServer({
    health(_req, res) {
      res.statusCode = 200
      res.end('{"ok":true}')
    },
    pair(_req, res) {
      res.statusCode = 405
      res.end('POST required')
    },
    upgrade(_req, socket) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    },
  }, { key: identity.key, cert: identity.cert })
  try {
    await listen(server, 0, '127.0.0.1')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const port = address.port

    // TLS handshake without CA trust: the peer certificate is exactly the
    // identity the pairing QR pins.
    const presented = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
        const peer = socket.getPeerCertificate(true)
        socket.end()
        resolve(spkiFingerprint(`-----BEGIN CERTIFICATE-----\n${peer.raw.toString('base64')}\n-----END CERTIFICATE-----\n`))
      })
      socket.once('error', reject)
    })
    assert.equal(presented, identity.fingerprint)

    // Plain HTTP against the TLS listener never reaches a route handler.
    const plaintext = await fetch(`http://127.0.0.1:${port}/phone/health`).then(
      (res) => `status ${res.status}`,
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'error',
    )
    assert.notEqual(plaintext, 'status 200')

    // Node's default trust store rejects the self-signed leaf.
    await assert.rejects(fetch(`https://127.0.0.1:${port}/phone/health`))
  } finally {
    await closeServer(server)
  }
})
