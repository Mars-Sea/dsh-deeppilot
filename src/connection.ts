import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from './protocol.ts'
import type { AuthProofPayload, Envelope } from './protocol.ts'
import type { BridgeSink, HostBridge } from './host-bridge.ts'
import type { DeviceStore } from './token.ts'
import {
  createAuthChallenge,
  verifyAuthProof,
  type AuthChallenge,
  type DeviceScope,
} from './device-auth.ts'
import {
  AUTH_TIMEOUT_MS,
  MAX_APP_VERSION_CHARS,
  MAX_DEVICE_ID_CHARS,
  MAX_DEVICE_NAME_CHARS,
  MAX_OUTBOUND_BUFFER_BYTES,
  PRE_AUTH_FRAME_BYTES,
  sanitizeDeviceField,
  isEnvelope,
} from './connection-policy.ts'
import type { WireErrorCode } from './wire-errors.ts'
import {
  capabilityRejection,
  dispatchFrame,
  registryRowFor,
  scopeRejection,
  validatePayload,
  widgetPolicyOf,
  type FrameContext,
  type OpenEventBuffer,
  type S2CType,
} from './wire-registry.ts'

export {
  AUTH_TIMEOUT_MS,
  MAX_OUTBOUND_BUFFER_BYTES,
  PRE_AUTH_FRAME_BYTES,
} from './connection-policy.ts'

export interface ConnectionStateDeps {
  bridge: HostBridge
  devices: DeviceStore
  serverVersion: string
  /** Stable Host identity included in every signed challenge. */
  audience: string
  debug?: boolean
  log: (message: string) => void
  /** Called once when the socket closes (cleanly or not). */
  onClosed?: (connection: BridgeConnection) => void
  /** Releases an unauthenticated connection slot and updates failure state. */
  onAuthenticationSettled?: (ok: boolean, reason: 'success' | 'invalid-proof' | 'timeout' | 'closed') => void
  /** Emits a privacy-preserving audit event after a valid hello. */
  onDeviceAuthenticated?: (deviceId: string) => void
  /**
   * Zero-touch push enrollment: fired when a distributed app presents the
   * distributor's shared enrollKey during c2s.push.register. May perform the
   * relay round-trip; the register handler awaits it before evaluating push
   * readiness, so the very first registration can switch the feature on.
   */
  onPushEnrollKey?: (enrollKey: string) => Promise<void> | void
  /**
   * c2s.device.revoke (device unbind): the registered device revoked itself
   * and every OTHER active connection of that device must be dropped.
   * `except` is the connection that sent the frame — its close is already
   * owned by the handler (ack first, then 4401). The hook must not flip the
   * registry itself; the handler calls DeviceStore.revoke before this.
   */
  onDeviceRevoke?: (deviceId: string, except: BridgeConnection) => Promise<unknown> | unknown
}

/**
 * One connected phone. Implements BridgeSink so the HostBridge can push
 * projected frames and replays. Every socket starts anonymous, receives one
 * server challenge, and must prove possession of a registered P-256 key.
 *
 * 本模块拥有传输与连接状态：帧的解析、鉴权门、sink 注册、开关Socket。帧的
 * 事实（scope / 能力 / 校验 / 处理）住在 wire-registry 及其特性模块里；
 * onMessage 只按固定次序调用那些检查，然后 dispatch。
 */
