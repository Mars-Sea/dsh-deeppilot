/**
 * Minimal APNs provider client (HTTP/2) with zero npm dependencies.
 *
 * Implements exactly what the bridge needs:
 *  - ES256 provider token (JWT) signed with an Apple .p8 key, refreshed under
 *    the 1-hour freshness window Apple enforces;
 *  - one long-lived HTTP/2 session per environment, recreated transparently
 *    after GOAWAY/errors;
 *  - alert pushes carrying the notify projection (category/thread/collapse),
 *    with `interruption-level: time-sensitive` for approval/question events;
 *  - outcome classification so callers can prune dead device tokens.
 *
 * Privacy: logs carry outcomes and masked token prefixes only — never message
 * bodies or full tokens.
 */

import { connect as http2Connect, type ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { ApnsEnvironment } from './token.ts'
import type { PushNotification } from './protocol.ts'

export interface ApnsClientOptions {
  teamId: string
  keyId: string
  /** Absolute path to the .p8 private key file. */
  keyPath: string
  bundleId: string
  debug?: boolean
  log: (message: string) => void
}

export type ApnsOutcome = 'sent' | 'invalid-token' | 'failed'

/** Outcome plus Apple's rejection reason (when present) for diagnosis. */
export interface ApnsSendResult {
  outcome: ApnsOutcome
  reason?: string
}

const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000 // Apple allows 1h; refresh early.
const REQUEST_TIMEOUT_MS = 10_000

/** base64url without padding. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Sign one ES256 JWT for the given signing input with a P-256 private key. */
export function es256Jwt(signingInput: string, key: KeyObject): string {
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), {
    key,
    // JOSE/ES256 wants raw r||s; node emits DER by default.
    dsaEncoding: 'ieee-p1363',
  })
  return signingInput + '.' + b64url(signature)
}

/** Strip PEM armor from a .p8 file and decode to PKCS#8 DER. */
export function p8ToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

export interface LoadedKey {
  key: KeyObject
}

/** Pure payload builder so tests can assert the wire format without sockets. */
export function apnsPayload(notification: PushNotification): Record<string, unknown> {
  const timeSensitive = notification.category === 'approval.required' || notification.category === 'question.asked'
  return {
    aps: {
      alert: {
        title: notification.title.slice(0, 120),
        body: notification.body.slice(0, 200),
      },
      sound: 'default',
      category: notification.category,
      'thread-id': notification.sessionId.slice(0, 64),
      ...(timeSensitive ? { 'interruption-level': 'time-sensitive' } : {}),
    },
    sessionId: notification.sessionId,
    notificationId: notification.notificationId,
    kind: notification.category,
  }
}

/** One delivery request: the notify projection plus its target device token.
 * The environment comes from the device's own registration (its build kind),
 * so one client serves both sandbox and production devices. */
export interface ApnsSendRequest extends PushNotification {
  deviceToken: string
  environment: ApnsEnvironment
}

/** collapse-id accepts ≤64 bytes of ASCII; keep it stable per session+event. */
export function collapseIdFor(notification: PushNotification): string {
  const raw = `${notification.category}:${notification.sessionId}`
  return raw.replace(/[^a-zA-Z0-9.:-]/g, '').slice(0, 64)
}

function authorityFor(environment: ApnsEnvironment): string {
  return environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'
}

export class ApnsClient {
  private readonly log: (message: string) => void
  private readonly debug: boolean
  private readonly opts: ApnsClientOptions

  private providerToken = ''
  private providerTokenIssuedAt = 0
  private key: KeyObject | undefined

  constructor(opts: ApnsClientOptions) {
    this.opts = opts
    this.log = opts.log
    this.debug = opts.debug === true
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(
      sessions
        .filter((session) => !session.destroyed)
        .map((session) => new Promise<void>((resolve) => session.close(() => resolve()))),
    )
  }

  // ---------- credentials ----------

