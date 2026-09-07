import type { PushNotification } from './protocol.ts'
import { pushScopeFor } from './connection-policy.ts'

/** Prune only when the provider supplies an authoritative token-lifecycle verdict. */
export function shouldPrunePushToken(
  outcome: 'sent' | 'invalid-token' | 'failed',
  reason?: string,
): boolean {
  return outcome === 'invalid-token' && (reason === 'Unregistered' || reason === 'ExpiredToken')
}

/** APNs requires both registration and the same content permission as WS. */
export function mayReceivePush(device: { scopes?: readonly string[] }, notification: unknown): boolean {
  const scope = pushScopeFor('s2c.notify', notification)
  return scope !== undefined && device.scopes?.includes('notifications.register') === true &&
    device.scopes.includes(scope)
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

/** Apply before either transport receives the payload, including the Relay. */
export function pushContent(notification: PushNotification, mode?: 'preview' | 'generic'): PushNotification {
  if (mode !== 'generic') return notification
  const bodies: Record<PushNotification['category'], string> = {
    'turn.completed': 'A task has completed.',
    'approval.required': 'An approval needs your attention.',
    'question.asked': 'A question needs your answer.',
    'session.error': 'A task needs your attention.',
  }
  return { ...notification, title: 'DeepPilot', body: bodies[notification.category] ?? 'Open DeepPilot for an update.' }
}
