import type { PairingGrantSnapshot } from './report-wire.ts'

export const PAIRING_QR_TYPE = 'deeppilot-pairing'
export const PAIRING_QR_VERSION = 2

export interface PairingQRPayload {
  v: typeof PAIRING_QR_VERSION
  type: typeof PAIRING_QR_TYPE
  host: string
  code: string
  expiresAt: number
  audience: string
}

export interface PairingTarget {
  host: string
  kind: 'public' | 'lan'
}

/**
 * Return every explicit DeepPilot transport target. LAN comes first because
 * it is private and lower latency; an online Funnel remains available as a
 * separate choice instead of silently replacing the local address.
 */
export function selectPairingTargets(
  local: { phase: string; endpoints: string[] },
  remote: { phase: string; publicURL?: string },
): PairingTarget[] {
  const targets: PairingTarget[] = []
  if (local.phase === 'online') {
    for (const host of local.endpoints) {
      if (validTargetHost(host)) targets.push({ host, kind: 'lan' })
    }
  }
  if (remote.phase === 'online' && remote.publicURL && validTargetHost(remote.publicURL)) {
    targets.push({ host: remote.publicURL, kind: 'public' })
  }
  const seen = new Set<string>()
  return targets.filter(({ host }) => !seen.has(host) && seen.add(host))
}

function validTargetHost(value: string): boolean {
  try {
    const parsed = new URL(value)
    return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)
      && parsed.hostname !== ''
      && parsed.username === ''
      && parsed.password === ''
  } catch {
    return false
  }
}

/** Encode a short-lived, single-use pairing grant without URL credentials. */
export function encodePairingQRPayload(host: string, grant: PairingGrantSnapshot): string {
  const normalizedHost = host.trim()
  const parsed = new URL(normalizedHost)
  const protocols = ['http:', 'https:', 'ws:', 'wss:']
  if (!protocols.includes(parsed.protocol) || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('pairing QR requires a valid HTTP(S)/WS(S) host')
  }
  if (grant.code.trim().length < 32 || !Number.isInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) {
    throw new TypeError('pairing grant is invalid or expired')
  }
  if (!grant.audience.startsWith('deeppilot:')) throw new TypeError('pairing audience is invalid')
  const payload: PairingQRPayload = {
    v: PAIRING_QR_VERSION,
    type: PAIRING_QR_TYPE,
    host: normalizedHost,
    code: grant.code.trim(),
    expiresAt: grant.expiresAt,
    audience: grant.audience,
  }
  return JSON.stringify(payload)
}
