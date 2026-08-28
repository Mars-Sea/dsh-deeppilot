import type { WebSocket } from 'ws'
import {
  PROTOCOL_VERSION,
} from './protocol.ts'
import type { Envelope, HelloAuthPayload } from './protocol.ts'
import type { BridgeSink, HostBridge } from './host-bridge.ts'
import type { DeviceStore, ApnsEnvironment } from './token.ts'
import { isValidApnsToken, tokenMatches } from './token.ts'

export const AUTH_TIMEOUT_MS = 5_000
export const MAX_OUTBOUND_BUFFER_BYTES = 4 * 1024 * 1024
/**
 * Pre-auth frame cap. The 64 MiB cap on a fully authenticated socket exists
 * to support multi-MB image attachments; before hello the only legal frames
 * are c2s.ping and c2s.hello.auth, neither of which can legitimately exceed
 * a few KB. Capping unauthenticated frames at 64 KiB keeps an anonymous TCP
 * peer from forcing expensive JSON.parse work on a 64 MiB payload inside
 * the 5-second auth window.
 */
export const PRE_AUTH_FRAME_BYTES = 64 * 1024
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_PROMPT_IMAGES = 4
const MAX_BASE64_CHARS_PER_IMAGE = 8 * 1024 * 1024
/** Bounds a single prompt's text; the frame itself is capped by ws maxPayload. */
const MAX_PROMPT_TEXT_CHARS = 256 * 1024
// Client-supplied identity fields land in logs and devices.json — keep them
// short and free of control characters so they can neither flood the registry
// nor forge log lines.
const MAX_DEVICE_ID_CHARS = 128
const MAX_DEVICE_NAME_CHARS = 64
const MAX_APP_VERSION_CHARS = 32

function sanitizeDeviceField(value: unknown, maxChars: number): string {
  const raw = typeof value === 'string' ? value : String(value ?? '')
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxChars)
}

export interface ConnectionStateDeps {
  bridge: HostBridge
  devices: DeviceStore
  serverVersion: string
  /** Pairing secret used when the HTTP upgrade was not already authenticated. */
  expectedToken: string
  /** True when Authorization or the legacy query parameter passed at upgrade. */
  transportAuthenticated?: boolean
  debug?: boolean
  log: (message: string) => void
  /** Called once when the socket closes (cleanly or not). */
  onClosed?: (connection: BridgeConnection) => void
  /**
   * Zero-touch push enrollment: fired when a distributed app presents the
   * distributor's shared enrollKey during c2s.push.register. May perform the
   * relay round-trip; the register handler awaits it before evaluating push
   * readiness, so the very first registration can switch the feature on.
   */
  onPushEnrollKey?: (enrollKey: string) => Promise<void> | void
}

export function helloTokenAccepted(
  transportAuthenticated: boolean | undefined,
  presentedToken: string | undefined,
  expectedToken: string,
): boolean {
  return transportAuthenticated === true || tokenMatches(presentedToken, expectedToken)
}

/**
 * One connected phone. Implements BridgeSink so the HostBridge can push
 * projected frames and replays. Bearer/query credentials may authenticate the
 * HTTP upgrade; otherwise the first hello frame is verified here.
 */
