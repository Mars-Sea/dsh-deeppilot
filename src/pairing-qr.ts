export const PAIRING_QR_TYPE = 'dsh-pocket-pairing'
export const PAIRING_QR_VERSION = 1

export interface PairingQRPayload {
  v: typeof PAIRING_QR_VERSION
  type: typeof PAIRING_QR_TYPE
  host: string
  token: string
}

export interface PairingTarget {
  host: string
  kind: 'public' | 'lan'
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '[::1]' || normalized === '::1' || normalized.startsWith('127.')
}

/** Prefer an online Funnel; otherwise turn the current web origin into a LAN target. */
export function selectPairingTarget(
  remote: { phase: string; publicURL?: string },
  lanAddresses: string[],
  currentOrigin?: string,
): PairingTarget | null {
  let origin: URL | undefined
  try {
    if (currentOrigin) origin = new URL(currentOrigin)
  } catch {
    // Fall through to the Host-reported address.
  }

  // Browsing DSH through the Funnel address itself is a public target even
  // when the report's phase flapped between refresh ticks.
  if (remote.publicURL && origin?.origin === remote.publicURL) {
    return { host: remote.publicURL, kind: 'public' }
  }
  if (remote.phase === 'online' && remote.publicURL) {
    return { host: remote.publicURL, kind: 'public' }
  }

  if (origin && ['http:', 'https:'].includes(origin.protocol) && !isLoopbackHostname(origin.hostname)) {
    return { host: origin.origin, kind: 'lan' }
  }

  const address = lanAddresses[0]
  if (!address) return null
  const protocol = origin?.protocol === 'https:' ? 'https:' : 'http:'
  const port = origin?.port ? `:${origin.port}` : ''
  return { host: `${protocol}//${address}${port}`, kind: 'lan' }
}

/** Encode an out-of-band pairing payload without putting the token in a URL. */
export function encodePairingQRPayload(host: string, token: string): string {
  const normalizedHost = host.trim()
  const parsed = new URL(normalizedHost)
  const protocols = ['http:', 'https:', 'ws:', 'wss:']
  if (!protocols.includes(parsed.protocol) || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('pairing QR requires a valid HTTP(S)/WS(S) host')
  }
  if (token.trim().length < 32) throw new TypeError('pairing token is invalid')
  const payload: PairingQRPayload = {
    v: PAIRING_QR_VERSION,
    type: PAIRING_QR_TYPE,
    host: normalizedHost,
    token: token.trim(),
  }
  return JSON.stringify(payload)
}
