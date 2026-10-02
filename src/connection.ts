import type { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from './protocol.ts'
import type { Envelope } from './protocol.ts'
import type { BridgeSink, HostBridge } from './host-bridge.ts'
import type { DeviceStore } from './token.ts'
import type { DeviceScope } from './device-auth.ts'
import { MAX_OUTBOUND_BUFFER_BYTES } from './connection-policy.ts'
import { AuthRateLimiter } from './auth-rate-limit.ts'
import type { WireErrorCode } from './wire-errors.ts'
import { ConnectionGate, type AuthenticatedIdentity, type GateHost } from './connection-gate.ts'
import type { OpenEventBuffer, S2CType } from './wire-registry.ts'

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
  /** 客户端身份，供连接门做限流；缺省时按本地回环源处理。 */
  source?: string
  /** 认证名额与失败记账由连接门持有（见 connection-gate.ts）。 */
  rateLimiter?: AuthRateLimiter
  /** 审计标签函数：把客户端身份变成短哈希供日志使用；缺省时直接用原值。 */
  auditLabel?: (value: string) => string
  /** Called once when the socket closes (cleanly or not). */
  onClosed?: (connection: BridgeConnection) => void
  /**
   * 认证落定通知：纯观测用。名额释放与限流记账已由连接门内部完成，
   * 接入方不再需要据此做任何事；测试用它断言「只落定一次」。
   */
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
 * projected frames and replays.
 *
 * 本模块现在只剩传输与连接自有状态：socket、send/fail/close、背压、idle 计时、
 * welcome 发射、sink 台账、打开中的会话缓冲、Live Activity 代次。帧的规则
 * （pre-auth、认证、授权、分发）全部属于 ConnectionGate；帧的事实属于
 * wire-registry。连接通过实现 GateHost 把这两者接起来。
 */
export class BridgeConnection implements BridgeSink {
  private closed = false
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
  private readonly openSessions = new Set<string>()
  private liveActivityRegistrationGeneration = 0
  private pendingLiveActivityId?: string
  private lastActivity = Date.now()

  /** True when no inbound frame arrived within maxIdleMs. */
  isStale(now: number, maxIdleMs: number): boolean {
    return now - this.lastActivity > maxIdleMs
  }

  /** 认证成功后由门回填，供 welcome 与 sink 注册使用。 */
  private identity: AuthenticatedIdentity | undefined

  /** 帧规则（pre-auth、认证、授权、分发）的属主；由接入方创建并交进来。 */
  readonly gate: ConnectionGate

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: ConnectionStateDeps,
    /** 由接入方预先创建的门（提前占名额以在握手前限流）；缺省时连接自建。 */
    gate: ConnectionGate = new ConnectionGate({
      source: deps.source ?? 'local',
      devices: deps.devices,
      audience: deps.audience,
      limiter: deps.rateLimiter ?? new AuthRateLimiter(),
      log: (message) => deps.log(message),
      ...(deps.auditLabel ? { auditLabel: deps.auditLabel } : {}),
    }),
  ) {
    const connection = this
    const host: GateHost = {
      get bridge() { return connection.deps.bridge },
      get devices() { return connection.deps.devices },
      get debug() { return deps.debug === true },
      log: (message) => deps.log(message),
      send: (type: S2CType, payload, id) => connection.send(type, payload, id),
      fail: (id, code, message) => connection.fail(id, code, message),
      close: (code, reason) => connection.close(code, reason),
      canReceive: (scope) => connection.canReceive(scope),
      push: (type, payload, seq) => connection.push(type, payload, seq),
      lastCursor: () => connection.lastCursor(),
      replay: (entries) => connection.replay(entries),
      replayDone: () => connection.replayDone(),
      resync: () => connection.resync(),
      bufferOpenEvents: (sessionId) => connection.bufferOpenEvents(sessionId),
      discardOpenBuffer: (sessionId, buffer) => connection.discardOpenBuffer(sessionId, buffer),
      flushOpenBuffer: (sessionId, buffer) => connection.flushOpenBuffer(sessionId, buffer),
      closeOpenSession: (sessionId) => connection.closeOpenSession(sessionId),
      nextLiveActivityGeneration: () => {
        connection.liveActivityRegistrationGeneration += 1
        return connection.liveActivityRegistrationGeneration
      },
      get liveActivityGeneration() { return connection.liveActivityRegistrationGeneration },
      get pendingLiveActivityId() { return connection.pendingLiveActivityId },
      setPendingLiveActivityId: (activityId) => { connection.pendingLiveActivityId = activityId },
      markRevoked: () => connection.gate.markRevoked(),
      enrollPushKey: (enrollKey) => deps.onPushEnrollKey?.(enrollKey),
      revokeSiblings: (deviceId) => deps.onDeviceRevoke?.(deviceId, connection),
      onAuthenticated: (identity) => connection.onAuthenticated(identity),
      deviceAuthenticated: (deviceId) => deps.onDeviceAuthenticated?.(deviceId),
      settled: (ok, reason) => deps.onAuthenticationSettled?.(ok, reason),
    }
    this.gate = gate

    ws.on('message', (data) => {
      this.lastActivity = Date.now()
      void gate.handleFrame(String(data)).catch((error) => {
        // A frame must never take down the host process: fail only this
        // socket. Protocol-shape mistakes are handled inside the gate; this
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
    // The challenge goes out the moment the socket is live; the hello deadline
    // is the gate's, so an upgrade that never produced a socket still has the
    // attach timeout to release its admission slot.
    gate.attach(host)
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
    return this.identity?.deviceId
  }

  get suppressesAlertPush(): boolean {
    return this.identity?.widgetClient !== true
  }

  // ---------- BridgeSink ----------

  /** S→C permission gate consulted by the bridge for every broadcast/replay
   *  frame: a device only receives what its scopes grant (R1/P2). */
  canReceive(scope: DeviceScope): boolean {
    return this.identity?.scopes.has(scope) ?? false
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

  /** 认证成功：门只做安全判定，欢迎与重放归连接（数据面）。 */
  private onAuthenticated(identity: AuthenticatedIdentity): void {
    this.identity = identity
    const cursor = identity.resumeCursor
    // Each replayed business frame is authorized separately by HostBridge.
    const canResume = cursor !== undefined && this.deps.bridge.canResumeFrom(cursor)
    // Welcome strictly precedes any replayed pushes.
    this.send('s2c.welcome', {
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: this.deps.serverVersion,
      deviceId: identity.deviceId,
      scopes: [...identity.scopes],
      capabilities: this.deps.bridge.capabilities,
      cursor: this.deps.bridge.currentCursor(),
      resumed: canResume,
    })
    if (!identity.widgetClient) this.deps.bridge.addSink(this)
    if (cursor !== undefined) {
      if (canResume) {
        this.deps.bridge.resumeFrom(cursor, this)
      } else {
        this.resync()
      }
    }
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    // Unsettled sockets (never proven) settle as 'closed' and give back their
    // admission slot; already-settled ones are a no-op inside the gate.
    this.gate.onClose()
    for (const id of this.openSessions) {
      this.deps.bridge.markSinkClosed(this, id)
    }
    this.openSessions.clear()
    this.openingSessionEvents.clear()
    this.deps.bridge.dropSinkSessions(this)
    if (this.identity !== undefined) this.deps.bridge.removeSink(this)
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

  // ---------- connection-owned session bookkeeping ----------

  private bufferOpenEvents(sessionId: string): OpenEventBuffer {
    const frames: OpenEventBuffer['frames'] = []
    const buffer: OpenEventBuffer = { frames }
    this.openingSessionEvents.set(sessionId, frames)
    return buffer
  }

  private discardOpenBuffer(sessionId: string, buffer: OpenEventBuffer): void {
    if (this.openingSessionEvents.get(sessionId) === buffer.frames) {
      this.openingSessionEvents.delete(sessionId)
    }
  }

  private flushOpenBuffer(sessionId: string, buffer: OpenEventBuffer): boolean {
    if (this.openingSessionEvents.get(sessionId) !== buffer.frames) return false
    this.openSessions.add(sessionId)
    this.deps.bridge.markSinkOpen(this, sessionId)
    this.openingSessionEvents.delete(sessionId)
    for (const frame of buffer.frames) this.push(frame.type, frame.payload, frame.seq)
    return true
  }

  private closeOpenSession(sessionId: string): void {
    this.openingSessionEvents.delete(sessionId)
    this.openSessions.delete(sessionId)
    this.deps.bridge.markSinkClosed(this, sessionId)
  }
}

/** 供接入方引用：帧上下文的类型仍由 wire-registry 属主。 */
export type { S2CType }
