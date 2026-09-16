import type { PairingGrantSnapshot } from './report-wire.ts'

export const PAIRING_QR_TYPE = 'deeppilot-pairing'
export const PAIRING_QR_VERSION = 2

/** `sha256:` + base64url(SHA-256(SubjectPublicKeyInfo DER)) of the LAN certificate. */
export const LAN_TLS_FINGERPRINT_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/

export function isLanTlsFingerprint(value: unknown): value is string {
  return typeof value === 'string' && LAN_TLS_FINGERPRINT_PATTERN.test(value)
}

export interface PairingQRPayload {
  v: typeof PAIRING_QR_VERSION
  type: typeof PAIRING_QR_TYPE
  host: string
  code: string
  expiresAt: number
  audience: string
  /** Required for LAN hosts (self-signed TLS); absent for public-CA hosts. */
  tlsFingerprint?: string
}

export interface PairingTarget {
  host: string
  kind: 'public' | 'lan'
  tlsFingerprint?: string
}

/**
 * Return every explicit DeepPilot transport target. LAN comes first because
 * it is private and lower latency; an online Funnel remains available as a
 * separate choice instead of silently replacing the local address. A LAN
 * listener without a certificate pin is never offered: the app could not
 * trust it.
 */
export function selectPairingTargets(
  local: { phase: string; endpoints: string[]; tlsFingerprint?: string },
  remote: { phase: string; publicURL?: string },
): PairingTarget[] {
  const targets: PairingTarget[] = []
  if (local.phase === 'online' && isLanTlsFingerprint(local.tlsFingerprint)) {
    for (const host of local.endpoints) {
      if (validTargetHost(host)) targets.push({ host, kind: 'lan', tlsFingerprint: local.tlsFingerprint })
    }
  }
  if (remote.phase === 'online' && remote.publicURL && validTargetHost(remote.publicURL)) {
    targets.push({ host: remote.publicURL, kind: 'public' })
  }
  const seen = new Set<string>()
  return targets.filter(({ host }) => !seen.has(host) && seen.add(host))
}

/** Only encrypted transports are ever offered to the app. */
const TARGET_PROTOCOLS = ['https:', 'wss:']

function validTargetHost(value: string): boolean {
  try {
    const parsed = new URL(value)
    return TARGET_PROTOCOLS.includes(parsed.protocol)
      && parsed.hostname !== ''
      && parsed.username === ''
      && parsed.password === ''
  } catch {
    return false
  }
}

/** Encode a short-lived, single-use pairing grant without URL credentials. */
export function encodePairingQRPayload(host: string, grant: PairingGrantSnapshot, tlsFingerprint?: string): string {
  const normalizedHost = host.trim()
  if (!validTargetHost(normalizedHost)) {
    throw new TypeError('pairing QR requires a valid HTTPS/WSS host')
  }
  if (grant.code.trim().length < 32 || !Number.isInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) {
    throw new TypeError('pairing grant is invalid or expired')
  }
  if (!grant.audience.startsWith('deeppilot:')) throw new TypeError('pairing audience is invalid')
  if (tlsFingerprint !== undefined && !isLanTlsFingerprint(tlsFingerprint)) {
    throw new TypeError('pairing TLS fingerprint is invalid')
  }
  const payload: PairingQRPayload = {
    v: PAIRING_QR_VERSION,
    type: PAIRING_QR_TYPE,
    host: normalizedHost,
    code: grant.code.trim(),
    expiresAt: grant.expiresAt,
    audience: grant.audience,
    ...(tlsFingerprint !== undefined ? { tlsFingerprint } : {}),
  }
  return JSON.stringify(payload)
}