export class BridgeConnection implements BridgeSink {
  private authenticated = false
  private authenticationSettled = false
  private closed = false
  /**
   * Set the moment c2s.device.revoke tears this device down. `ws.close()` is
   * asynchronous, so frames that arrive while the 4401 close is in flight must
   * already be refused — a revoked device may not keep driving the bridge.
   */
  private revoked = false
  private helloTimer: NodeJS.Timeout | undefined
  private readonly openSessions = new Set<string>()
  /**
   * Realtime events that arrive while a session's history snapshot is in
   * flight. The wire contract requires tail first; sending these immediately
   * lets the later tail roll the client back over messages it just rendered.
   */
  private readonly openingSessionEvents = new Map<string, Array<{
    type: string
    payload: unknown
    seq?: number
  }>>()
  /** Sanitized device identity from hello; needed for push registration. */
  private deviceId: string | undefined
  private scopes = new Set<DeviceScope>()
  private widgetClient = false
  private liveActivityRegistrationGeneration = 0
  private pendingLiveActivityId?: string
  private readonly authChallenge: AuthChallenge

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: ConnectionStateDeps,
  ) {
    this.authChallenge = createAuthChallenge(deps.audience)
    ws.on('message', (data) => {
      void this.onMessage(String(data)).catch((error) => {
        // A frame must never take down the host process: fail only this
        // socket. Protocol-shape mistakes are handled inside onMessage; this
        // is the last line of defense for unexpected handler errors.
        if (this.deps.debug === true) this.deps.log('frame handler failed: ' + String(error))
        if (this.closed) return
        this.terminate()
      })
    })
    ws.on('close', () => {
      this.onClose()
      deps.onClosed?.(this)
    })
    ws.on('error', () => {
      /* close follows */
    })
    this.helloTimer = setTimeout(() => {
      if (!this.authenticated) {
        this.settleAuthentication(false, 'timeout')
        this.close(4402, 'auth timeout')
      }
    }, AUTH_TIMEOUT_MS)
    this.helloTimer.unref()
    this.send('s2c.auth.challenge', this.authChallenge)
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

  get suppressesAlertPush(): boolean { return !this.widgetClient }

  // ---------- BridgeSink ----------

  /** S→C permission gate consulted by the bridge for every broadcast/replay
   *  frame: a device only receives what its scopes grant (R1/P2). */
  canReceive(scope: DeviceScope): boolean {
    return this.scopes.has(scope)
  }

  push(type: string, payload: unknown, seq?: number): void {
    if (type === 's2c.notify') payload = { ...(payload as object), hostAudience: this.deps.audience }
    if (type === 's2c.session.event') {
      const sessionId = (payload as { sessionId?: unknown } | undefined)?.sessionId
      if (typeof sessionId === 'string') {
        const buffered = this.openingSessionEvents.get(sessionId)
        if (buffered) {
          buffered.push({ type, payload, ...(seq !== undefined ? { seq } : {}) })
          return
        }
      }
    }
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
    if (!this.authenticationSettled) this.settleAuthentication(false, 'closed')
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    for (const id of this.openSessions) {
      this.deps.bridge.markSinkClosed(this, id)
    }
    this.openSessions.clear()
    this.openingSessionEvents.clear()
    this.deps.bridge.dropSinkSessions(this)
    if (this.authenticated) this.deps.bridge.removeSink(this)
  }

  private settleAuthentication(ok: boolean, reason: 'success' | 'invalid-proof' | 'timeout' | 'closed'): void {
    if (this.authenticationSettled) return
    this.authenticationSettled = true
    this.deps.onAuthenticationSettled?.(ok, reason)
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

  private fail(id: string | undefined, code: WireErrorCode, message: string): void {
    this.send('s2c.error', { code, message }, id)
  }

  // ---------- dispatch ----------

  private lastActivity = Date.now()

  /** True when no inbound frame arrived within maxIdleMs. */
  isStale(now: number, maxIdleMs: number): boolean {
    return now - this.lastActivity > maxIdleMs
  }

  /**
   * 每帧一次的 facade：把当前帧的 id 绑进 send/fail，handler 不必传 id；
   * 连接自身状态以少量操作暴露，所有权仍在这里。
   */
  private frameContext(env: Envelope): FrameContext {
    // 对象字面量的 getter 里 this 指向字面量本身，因此用闭包捕获连接。
    const self = this
    return {
      frame: env,
      deviceId: this.deviceId,
      widgetClient: this.widgetClient,
      bridge: this.deps.bridge,
      devices: this.deps.devices,
      debug: this.deps.debug === true,
      log: (message) => this.deps.log(message),
      // BridgeSink：帧处理器可以把上下文直接当作 sink 传给 HostBridge。
      canReceive: (scope) => this.canReceive(scope),
      push: (type, payload, seq) => this.push(type, payload, seq),
      lastCursor: () => this.lastCursor(),
      replay: (entries) => this.replay(entries),
      replayDone: () => this.replayDone(),
      resync: () => this.resync(),
      send: (type: S2CType, payload) => this.send(type, payload, env.id),
      fail: (code, message) => this.fail(env.id, code, message),
      close: (code, reason) => this.close(code, reason),
      bufferOpenEvents: (sessionId) => {
        const frames: OpenEventBuffer['frames'] = []
        const buffer: OpenEventBuffer = { frames }
        this.openingSessionEvents.set(sessionId, frames)
        return buffer
      },
      discardOpenBuffer: (sessionId, buffer) => {
        if (this.openingSessionEvents.get(sessionId) === buffer.frames) {
          this.openingSessionEvents.delete(sessionId)
        }
      },
      flushOpenBuffer: (sessionId, buffer) => {
        if (this.openingSessionEvents.get(sessionId) !== buffer.frames) return false
        this.openSessions.add(sessionId)
        this.deps.bridge.markSinkOpen(this, sessionId)
        this.openingSessionEvents.delete(sessionId)
        for (const frame of buffer.frames) this.push(frame.type, frame.payload, frame.seq)
        return true
      },
      closeOpenSession: (sessionId) => {
        this.openingSessionEvents.delete(sessionId)
        this.openSessions.delete(sessionId)
        this.deps.bridge.markSinkClosed(this, sessionId)
      },
      nextLiveActivityGeneration: () => {
        this.liveActivityRegistrationGeneration += 1
        return this.liveActivityRegistrationGeneration
      },
      get liveActivityGeneration() {
        return self.liveActivityRegistrationGeneration
      },
      get pendingLiveActivityId() {
        return self.pendingLiveActivityId
      },
      setPendingLiveActivityId: (activityId) => {
        this.pendingLiveActivityId = activityId
      },
      markRevoked: () => {
        this.revoked = true
      },
      prove: () => this.prove(env),
      enrollPushKey: (enrollKey) => this.deps.onPushEnrollKey?.(enrollKey),
      revokeSiblings: (deviceId) => this.deps.onDeviceRevoke?.(deviceId, this),
    }
  }

  private async onMessage(raw: string): Promise<void> {
    this.lastActivity = Date.now()
    // A revoked device is mid-close: swallow everything until the socket
    // goes away instead of answering a device that no longer exists.
    if (this.revoked) return
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
      const parsed: unknown = JSON.parse(raw)
      if (!isEnvelope(parsed)) {
        this.fail(undefined, 'E_PROTOCOL', 'malformed frame')
        return
      }
      env = parsed
    } catch {
      this.fail(undefined, 'E_PROTOCOL', 'frame is not valid JSON')
      return
    }
    if (env.v !== PROTOCOL_VERSION) {
      this.fail(env.id, 'E_UNSUPPORTED', 'unsupported protocol version')
      this.close(4500, 'protocol version mismatch')
      return
    }

    // Anonymous peers get one answer for every non-control frame: telling them
    // which names happen to be registered would leak the frame inventory.
    if (!this.authenticated) {
      const control = registryRowFor(env.type)
      if (control === undefined || control.stage !== 'pre-auth') {
        this.fail(env.id, 'E_PROTOCOL', 'authenticate first')
        return
      }
      await dispatchFrame(control, this.frameContext(env), {})
      return
    }

    const row = registryRowFor(env.type)
    // Widget read-only gate comes first and covers unknown types too: a
    // short-lived panel connection may only send allowed rows, and anything
    // else reads as "read-only" rather than revealing the frame inventory.
    if (this.widgetClient && (row === undefined || widgetPolicyOf(row) === 'deny')) {
      return this.fail(env.id, 'E_FORBIDDEN', 'widget connection is read-only')
    }
    // Unknown type answers E_PROTOCOL directly (G6). Falling back to a scope
    // lookup first made a device without sessions.read hear "permission
    // denied" about a frame that does not exist.
    if (row === undefined) {
      this.fail(env.id, 'E_PROTOCOL', 'unknown type: ' + env.type)
      return
    }
    const scope = scopeRejection(row, this.scopes)
    if (scope !== undefined) return this.fail(env.id, scope.code, scope.message)
    // Validation precedes the capability gate, matching the pre-refactor order
    // where payload shape was checked before the handler looked at capabilities.
    const validated = validatePayload(row, env.payload)
    if (!validated.ok) return this.fail(env.id, validated.code, validated.message)
    const capability = capabilityRejection(row, this.deps.bridge.capabilities)
    if (capability !== undefined) return this.fail(env.id, capability.code, capability.message)

    await dispatchFrame(row, this.frameContext(env), validated.value)
  }

  private async prove(env: Envelope): Promise<void> {
    // A socket that just self-revoked is closing; it may not authenticate
    // again (the registry tombstone would refuse it anyway).
    if (this.revoked) return
    const p = (env.payload ?? {}) as Partial<AuthProofPayload>
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
    const challenge = this.authChallenge
    const record = this.deps.devices.authorized(deviceId)
    const resumeCursor = typeof p.resumeCursor === 'number' && Number.isInteger(p.resumeCursor) && p.resumeCursor >= 0
      ? p.resumeCursor
      : undefined
    const challengeMatches = p.nonce === challenge.nonce &&
      p.audience === challenge.audience &&
      p.issuedAt === challenge.issuedAt &&
      p.expiresAt === challenge.expiresAt &&
      Date.now() <= challenge.expiresAt
    const proofValid = record?.publicKey !== undefined && typeof p.signature === 'string' && challengeMatches &&
      verifyAuthProof(record.publicKey, {
        deviceId,
        deviceName,
        appVersion,
        resumeCursor,
        ...challenge,
      }, p.signature)
    if (!proofValid || record === undefined) {
      this.fail(env.id, 'E_AUTH', 'device proof missing or invalid')
      this.settleAuthentication(false, 'invalid-proof')
      this.close(4401, 'invalid device proof')
      return
    }
    this.settleAuthentication(true, 'success')
    this.authenticated = true
    this.deviceId = deviceId
    this.widgetClient = p.clientRole === 'widget'
    this.scopes = new Set(record.scopes ?? [])
    if (this.helloTimer !== undefined) clearTimeout(this.helloTimer)
    if (!this.widgetClient) this.deps.devices.markAuthenticated(deviceId, deviceName, appVersion, Date.now())
    this.deps.onDeviceAuthenticated?.(deviceId)

    const cursor = this.widgetClient ? undefined : resumeCursor
    // Each replayed business frame is authorized separately by HostBridge.
    const canResume = cursor !== undefined && this.deps.bridge.canResumeFrom(cursor)
    // Welcome strictly precedes any replayed pushes.
    this.send('s2c.welcome', {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.deps.serverVersion,
      deviceId,
      scopes: [...this.scopes],
      capabilities: this.deps.bridge.capabilities,
      cursor: this.deps.bridge.currentCursor(),
      resumed: canResume,
    }, env.id)
    if (!this.widgetClient) this.deps.bridge.addSink(this)
    if (cursor !== undefined) {
      if (canResume) {
        this.deps.bridge.resumeFrom(cursor, this)
      } else {
        this.resync()
      }
    }
  }
}