  private async ensureProviderToken(): Promise<string> {
    if (this.providerToken && Date.now() - this.providerTokenIssuedAt < PROVIDER_TOKEN_TTL_MS) {
      return this.providerToken
    }
    if (!this.key) {
      const pem = await readFile(this.opts.keyPath, 'utf8')
      this.key = createPrivateKey({ key: p8ToDer(pem), format: 'der', type: 'pkcs8' })
    }
    const issuedAt = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.opts.keyId }))
    const claims = b64url(JSON.stringify({ iss: this.opts.teamId, iat: issuedAt }))
    this.providerToken = es256Jwt(`${header}.${claims}`, this.key)
    this.providerTokenIssuedAt = Date.now()
    return this.providerToken
  }

  // ---------- transport ----------

  /** One long-lived HTTP/2 session per Apple host (sandbox + production). */
  private readonly sessions = new Map<string, ClientHttp2Session>()

  private ensureSession(authority: string): ClientHttp2Session {
    const existing = this.sessions.get(authority)
    if (existing && !existing.destroyed && !existing.closed) return existing
    const session = http2Connect(`https://${authority}`)
    // Keep a handler attached so background errors never become uncaught
    // exceptions; the next send() recreates the session when dead.
    session.on('error', (error) => {
      if (this.debug) this.log('apns session error (' + authority + '): ' + String(error))
      this.sessions.delete(authority)
    })
    this.sessions.set(authority, session)
    return session
  }

  /**
   * Deliver one alert. Never throws — every failure path resolves to an
   * outcome so fan-out loops cannot crash the host on a flaky network.
   */
  async send(request: ApnsSendRequest): Promise<ApnsSendResult> {
    const { deviceToken, environment, ...notification } = request
    let stream: ReturnType<ClientHttp2Session['request']> | undefined
    try {
      const token = await this.ensureProviderToken()
      const body = JSON.stringify(apnsPayload(notification))
      const session = this.ensureSession(authorityFor(environment))
      const done = new Promise<ApnsSendResult>((resolve) => {
        const req = session.request({
          [':method']: 'POST',
          [':path']: '/3/device/' + deviceToken,
          authorization: 'bearer ' + token,
          'apns-topic': this.opts.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          // Stale approvals arriving hours later are worse than none.
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
          'apns-collapse-id': collapseIdFor(notification),
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        })
        stream = req
        let status = 0
        let responseBody = ''
        const settle = (outcome: ApnsOutcome, reason?: string): void => {
          if (this.debug) {
            this.log(`apns ${outcome}${reason ? ' (' + reason + ')' : ''} (${this.maskToken(deviceToken)})`)
          }
          resolve(reason !== undefined && reason !== '' ? { outcome, reason } : { outcome })
        }
        const timer = setTimeout(() => {
          req.close()
          settle('failed')
        }, REQUEST_TIMEOUT_MS)
        timer.unref?.()
        req.on('response', (headers) => {
          status = Number(headers[':status'] ?? 0)
        })
        req.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString('utf8')
        })
        req.on('error', () => {
          clearTimeout(timer)
          settle('failed')
        })
        req.on('end', () => {
          clearTimeout(timer)
          if (status === 200) return settle('sent')
          let reason = ''
          try {
            reason = String((JSON.parse(responseBody) as { reason?: string }).reason ?? '')
          } catch {
            // non-JSON body; fall through with empty reason
          }
          if (status !== 200 && !reason) reason = 'HTTP ' + String(status)
          if (reason === 'Unregistered' || reason === 'BadDeviceToken') return settle('invalid-token', reason)
          if (this.debug) this.log(`apns rejected status=${status} reason=${reason}`)
          settle('failed', reason)
        })
        req.end(body)
      })
      return await done
    } catch (error) {
      // Credential load failures and dead sessions land here; force both to be
      // rebuilt on the next attempt.
      this.key = undefined
      this.providerToken = ''
      this.sessions.clear()
      if (this.debug) this.log('apns send failed: ' + String(error))
      return { outcome: 'failed', reason: String(error).slice(0, 120) }
    } finally {
      try { stream?.close() } catch { /* already closed */ }
    }
  }

  maskToken(token: string): string {
    return token.length <= 10 ? '…' : token.slice(0, 6) + '…' + token.slice(-4)
  }
}
