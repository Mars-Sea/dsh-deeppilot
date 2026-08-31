/**
 * Client for the operator-run push relay (relay/server.js). Used when the App
 * is distributed under the operator's team: bridges cannot hold the
 * distributor's .p8, so they forward notify projections over HTTPS and let
 * the relay do APNs.
 *
 * Outcome contract mirrors src/apns.ts exactly so the dispatcher prunes dead
 * tokens identically on either path:
 *   sent | invalid-token (terminal Unregistered/ExpiredToken) | failed
 */

import type { ApnsEnvironment } from './token.ts'
import type { PushNotification } from './protocol.ts'
import { normalizeRelayBaseUrl } from './relay-url.ts'

export interface RelayClientOptions {
  /** Base URL of the relay, e.g. https://relay.example.com */
  url: string
  /** Per-user bearer token issued by the relay operator (or via enroll). */
  token?: string
  timeoutMs?: number
  debug?: boolean
  log: (message: string) => void
}

export interface RelaySendRequest {
  deviceToken: string
  environment: ApnsEnvironment
  notification: PushNotification
}

export class RelayClient {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly debug: boolean
  private readonly log: (message: string) => void

  constructor(opts: RelayClientOptions) {
    this.base = normalizeRelayBaseUrl(opts.url)
    this.token = (opts.token ?? '').trim()
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.debug = opts.debug === true
    this.log = opts.log
  }

  /**
   * Zero-touch enrollment: exchange the distributor's shared key (baked into
   * the distributed app) for a stable per-bridge bearer token. Idempotent —
   * relays derive the same token for the same clientId. Returns null on any
   * failure; callers treat that as "not enrolled yet", not as an error.
   */
  async enroll(clientId: string, enrollKey: string): Promise<string | null> {
    try {
      const response = await fetch(this.base + '/v1/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId, enrollKey }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!response.ok) {
        if (this.debug) this.log(`enroll http ${response.status}`)
        return null
      }
      const body = (await response.json()) as { token?: unknown }
      if (typeof body.token === 'string' && body.token.startsWith('rl_')) return body.token
      if (this.debug) this.log('enroll returned no usable token')
      return null
    } catch (error) {
      if (this.debug) this.log('enroll failed: ' + String(error))
      return null
    }
  }

  async send(request: RelaySendRequest): Promise<{ outcome: 'sent' | 'invalid-token' | 'failed'; reason?: string }> {
    try {
      const response = await fetch(this.base + '/v1/push', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + this.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          deviceToken: request.deviceToken,
          environment: request.environment,
          notification: request.notification,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (response.status === 401 || response.status === 429) {
        // Credential/quota problems are configuration errors, not token death;
        // surface as failed so the user fixes the config instead of silently
        // losing registrations.
        if (this.debug) this.log(`relay rejected status=${response.status}`)
        return { outcome: 'failed', reason: 'HTTP ' + String(response.status) }
      }
      if (!response.ok) {
        if (this.debug) this.log(`relay http ${response.status}`)
        return { outcome: 'failed', reason: 'HTTP ' + String(response.status) }
      }
      const body = (await response.json()) as { outcome?: string; reason?: string }
      if (body.outcome === 'sent') return { outcome: 'sent' }
      if (body.outcome === 'invalid-token') return { outcome: 'invalid-token', reason: body.reason }
      if (this.debug) this.log('relay outcome=' + String(body.outcome) + ' reason=' + String(body.reason ?? ''))
      return { outcome: 'failed', reason: body.reason }
    } catch (error) {
      if (this.debug) this.log('relay send failed: ' + String(error))
      const message = error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
      return { outcome: 'failed', reason: message }
    }
  }
}