export class BridgeConnection implements BridgeSink {
  private authenticated = false
  private closed = false
  private helloTimer: NodeJS.Timeout | undefined
  private readonly openSessions = new Set<string>()
  /** Sanitized device identity from hello; needed for push registration. */
  private deviceId: string | undefined

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: ConnectionStateDeps,
  ) {
    ws.on('message', (data) => {
      void this.onMessage(String(data))
    })
    ws.on('close', () => {
      this.onClose()
      deps.onClosed?.(this)
    })
    ws.on('error', () => {
      /* close follows */
    })
    this.helloTimer = setTimeout(() => {
      if (!this.authenticated) this.close(4402, 'auth timeout')
    }, AUTH_TIMEOUT_MS)
  }

  /** Hard-drop the socket (server-side stale sweep). */
  terminate(): void {
    this.ws.terminate()
  }

  /** Protocol-compliant idle timeout: let the peer observe a normal 1001 close. */
  closeIdle(): void {
    this.close(1001, 'idle timeout')
  }

  /** Announce an orderly plugin/data-plane shutdown before closing the socket. */
  closeForServerStop(): void {
    this.fail(undefined, 'E_INTERNAL', 'server stopping')
    this.close(1001, 'server stopping')
  }

  /** Used by dependency-lifecycle cleanup to avoid closing a replacement bridge. */
  isAttachedTo(bridge: HostBridge): boolean {
    return this.deps.bridge === bridge
  }

  /** Device identity once hello succeeded; undefined before that. */
  get connectedDeviceId(): string | undefined {
    return this.authenticated ? this.deviceId : undefined
  }

  // ---------- BridgeSink ----------

  push(type: string, payload: unknown, seq?: number): void {
    if (this.deps.debug === true) this.deps.log('push ' + type + ' seq=' + String(seq))
    this.send(type, payload, undefined, seq)
  }

  replay(entries: Array<{ seq: number; type: string; payload: unknown }>): void {
    for (const entry of entries) this.push(entry.type, entry.payload, entry.seq)
  }

  replayDone(): void {
    this.push('s2c.resume.done', {})
  }

  resync(): void {
    this.push('s2c.resync', { reason: 'gap' })
  }

  lastCursor(): number {
    return this.deps.bridge.currentCursor()
  }

  // ---------- lifecycle ----------

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    for (const id of this.openSessions) {
      this.deps.bridge.markSinkClosed(this, id)
    }
    this.openSessions.clear()
    this.deps.bridge.dropSinkSessions(this)
    if (this.authenticated) this.deps.bridge.removeSink(this)
  }

  private close(code: number, reason: string): void {
    if (this.closed) return
    try {
      this.ws.close(code, reason)
    } catch {
      this.ws.terminate()
    }
  }

  private send(type: string, payload: unknown, id?: string, seq?: number): void {
    const envelope: Envelope = {
      v: PROTOCOL_VERSION,
      type,
      ts: Date.now(),
      ...(id !== undefined ? { id } : {}),
      ...(seq !== undefined ? { seq } : {}),
      payload,
    }
    if (this.ws.readyState !== this.ws.OPEN) return
    if (this.ws.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
      this.close(1013, 'client too slow')
      return
    }
    this.ws.send(JSON.stringify(envelope))
  }

  private fail(id: string | undefined, code: keyof typeof ERROR_CODES, message: string): void {
    this.send('s2c.error', { code, message }, id)
  }

  // ---------- dispatch ----------

    private lastActivity = Date.now()

    /** True when no inbound frame arrived within maxIdleMs. */
    isStale(now: number, maxIdleMs: number): boolean {
      return now - this.lastActivity > maxIdleMs
    }

    private async onMessage(raw: string): Promise<void> {
      this.lastActivity = Date.now()
      // Cheap length guard before the JSON parse: pre-auth frames are tiny
      // (hello/ping), so anything over 64 KiB is either junk or an attempt
      // to make us spend CPU before the auth deadline. Reject without
      // trying to parse, so the cost is just the length check.
      if (!this.authenticated && raw.length > PRE_AUTH_FRAME_BYTES) {
        this.close(1009, 'pre-auth frame too large')
        return
      }
      let env: Envelope
    try {
      env = JSON.parse(raw) as Envelope
    } catch {
      this.fail(undefined, 'E_PROTOCOL', 'frame is not valid JSON')
      return
    }
    if (env.v !== PROTOCOL_VERSION) {
      this.fail(env.id, 'E_UNSUPPORTED', 'unsupported protocol version')
      this.close(4500, 'protocol version mismatch')
      return
    }
    if (!this.authenticated) {
      if (env.type === 'c2s.ping') {
        this.send('s2c.pong', { serverTime: Date.now() }, env.id)
        return
      }
      if (env.type === 'c2s.hello.auth') {
        await this.hello(env)
        return
      }
      this.fail(env.id, 'E_PROTOCOL', 'authenticate first')
      return
    }
    switch (env.type) {
      case 'c2s.ping': {
        this.send('s2c.pong', { serverTime: Date.now() }, env.id)
        return
      }
      case 'c2s.sessions.list': {
        this.send('s2c.sessions.snapshot', { full: true, sessions: this.deps.bridge.listSessions() }, env.id)
        return
      }
      case 'c2s.pending.list': {
        this.send('s2c.pending.snapshot', this.deps.bridge.pendingSnapshot(), env.id)
        return
      }
      case 'c2s.workspaces.list': {
        if (!this.deps.bridge.capabilities.projectSelection) {
          return this.fail(env.id, 'E_UNSUPPORTED', 'project selection unavailable on this host version')
        }
        const result = await this.deps.bridge.listWorkspaces()
        if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message)
        this.send('s2c.workspaces.snapshot', { workspaces: result.value }, env.id)
        return
      }
      case 'c2s.directory.list': {
        const p = env.payload as { path?: unknown } | undefined
        if (p?.path !== undefined && typeof p.path !== 'string') {
          return this.fail(env.id, 'E_PROTOCOL', 'path must be a string')
        }
        const result = await this.deps.bridge.listDirectory(p?.path as string | undefined)
        if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message)
        this.send('s2c.directory.listing', result.value, env.id)
        return
      }
      case 'c2s.directory.pick': {
        const result = await this.deps.bridge.pickDirectory()
        if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message)
        this.send('s2c.directory.picked', { path: result.value }, env.id)
        return
      }
      case 'c2s.workspace.create': {
        const p = env.payload as { path?: unknown } | undefined
        const path = typeof p?.path === 'string' ? p.path.trim() : ''
        if (!path) return this.fail(env.id, 'E_PROTOCOL', 'non-empty path required')
        if (!this.deps.bridge.capabilities.projectSelection) {
          return this.fail(env.id, 'E_UNSUPPORTED', 'project selection unavailable on this host version')
        }
        const result = await this.deps.bridge.createWorkspace(path)
        if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message)
        this.send('s2c.workspace.created', result.value, env.id)
        return
      }
      case 'c2s.session.open': {
        const p = env.payload as { sessionId?: string; tailCount?: number }
        if (!p?.sessionId || typeof p.sessionId !== 'string') return this.fail(env.id, 'E_PROTOCOL', 'sessionId required')
        const sessionId = p.sessionId
        this.openSessions.add(sessionId)
        this.deps.bridge.markSinkOpen(this, sessionId)
        const ok = await this.deps.bridge.openSession(this, sessionId, p.tailCount ?? 100)
        if (!ok) {
          // Roll the viewer registration back: a failed open must not keep
          // suppressing turn notifications for a session this device never
          // actually received.
          this.openSessions.delete(sessionId)
          this.deps.bridge.markSinkClosed(this, sessionId)
          return this.fail(env.id, 'E_NOT_FOUND', 'session history unavailable')
        }
        return
      }
      case 'c2s.session.close': {
        const p = env.payload as { sessionId?: string }
        if (!p?.sessionId) return this.fail(env.id, 'E_PROTOCOL', 'sessionId required')
        this.openSessions.delete(p.sessionId)
        this.deps.bridge.markSinkClosed(this, p.sessionId)
        this.send('s2c.ack', {}, env.id)
        return
      }
      case 'c2s.session.create': {
        const p = env.payload as { workspaceId?: unknown; cwd?: unknown } | undefined
        const workspaceId = typeof p?.workspaceId === 'string' ? p.workspaceId.trim() : ''
        const cwd = typeof p?.cwd === 'string' ? p.cwd.trim() : ''
        if (workspaceId && cwd) return this.fail(env.id, 'E_PROTOCOL', 'workspaceId and cwd are mutually exclusive')
        const newId = await this.deps.bridge.createSession({
          ...(workspaceId ? { workspaceId } : {}),
          ...(cwd ? { cwd } : {}),
        })
        if (!newId) return this.fail(env.id, 'E_INTERNAL', 'session create failed')
        this.send('s2c.ack', { sessionId: newId }, env.id)
        return
      }
      case 'c2s.session.rename': {
        const p = env.payload as { sessionId?: string; title?: string }
        const title = typeof p?.title === 'string' ? p.title.trim() : ''
        if (!p?.sessionId || title.length === 0) {
          return this.fail(env.id, 'E_PROTOCOL', 'sessionId and non-empty title required')
        }
        if (!this.deps.bridge.capabilities.sessionManagement) {
          return this.fail(env.id, 'E_UNSUPPORTED', 'session management unavailable on this host version')
        }
        const result = await this.deps.bridge.renameSession(p.sessionId, title)
        if (!result.ok) {
          const code = result.kind === 'not-found' ? 'E_NOT_FOUND'
            : result.kind === 'busy' ? 'E_BUSY'
              : result.kind === 'unsupported' ? 'E_UNSUPPORTED'
                : result.kind === 'invalid' ? 'E_PROTOCOL'
                  : 'E_INTERNAL'
          return this.fail(env.id, code, result.message)
        }
        this.send('s2c.session.renamed', { sessionId: p.sessionId, title: result.value }, env.id)
        return
      }
      case 'c2s.session.archive': {
        const p = env.payload as { sessionId?: string }
        if (!p?.sessionId) return this.fail(env.id, 'E_PROTOCOL', 'sessionId required')
        if (!this.deps.bridge.capabilities.sessionManagement) {
          return this.fail(env.id, 'E_UNSUPPORTED', 'session management unavailable on this host version')
        }
        const result = await this.deps.bridge.archiveSession(p.sessionId)
        if (!result.ok) {
          const code = result.kind === 'not-found' ? 'E_NOT_FOUND'
            : result.kind === 'busy' ? 'E_BUSY'
              : result.kind === 'unsupported' ? 'E_UNSUPPORTED'
                : result.kind === 'invalid' ? 'E_PROTOCOL'
                  : 'E_INTERNAL'
          return this.fail(env.id, code, result.message)
        }
        this.send('s2c.session.archived', { sessionId: p.sessionId }, env.id)
        return
      }
      case 'c2s.session.cancel': {
        const p = env.payload as { sessionId?: string }
        if (!p?.sessionId) return this.fail(env.id, 'E_PROTOCOL', 'sessionId required')
        const result = await this.deps.bridge.cancelSession(p.sessionId)
        if (!result.ok) {
          const code = result.kind === 'not-found' ? 'E_NOT_FOUND'
            : result.kind === 'busy' ? 'E_BUSY'
              : result.kind === 'unsupported' ? 'E_UNSUPPORTED'
                : result.kind === 'invalid' ? 'E_PROTOCOL'
                  : 'E_INTERNAL'
          return this.fail(env.id, code, result.message)
        }
        this.send('s2c.ack', { sessionId: p.sessionId }, env.id)
        return
      }
      case 'c2s.session.history': {
        const p = env.payload as { sessionId?: string; beforeSeq?: number; limit?: number }
        if (!p?.sessionId || typeof p.beforeSeq !== 'number') {
          return this.fail(env.id, 'E_PROTOCOL', 'sessionId and beforeSeq required')
        }
        const ok = await this.deps.bridge.historyPage(this, p.sessionId, p.beforeSeq, Math.min(p.limit ?? 100, 500))
        if (!ok) this.fail(env.id, 'E_NOT_FOUND', 'history unavailable')
        return
      }
      case 'c2s.session.attachment': {
        const p = env.payload as { sessionId?: string; attachmentId?: string }
        if (!p?.sessionId || typeof p.attachmentId !== 'string' || p.attachmentId.length === 0) {
          return this.fail(env.id, 'E_PROTOCOL', 'sessionId and attachmentId required')
        }
        const image = await this.deps.bridge.attachmentData(p.sessionId, p.attachmentId)
        if (!image) return this.fail(env.id, 'E_NOT_FOUND', 'attachment unavailable')
        this.send('s2c.ack', image, env.id)
        return
      }
      case 'c2s.session.models': {
        const p = env.payload as { sessionId?: string }
        if (!p?.sessionId) return this.fail(env.id, 'E_PROTOCOL', 'sessionId required')
        if (!this.deps.bridge.capabilities.models) {
          return this.fail(env.id, 'E_UNSUPPORTED', 'model selection unavailable on this host version')
        }
        const result = await this.deps.bridge.sessionModels(p.sessionId)
        if (!result.ok) {
          const code = result.kind === 'not-found' ? 'E_NOT_FOUND'
            : result.kind === 'busy' ? 'E_BUSY'
              : result.kind === 'unsupported' ? 'E_UNSUPPORTED'
                : result.kind === 'unavailable' ? 'E_NOT_FOUND'
                  : 'E_INTERNAL'
          return this.fail(env.id, code, result.message)
        }
        this.send('s2c.session.models', { sessionId: p.sessionId, ...result.value }, env.id)
        return
      }
      case 'c2s.session.selectModel': {
        const p = env.payload as {
          sessionId?: string
          provider?: string
          model?: string
          reasoningEffort?: string
        }
        if (!p?.sessionId || !p.provider?.trim() || !p.model?.trim()) {
          return this.fail(env.id, 'E_PROTOCOL', 'sessionId, provider and model required')
        }
        if (!this.deps.bridge.capabilities.models) {
          return this.fail(env.id, 'E_UNSUPPORTED', 'model selection unavailable on this host version')
        }
        const result = await this.deps.bridge.selectSessionModel(p.sessionId, {
          provider: p.provider.trim(),
          model: p.model.trim(),
          ...(p.reasoningEffort?.trim() ? { reasoningEffort: p.reasoningEffort.trim() } : {}),
        })
        if (!result.ok) {
          const code = result.kind === 'not-found' ? 'E_NOT_FOUND'
            : result.kind === 'busy' ? 'E_BUSY'
              : result.kind === 'unsupported' ? 'E_UNSUPPORTED'
                : result.kind === 'unavailable' ? 'E_NOT_FOUND'
                  : 'E_INTERNAL'
          return this.fail(env.id, code, result.message)
        }
        this.send('s2c.session.modelSelected', { sessionId: p.sessionId, selected: result.value }, env.id)
        return
      }
      case 'c2s.session.sendPrompt': {
        const p = env.payload as {
          sessionId?: string
          text?: string
          images?: Array<{ mediaType?: string; data?: string; name?: string }>
        }
        const text = typeof p?.text === 'string' ? p.text : ''
        const rawImages = Array.isArray(p?.images) ? p.images : []
        if (!p?.sessionId || (text.trim().length === 0 && rawImages.length === 0)) {
          return this.fail(env.id, 'E_PROTOCOL', 'sessionId and text or images required')
        }
        if (text.length > MAX_PROMPT_TEXT_CHARS) {
          return this.fail(env.id, 'E_PROTOCOL', 'prompt text too long')
        }
        if (rawImages.length > MAX_PROMPT_IMAGES) {
          return this.fail(env.id, 'E_PROTOCOL', 'too many images')
        }
        const images: Array<{
          mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
          data: string
          name?: string
        }> = []
        for (const image of rawImages) {
          if (!IMAGE_MEDIA_TYPES.has(String(image?.mediaType)) ||
              typeof image?.data !== 'string' || image.data.length === 0 ||
              image.data.length > MAX_BASE64_CHARS_PER_IMAGE) {
            return this.fail(env.id, 'E_PROTOCOL', 'invalid image attachment')
          }
          images.push({
            mediaType: image.mediaType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
            data: image.data,
            ...(typeof image.name === 'string' && sanitizeImageName(image.name).length > 0
              ? { name: sanitizeImageName(image.name) }
              : {}),
          })
        }
        const userSeq = await this.deps.bridge.sendPrompt(p.sessionId, text, images)
        if (!userSeq.ok) return this.fail(env.id, managementErrorCode(userSeq.kind), userSeq.message)
        this.send('s2c.ack', { userSeq: userSeq.value }, env.id)
        return
      }
      case 'c2s.approval.respond': {
        const p = env.payload as { requestId?: string; decision?: string; reason?: string }
        if (!p?.requestId || (p.decision !== 'allow' && p.decision !== 'deny')) {
          return this.fail(env.id, 'E_PROTOCOL', 'requestId and decision required')
        }
        // PROTOCOL v1: the optional deny reason must reach the host so the
        // model learns why its tool call was refused.
        const outcome = await this.deps.bridge.respondApproval(
          p.requestId,
          p.decision,
          typeof p.reason === 'string' ? p.reason : undefined,
        )
        if (!outcome.ok) return this.fail(env.id, pendingResponseErrorCode(outcome.reason), pendingResponseMessage('approval', outcome.reason))
        this.send('s2c.ack', {}, env.id)
        return
      }
      case 'c2s.question.respond': {
        const p = env.payload as { requestId?: string; answers?: unknown }
        if (!p?.requestId || !Array.isArray(p.answers)) {
          return this.fail(env.id, 'E_PROTOCOL', 'requestId and answers required')
        }
        const outcome = await this.deps.bridge.respondQuestion(p.requestId, p.answers)
        if (!outcome.ok) return this.fail(env.id, pendingResponseErrorCode(outcome.reason), pendingResponseMessage('question', outcome.reason))
        this.send('s2c.ack', {}, env.id)
        return
      }
      case 'c2s.push.register': {
        const p = env.payload as { deviceToken?: unknown; environment?: unknown; categories?: unknown; enrollKey?: unknown }
        const token = typeof p?.deviceToken === 'string' ? p.deviceToken.trim() : ''
        if (!isValidApnsToken(token)) {
          return this.fail(env.id, 'E_PROTOCOL', 'hex deviceToken (32-512 chars) required')
        }
        const environment: ApnsEnvironment = p?.environment === 'production' ? 'production' : 'development'
        const categories = typeof p?.categories === 'object' && p.categories !== null
          ? p.categories as Record<string, boolean>
          : undefined
        if (!this.deviceId || !this.authenticated) {
          return this.fail(env.id, 'E_PROTOCOL', 'authenticate first')
        }
        // Zero-touch enrollment MUST run before the capability gate: a fresh,
        // unconfigured bridge receives its first register precisely when push
        // is not yet enabled, and the key itself flips relay mode on. The
        // relay round-trip is awaited so readiness reflects reality.
        if (typeof p?.enrollKey === 'string') {
          const enrollKey = p.enrollKey.trim().replace(/[^\x20-\x7e]/g, '').slice(0, 128)
          if (enrollKey.length >= 8 && enrollKey.length <= 128) {
            await this.deps.onPushEnrollKey?.(enrollKey)
          }
        }
        // Store the registration BEFORE the readiness gate: if push is still
        // mid-bootstrap (or the relay is temporarily down), the token is
        // already on file for when it recovers — no extra register needed.
        this.deps.devices.setPushToken(this.deviceId, token, environment, categories, Date.now())
        if (!this.deps.bridge.capabilities.push) {
          if (this.deps.debug === true) this.deps.log('push register held: bridge not ready')
          return this.fail(env.id, 'E_UNSUPPORTED', 'push is not configured on this bridge')
        }
        if (this.deps.debug === true) {
          this.deps.log('push token registered env=' + environment)
        }
        // `enabled` lets the app flip its local capability immediately instead
        // of waiting for the next handshake.
        this.send('s2c.ack', { enabled: true }, env.id)
        return
      }
      default:
        this.fail(env.id, 'E_PROTOCOL', 'unknown type: ' + env.type)
    }
  }

  private async hello(env: Envelope): Promise<void> {
    const p = (env.payload ?? {}) as Partial<HelloAuthPayload>
    if (!helloTokenAccepted(this.deps.transportAuthenticated, p.token, this.deps.expectedToken)) {
      this.fail(env.id, 'E_AUTH', 'token missing or invalid')
      this.close(4401, 'invalid token')
      return
    }
    if (!p.deviceId) {
      this.fail(env.id, 'E_PROTOCOL', 'deviceId required')
      this.close(4403, 'deviceId required')
      return
    }
    const deviceId = sanitizeDeviceField(p.deviceId, MAX_DEVICE_ID_CHARS)
    if (!deviceId) {
      this.fail(env.id, 'E_PROTOCOL', 'deviceId required')
      this.close(4403, 'deviceId required')
      return
    }
    const deviceName = sanitizeDeviceField(p.deviceName, MAX_DEVICE_NAME_CHARS) || 'unknown'
    const appVersion = sanitizeDeviceField(p.appVersion, MAX_APP_VERSION_CHARS) || 'unknown'
    this.authenticated = true
    this.deviceId = deviceId
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    this.deps.devices.touch({ deviceId, deviceName, appVersion }, Date.now())
    this.deps.log('device paired: ' + deviceName + ' (' + deviceId + ')')

    const cursor = typeof p.resumeCursor === 'number' && p.resumeCursor >= 0
      ? p.resumeCursor
      : undefined
    const canResume = cursor !== undefined && this.deps.bridge.canResumeFrom(cursor)
    // Welcome strictly precedes any replayed pushes.
    this.send('s2c.welcome', {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.deps.serverVersion,
      capabilities: this.deps.bridge.capabilities,
      cursor: this.deps.bridge.currentCursor(),
      resumed: canResume,
    }, env.id)
    this.deps.bridge.addSink(this)
    if (cursor !== undefined) {
      if (canResume) {
        this.deps.bridge.resumeFrom(cursor, this)
      } else {
        this.resync()
      }
    }
  }
}

