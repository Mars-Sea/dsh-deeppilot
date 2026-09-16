import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generate } from 'selfsigned'

export { LAN_TLS_FINGERPRINT_PATTERN, isLanTlsFingerprint } from './pairing-qr.ts'

export const LAN_TLS_COMMON_NAME = 'dsh-deeppilot'
export const LAN_TLS_KEY_FILE = 'key.pem'
export const LAN_TLS_CERT_FILE = 'cert.pem'

const CERT_VALIDITY_MS = 10 * 365 * 24 * 60 * 60_000
/** Re-sign this far ahead of expiry so a long-running host never serves a stale leaf. */
const CERT_RENEW_LEAD_MS = 30 * 24 * 60 * 60_000

export interface LanTlsIdentity {
  /** PKCS#8 PEM private key. Never logged or reported. */
  key: string
  /** Self-signed X.509 PEM leaf certificate. */
  cert: string
  /** Pinned by paired devices; changes only when the private key changes. */
  fingerprint: string
  /** Unix ms when the current leaf certificate expires. */
  notAfter: number
  /**
   * The private key was newly created. Devices that pinned the previous
   * identity can no longer connect and must pair again.
   */
  regenerated: boolean
  /** A fresh leaf was signed with the existing key; the fingerprint is unchanged. */
  resigned: boolean
}

/** Compute the pinned public-key fingerprint of a PEM certificate. */
export function spkiFingerprint(certPem: string): string {
  const der = createPublicKey(certPem).export({ type: 'spki', format: 'der' })
  return 'sha256:' + createHash('sha256').update(der).digest('base64url')
}

/**
 * Load the LAN listener's TLS identity from `dir`, creating or repairing it
 * as needed. The private key is the durable identity: it is created once and
 * reused for every subsequent certificate, so pinned devices survive
 * certificate renewals. Only a missing or unreadable key forces a new one.
 */
export async function loadOrCreateLanTlsIdentity(dir: string, now: number = Date.now()): Promise<LanTlsIdentity> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const keyPath = join(dir, LAN_TLS_KEY_FILE)
  const certPath = join(dir, LAN_TLS_CERT_FILE)

  let key = await readPem(keyPath)
  let regenerated = false
  if (key === undefined || !validPrivateKey(key)) {
    regenerated = true
    key = undefined
  }

  let cert = regenerated ? undefined : await readPem(certPath)
  let resigned = false
  const existing = key !== undefined && cert !== undefined ? inspectCertificate(cert, key, now) : undefined
  if (existing === undefined) {
    const issued = await issueCertificate(key, now)
    if (key === undefined) {
      key = pemFile(issued.key)
      await writePrivate(keyPath, key)
    } else {
      resigned = true
    }
    cert = pemFile(issued.cert)
    await writePrivate(certPath, cert)
  }
  if (key === undefined || cert === undefined) throw new Error('LAN TLS identity unavailable')

  return {
    key,
    cert,
    fingerprint: spkiFingerprint(cert),
    notAfter: existing ?? new X509Certificate(cert).validToDate.getTime(),
    regenerated,
    resigned,
  }
}

async function readPem(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim().length > 0 ? text : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // Any other read failure is treated like a missing file: the caller
    // rewrites the identity and the operator sees the "regenerated" signal.
    return undefined
  }
}

function validPrivateKey(pem: string): boolean {
  try {
    const key = createPrivateKey(pem)
    return key.asymmetricKeyType === 'ec'
  } catch {
    return false
  }
}

/**
 * Return the certificate's expiry when it is usable with `keyPem`, or
 * `undefined` when it must be re-issued (malformed, wrong key, or expiring).
 */
function inspectCertificate(certPem: string, keyPem: string, now: number): number | undefined {
  try {
    const cert = new X509Certificate(certPem)
    const certSpki = cert.publicKey.export({ type: 'spki', format: 'der' })
    const keySpki = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' })
    if (!certSpki.equals(keySpki)) return undefined
    const notAfter = cert.validToDate.getTime()
    const notBefore = cert.validFromDate.getTime()
    if (!(notBefore <= now && notAfter - CERT_RENEW_LEAD_MS > now)) return undefined
    return notAfter
  } catch {
    return undefined
  }
}

async function issueCertificate(existingKey: string | undefined, now: number): Promise<{ key: string; cert: string }> {
  // Back-date slightly so a phone whose clock trails the Mac still accepts a
  // certificate issued moments ago.
  const notBeforeDate = new Date(now - 5 * 60_000)
  const notAfterDate = new Date(now + CERT_VALIDITY_MS)
  const keyPair = existingKey === undefined
    ? undefined
    : {
        privateKey: createPrivateKey(existingKey).export({ type: 'pkcs8', format: 'pem' }) as string,
        publicKey: createPublicKey(existingKey).export({ type: 'spki', format: 'pem' }) as string,
      }
  const result = await generate(
    [{ name: 'commonName', value: LAN_TLS_COMMON_NAME }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate,
      notAfterDate,
      ...(keyPair ? { keyPair } : {}),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: LAN_TLS_COMMON_NAME }] },
      ],
    },
  )
  return { key: existingKey ?? result.private, cert: result.cert }
}

/** Exact on-disk form, so a freshly issued value equals its later reload. */
function pemFile(pem: string): string {
  return pem.replace(/\r\n/g, '\n').trimEnd() + '\n'
}

async function writePrivate(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, contents, { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}
