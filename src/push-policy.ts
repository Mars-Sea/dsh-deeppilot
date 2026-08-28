/** Prune only when the provider supplies an authoritative token-lifecycle verdict. */
export function shouldPrunePushToken(
  outcome: 'sent' | 'invalid-token' | 'failed',
  reason?: string,
): boolean {
  return outcome === 'invalid-token' && (reason === 'Unregistered' || reason === 'ExpiredToken')
}

/**
 * Zero-touch relay self-heal: HTTP 401 means the relay no longer honors the
 * cached credential. Only auto-enrolled cells with a still-current token may
 * re-derive it; an explicitly configured relay token remains user-owned
 * configuration and is never silently rewritten.
 */
export function shouldReEnrollRelayToken(
  transport: 'apns' | 'relay',
  outcome: 'sent' | 'invalid-token' | 'failed',
  reason: string | undefined,
  opts: { usedCellToken: boolean; hasEnrollKey: boolean; tokenStillCurrent: boolean },
): boolean {
  return (
    transport === 'relay' &&
    outcome === 'failed' &&
    reason === 'HTTP 401' &&
    opts.hasEnrollKey &&
    opts.usedCellToken &&
    opts.tokenStillCurrent
  )
}