function sanitizeImageName(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 120)
}

const ERROR_CODES = {
  E_AUTH: 'token missing or invalid',
  E_PROTOCOL: 'unknown type or malformed payload',
  E_NOT_FOUND: 'session or request not found',
  E_BUSY: 'session is busy',
  E_UNSUPPORTED: 'protocol version or capability unsupported',
  E_INTERNAL: 'internal error',
} as const

/** Error code for a failed approval/question response outcome. */
function pendingResponseErrorCode(reason: 'not-pending' | 'bad-response' | 'transport'): keyof typeof ERROR_CODES {
  switch (reason) {
    case 'not-pending': return 'E_NOT_FOUND'
    // The host refused the answer batch (shape/labels mismatch) — a client
    // payload problem, not a missing pending request.
    case 'bad-response': return 'E_PROTOCOL'
    case 'transport': return 'E_INTERNAL'
  }
}

/** Human-readable failure detail; `question not pending` must only ever mean
 * "nothing pending", never "the host rejected the answer". */
function pendingResponseMessage(
  kind: 'approval' | 'question',
  reason: 'not-pending' | 'bad-response' | 'transport',
): string {
  switch (reason) {
    case 'not-pending': return kind + ' not pending'
    case 'bad-response': return kind + ' answer rejected by host: answer does not match the asked questions'
    case 'transport': return 'host connection failed while answering ' + kind
  }
}

function managementErrorCode(
  kind: 'unsupported' | 'not-found' | 'busy' | 'invalid' | 'internal',
): keyof typeof ERROR_CODES {
  switch (kind) {
    case 'unsupported': return 'E_UNSUPPORTED'
    case 'not-found': return 'E_NOT_FOUND'
    case 'busy': return 'E_BUSY'
    case 'invalid': return 'E_PROTOCOL'
    case 'internal': return 'E_INTERNAL'
  }
}
