import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import { BridgeConnection } from './connection.ts'
import { PushGateway } from './push-gateway.ts'
import { createLocalTransport, createRemoteTransport } from './transport-reconciler.ts'
import { ConnectionGate } from './connection-gate.ts'
import { HostBridge } from './host-bridge.ts'
import { DshApiProxy, type DshInteractionKind } from './dsh-api-proxy.ts'
import { applyReportRemote } from './report-remote.ts'
import type { DeepPilotReport } from './report-wire.ts'
import { DeviceStore, MAX_DEVICES, bridgeDataDir, deviceDisplayName, ensurePrivateBridgeDataDir, expandHome, migrateLegacyBridgeDataDir } from './token.ts'
import type { ApnsEnvironment } from './token.ts'
import {
  PairingCodeManager,
  deviceIdForPublicKey,
  loadOrCreateHostAudience,
  normalizeDeviceScopes,
} from './device-auth.ts'
import type { RemoteStatus } from './remote-supervisor.ts'
import { localLANIPv4Addresses } from './local-address.ts'
import { UpdateChecker, type UpdateInfo } from './update-check.ts'
import { normalizeOptions } from './config.ts'
import type { Config } from './config.ts'
import { rejectUpgrade, requestClientIdentity } from './phone-http.ts'
import { AuthRateLimiter } from './auth-rate-limit.ts'
import { MAX_APP_VERSION_CHARS, MAX_DEVICE_NAME_CHARS, sanitizeDeviceField } from './connection-policy.ts'
import { localEndpointURLs } from './local-policy.ts'
import { closeServer, createPhoneServer, listen } from './phone-server.ts'
import { loadOrCreateLanTlsIdentity, type LanTlsIdentity } from './lan-tls.ts'

/**
 * dsh-deeppilot — data bridge between the DSH host and DeepPilot
 * clients. Owns independent, narrowly routed LAN (TLS-only, pinned by paired
 * devices) and loopback Funnel-origin listeners. The web UI and the rest of
 * DSH's API are never exposed by these listeners.
 *
 * Data plane: an in-process HostBridge consumes a local adapter over DSH
 * Session/Workspace controllers, mirrors session summaries,
 * tracks pending approvals/questions, and fans projected protocol-v2 pushes
 * out to every connected device.
 *
 * Protocol: PROTOCOL.md is normative; src/protocol.ts and the private app's
 * Swift models mirror that v2 contract.
 */

export const name = 'deeppilot'

export { HostBridge } from './host-bridge.ts'
export { Config } from './config.ts'
export { mayReceivePush, shouldPrunePushToken, shouldReEnrollRelayToken } from './push-policy.ts'

/** No web-service requirement: the plugin owns its own transport listeners. */
export const inject: string[] = []

type SubContext = {
  effect: (setup: () => unknown, name?: string) => unknown
}

const SERVER_VERSION = readOwnPackageVersion()
const MAX_CLIENT_CONNECTIONS = 16
/**
 * Single-frame bound. Covers the protocol maximum (4 × 8 MB base64 images
 * plus prompt text) with headroom while keeping an unauthenticated client's
 * pre-hello buffering far below ws's 100 MiB default.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/**
 * Resolve the host plugin's own version from the installed package.json.
 * Sourced at boot so the wire / UI always agrees with what npm published.
 * `createRequire(import.meta.url)` is the tsdown-bundled ESM equivalent of
 * CommonJS's `require`; the package.json sits next to lib/index.js after
 * the build, so `../package.json` resolves to the published manifest.
 */
function readOwnPackageVersion(): string {
  try {
    const require_ = createRequire(import.meta.url)
    const pkg = require_('../package.json') as { version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
  } catch {
    // fall through to env / hardcoded default below
  }
  // `npm` injects this for `npm run` / `npm exec` / `npm start` invocations.
  // `process.env.npm_package_version` is unset when DSH loads the plugin
  // directly, so we keep it as a secondary source rather than the truth.
  const envVersion = process.env.npm_package_version
  if (typeof envVersion === 'string' && envVersion.length > 0) return envVersion
  return '0.0.0+unknown'
}

export function apply(ctx: Context, options: unknown): void {
  const cfg = normalizeOptions(options)

  const log = (message: string): void => {
    console.log('[deeppilot] ' + message)
  }
  const auditSalt = randomBytes(32)
  const auditLabel = (value: string): string => createHash('sha256')
    .update(auditSalt)
    .update(value)
    .digest('hex')
    .slice(0, 12)

  let scheduleRemoteReconcile: (() => void) | undefined
  let scheduleLocalReconcile: (() => void) | undefined
  const currentConfig = (): Config => normalizeOptions(options)
  const enabledNow = (): boolean => currentConfig().enabled === true

  // rc.2 commits volatile config edits into live refs and emits on the owning
  // fiber. Reconcile transport listeners after the new values are published.
  ;(ctx as unknown as { on: (name: string, listener: () => void) => void }).on(
    'loader/volatile-update',
    () => queueMicrotask(() => {
      scheduleLocalReconcile?.()
      scheduleRemoteReconcile?.()
    }),
  )

  // Master switch, resolved against the current profile entry.
  // Individual injected services also read currentConfig() when they activate.
  if (currentConfig().enabled !== true) {
    log('disabled via settings; bridge stays inactive (rumors of /phone below are skipped)')
  }

  // Resolved asynchronously; route handlers await readiness. Never rejects:
  // a storage failure degrades the bridge instead of killing the host.
  const dataDir = bridgeDataDir()

  // ---------- offline push (F-9) ----------

  // 推送的全部行为住在 PushGateway：enrollment 与持久化、中继注册、sender
  // 缓存与退避、两个 scheduler、PushOutlet 四方法、两个自测。这里只声明它并
  // 注入依赖——apply() 不再持有任何推送状态。详见 src/push-gateway.ts 文件头。
  const pushGateway = new PushGateway({
    config: currentConfig,
    dataDir,
    devices: () => auth.devices,
    audience: () => auth.audience,
    connections: () => connections,
    enabledNow,
    log,
  })

  const pairingCodes = new PairingCodeManager()
  const auth: { audience: string | null; devices: DeviceStore | null } = {
    audience: null,
    devices: null,
  }
  const ready = (async () => {
    try {
      try {
        const migratedFrom = await migrateLegacyBridgeDataDir()
        if (migratedFrom !== null) log(`migrated legacy plugin state from ${migratedFrom} to ${dataDir}`)
      } catch (error) {
        log('legacy plugin-state migration skipped: ' + String(error))
      }
      await ensurePrivateBridgeDataDir()
      auth.audience = await loadOrCreateHostAudience(join(dataDir, 'host-id'))
      auth.devices = await DeviceStore.load(cfg.devicesPath ?? join(dataDir, 'devices-v2.json'))
      {
        // Startup visibility: makes "registrations vanished after restart"
        // instantly diagnosable (0 push rows ⇒ the file itself lost data).
        const rows = auth.devices.list()
        const registered = rows.filter((row) => row.apns !== undefined).length
        log(`device registry loaded from ${expandHome(cfg.devicesPath ?? join(dataDir, 'devices-v2.json'))}: ${rows.length} device(s), ${registered} push registration(s)`)
      }
      // Restore zero-touch push enrollment state (best effort).
      await pushGateway.restore()
    } catch (error) {
      const message = String(error)
      log('auth material unavailable, bridge degraded: ' + message)
      return { audience: null, devices: null }
    }
    return { audience: auth.audience, devices: auth.devices }
  })()

  const beginPairing = async (): Promise<{ code: string; expiresAt: number; audience: string }> => {
    await ready
    if (auth.audience === null || auth.devices === null) throw new Error('device authentication unavailable')
    return { ...pairingCodes.issue(), audience: auth.audience }
  }

  /**
   * Settings-page push self-test: force one synthetic notification down the
   * active pathway to EVERY registered device, deliberately ignoring the
   * connected-skip and category-mute filters — an explicit user action must
   * always be able to prove delivery end to end.
   */
  const connections = new Set<BridgeConnection>()

  const closeConnectionsForBridge = (bridge: HostBridge): void => {
    for (const connection of connections) {
      if (!connection.isAttachedTo(bridge)) continue
      connection.closeForServerStop()
      connections.delete(connection)
    }
  }

  const closeAllConnections = (): void => {
    for (const connection of connections) connection.closeForServerStop()
    connections.clear()
  }

  /**
   * Unbind one device. Single path shared by the settings page (report-service
   * revokeDevice) and the wire-level c2s.device.revoke frame: mark the registry
   * tombstone (which also drops every APNs/WidgetKit/LiveActivity token, so the
   * push fan-out can no longer select it) and hard-drop its live sockets.
   * `except` is the connection that sent the revoke frame — it closes itself
   * with 4401 after acking, so it is not terminated here.
   */
  const revokeDevice = async (deviceId: string, except?: BridgeConnection): Promise<boolean> => {
    const { devices } = await ready
    if (!devices) throw new Error('device registry unavailable')
    const revoked = devices.revoke(deviceId, Date.now())
    if (revoked) {
      for (const connection of [...connections]) {
        if (connection === except || connection.connectedDeviceId !== deviceId) continue
        connection.terminate()
        connections.delete(connection)
      }
      log(`device revoked id=${auditLabel(deviceId)}`)
    }
    return revoked
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  // The LAN TLS identity is loaded once per plugin lifetime: port or enable
  // toggles reuse it so paired devices keep their pin. `tlsIdentityRegenerated`
  // stays raised for the settings page until the next restart because it
  // means every previously paired LAN device must pair again. 身份留在
  // apply()——它被 listener 启动、配对回显与 report 三处消费，协调器不懂 TLS。
  let lanTlsIdentity: Promise<LanTlsIdentity> | undefined
  let tlsIdentityRegenerated = false
  const loadLanTls = (): Promise<LanTlsIdentity> => {
    lanTlsIdentity ??= (async () => {
      await ready
      const identity = await loadOrCreateLanTlsIdentity(join(dataDir, 'lan-tls'))
      if (identity.regenerated) {
        tlsIdentityRegenerated = true
        log(`LAN TLS identity created: fingerprint=${identity.fingerprint}; previously paired LAN devices must pair again`)
      } else if (identity.resigned) {
        log(`LAN TLS certificate renewed (fingerprint unchanged: ${identity.fingerprint})`)
      }
      return identity
    })()
    // A failed load (disk error) must not poison later reconciles.
    lanTlsIdentity.catch(() => { lanTlsIdentity = undefined })
    return lanTlsIdentity
  }

  const updateChecker = new UpdateChecker({ log, currentVersion: SERVER_VERSION })
  updateChecker.scheduleInitial()
  const updateInfo = (): UpdateInfo => updateChecker.get()

  // Typert Remote for the web settings page (deeppilot/report).
  applyReportRemote(ctx, async () => {
    let pairingReady = false
    let devices: Array<{
      deviceId: string; deviceName: string; customName?: string; appVersion: string; firstSeenTs: number; lastSeenTs: number
      fingerprint: string; scopes: ReturnType<typeof normalizeDeviceScopes>; revokedAt?: number
      apns?: { environment: 'development' | 'production'; updatedAt: number }
    }> = []
    try {
      await ready
      pairingReady = auth.audience !== null && auth.devices !== null
      // Strip the raw APNs token at the source; the report carries only the
      // registration fact (environment + freshness).
      devices = (auth.devices?.list() ?? [])
        .filter((device) => device.publicKey !== undefined && device.fingerprint !== undefined)
        .map(({ deviceId, deviceName, customName, appVersion, firstSeenTs, lastSeenTs, fingerprint, scopes, revokedAt, apns }) => ({
        deviceId,
        deviceName: deviceDisplayName({ deviceName, customName }),
        ...(customName ? { customName } : {}),
        appVersion,
        firstSeenTs,
        lastSeenTs,
        fingerprint: fingerprint!,
        scopes: normalizeDeviceScopes(scopes),
        ...(revokedAt !== undefined ? { revokedAt } : {}),
        ...(apns ? { apns: { environment: apns.environment, updatedAt: apns.updatedAt } } : {}),
      }))
    } catch {
      // degraded: report the minimum without token facts
    }
    const update = updateInfo()
    const lanAddresses = localLANIPv4Addresses()
    return {
      protocolVersion: 2,
      serverVersion: SERVER_VERSION,
      pluginVersion: update.currentVersion,
      ...(update.available ? { updateAvailable: true } : {}),
      ...(update.releaseUrl !== null ? { releaseUrl: update.releaseUrl } : {}),
      enabled: currentConfig().enabled === true,
      identityPath: expandHome(currentConfig().devicesPath ?? join(bridgeDataDir(), 'devices-v2.json')),
      pairingReady,
      activeConnections: connections.size,
      historyBufferMax: currentConfig().historyBufferMax ?? 2000,
      lanAddresses,
      local: localStatus(lanAddresses),
      remote: remoteStatus(),
      devices,
    }
  }, beginPairing, async (deviceId) => {
    // Settings-page revocation shares the exact path used by the wire-level
    // c2s.device.revoke frame (index.ts revokeDevice helper).
    return await revokeDevice(deviceId)
  }, async (deviceId, customName) => {
    const { devices } = await ready
    if (!devices) throw new Error('device registry unavailable')
    const effectiveName = await devices.setCustomName(deviceId, customName)
    if (effectiveName === null) throw new Error('active device not found')
    const normalized = customName === null ? '' : sanitizeDeviceField(customName, MAX_DEVICE_NAME_CHARS)
    log(`device custom name updated id=${auditLabel(deviceId)} custom=${String(normalized.length > 0)}`)
    return normalized === '' ? null : normalized
  }, async (deviceId, scopes) => {
    const { devices } = await ready
    if (!devices) throw new Error('device registry unavailable')
    const updated = devices.setScopes(deviceId, scopes)
    if (updated === null) throw new Error('active device not found')
    // Scope changes take effect on the next signed connection; disconnect the
    // current socket so stale in-memory authority cannot survive the update.
    for (const connection of [...connections]) {
      if (connection.connectedDeviceId !== deviceId) continue
      connection.terminate()
      connections.delete(connection)
    }
    log(`device scopes updated id=${auditLabel(deviceId)} scopes=${updated.join(',')}`)
    return updated
  }, () => pushGateway.relayTest(), () => pushGateway.selfTest())
  const state: { bridge?: HostBridge } = {}
  let pendingUpgrades = 0
  const authRateLimiter = new AuthRateLimiter()

  const readJSONBody = async (req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) throw new Error('request body too large')
      chunks.push(buffer)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }

  const handlePair = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Content-Type', 'application/json')
    if (!enabledNow()) {
      res.statusCode = 503
      res.end(JSON.stringify({ ok: false, error: 'bridge disabled' }))
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST')
      res.end(JSON.stringify({ ok: false, error: 'POST required' }))
      return
    }
    const source = requestClientIdentity(req)
    const admission = authRateLimiter.admit(source)
    if (!admission.ok) {
      res.statusCode = 429
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(admission.retryAfterMs / 1_000))))
      res.end(JSON.stringify({ ok: false, error: 'pairing rate limited' }))
      return
    }
    try {
      const { devices, audience } = await ready
      if (!devices || !audience) throw new Error('device authentication unavailable')
      const raw = await readJSONBody(req) as Record<string, unknown>
      if (raw === null || typeof raw !== 'object' || raw.v !== 2) throw new TypeError('protocol v2 required')
      const code = typeof raw.code === 'string' ? raw.code : ''
      const publicKey = typeof raw.publicKey === 'string' ? raw.publicKey : ''
      const deviceName = sanitizeDeviceField(raw.deviceName, MAX_DEVICE_NAME_CHARS) || 'unknown'
      const appVersion = sanitizeDeviceField(raw.appVersion, MAX_APP_VERSION_CHARS) || 'unknown'
      const deviceId = deviceIdForPublicKey(publicKey)
      if (devices.list().length >= MAX_DEVICES && devices.authorized(deviceId) === undefined) {
        res.statusCode = 409
        res.end(JSON.stringify({ ok: false, error: 'device registry is full' }))
        return
      }
      if (!pairingCodes.consume(code)) {
        const failure = authRateLimiter.recordFailure(source)
        res.statusCode = failure.blocked ? 429 : 401
        if (failure.retryAfterMs > 0) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(failure.retryAfterMs / 1_000))))
        res.end(JSON.stringify({ ok: false, error: failure.blocked ? 'pairing rate limited' : 'pairing code invalid or expired' }))
        return
      }
      const record = devices.register({
        publicKey,
        deviceName,
        appVersion,
        scopes: normalizeDeviceScopes(raw.scopes),
      }, Date.now())
      authRateLimiter.recordSuccess(source)
      log(`device paired id=${auditLabel(record.deviceId)} source=${auditLabel(source)}`)
      // Only a request that arrived over the LAN TLS listener echoes the pin;
      // Funnel pairings terminate TLS at tailscaled with a public CA cert.
      const overLanTls = (req.socket as { encrypted?: boolean }).encrypted === true
      const tlsFingerprint = overLanTls ? (await lanTlsIdentity)?.fingerprint : undefined
      res.statusCode = 201
      res.end(JSON.stringify({
        ok: true,
        v: 2,
        deviceId: record.deviceId,
        audience,
        scopes: record.scopes ?? [],
        ...(tlsFingerprint ? { tlsFingerprint } : {}),
      }))
    } catch (error) {
      res.statusCode = error instanceof SyntaxError || error instanceof TypeError ? 400 : 503
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'pairing failed' }))
    } finally {
      admission.release()
    }
  }

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      try {
        if (!enabledNow()) {
          rejectUpgrade(socket, 503, 'bridge disabled')
          return
        }
        if (connections.size + pendingUpgrades >= MAX_CLIENT_CONNECTIONS) {
          rejectUpgrade(socket, 429, 'too many connections')
          return
        }
        pendingUpgrades += 1
        // 声明在 try 之外：finally 需要归还一个可能未创建成功的门的名额。
        let gate: ConnectionGate | undefined
        try {
          const { devices, audience } = await ready
          if (!audience || !devices) {
            rejectUpgrade(socket, 503, 'bridge degraded')
            return
          }
          const bridge = state.bridge
          if (!bridge) {
            rejectUpgrade(socket, 503, 'bridge not ready')
            return
          }
          // The gate is created before the ws exists, so the admission slot is
          // held even when the upgrade callback never runs (socket gone
          // mid-upgrade). Its attach timeout covers that case; once the socket
          // is live, the gate's hello deadline takes over.
          gate = new ConnectionGate({
            source: requestClientIdentity(req),
            devices,
            audience,
            limiter: authRateLimiter,
            log,
            auditLabel,
          })
          if (!gate.admitted) {
            rejectUpgrade(socket, 429, 'authentication rate limited')
            return
          }
          const live = gate
          wss.handleUpgrade(req, socket, head, (ws) => {
            if (auth.audience !== audience || state.bridge !== bridge) {
              live.markDead()
              ws.close(1012, 'bridge changed')
              return
            }
            try {
              const connection = new BridgeConnection(ws, {
                bridge,
                devices,
                serverVersion: SERVER_VERSION,
                audience,
                log,
                debug: currentConfig().diagnostics?.debug === true,
                source: live.source,
                rateLimiter: authRateLimiter,
                auditLabel,
                onClosed: (closed) => connections.delete(closed),
                onDeviceAuthenticated: (deviceId) => {
                  log(`device authenticated id=${auditLabel(deviceId)} source=${auditLabel(live.source)}`)
                },
                onPushEnrollKey: (enrollKey) => pushGateway.enrollKey(enrollKey),
                // A device that unbinds itself from the app must not leave a
                // second socket (e.g. an older install) still live: the
                // registry tombstone is already written by the handler, so
                // this only drops the sibling sockets.
                onDeviceRevoke: (deviceId, except) => revokeDevice(deviceId, except),
              }, live)
              connections.add(connection)
            } catch (error) {
              live.markDead()
              ws.close(1011, 'connection setup failed')
              throw error
            }
          })
        } finally {
          // The attach window ends here: if no socket was produced (the upgrade
          // callback never ran), the slot goes back immediately instead of
          // waiting for the attach timeout. An attached gate keeps its slot
          // until a settle path or its hello deadline.
          gate?.releaseIfNeverAttached()
          pendingUpgrades -= 1
        }
      } catch (error) {
        log('upgrade failed: ' + String(error))
        rejectUpgrade(socket, 500, 'internal error')
      }
    })()
  }

  const handleHealth = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await ready
      res.setHeader('Content-Type', 'application/json')
      if (!auth.audience || !auth.devices) {
        res.statusCode = 503
        res.end(JSON.stringify({ ok: false, degraded: true }))
        return
      }
      res.statusCode = 200
      res.end(JSON.stringify({
        ok: true,
        enabled: enabledNow(),
        protocolVersion: 2,
        serverVersion: SERVER_VERSION,
        dataPlane: Boolean(state.bridge),
      }))
    } catch {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false }))
    }
  }

  const phoneHandlers = {
    health: handleHealth,
    pair: handlePair,
    upgrade: handleUpgrade,
  }

  // Independent transport listeners. LAN owns a stable configurable port;
  // Funnel keeps its loopback-only ephemeral origin. They share only the
  // narrow handlers above, so a LAN bind failure cannot take remote access
  // down and neither listener exposes DSH's wider web/API surface.
  //
  // 差分、串行、拆除与状态发布的公共协议住在 TransportReconciler；两个传输
  // 各自的差异（skipWhenDisabled / appliedKey 时机 / 错误分支）在
  // createLocalTransport 与 createRemoteTransport 里显式声明并原样保留——
  // 统一它们会改变一条当前稳定路径上的并发语义，属于单独一轮的决策。
  const localTransport = createLocalTransport({
    handlers: phoneHandlers,
    config: currentConfig,
    tls: loadLanTls,
    log,
  })
  const remoteTransport = createRemoteTransport({
    handlers: phoneHandlers,
    config: currentConfig,
    originURL: () => originURL,
    dataDir,
    log,
  })
  const localStatus = (addresses: readonly string[]): DeepPilotReport['local'] => {
    const state = localTransport.status()
    return {
      ...state,
      endpoints: state.phase === 'online' ? localEndpointURLs(addresses, state.port) : [],
      ...(tlsIdentityRegenerated ? { tlsIdentityRegenerated: true } : {}),
    }
  }
  const remoteStatus = (): RemoteStatus => remoteTransport.status()

  const originServer = createPhoneServer(phoneHandlers)
  let originURL: string | undefined
  scheduleLocalReconcile = () => localTransport.scheduleReconcile()
  scheduleRemoteReconcile = () => remoteTransport.scheduleReconcile()

  ;(ctx as unknown as SubContext).effect(() => {
    scheduleLocalReconcile?.()
    void listen(originServer, 0, '127.0.0.1').then(() => {
      const address = originServer.address()
      if (address && typeof address === 'object') {
        originURL = `http://127.0.0.1:${address.port}`
        scheduleRemoteReconcile?.()
      }
    }, (error: unknown) => log('remote origin failed: ' + String(error)))
    return async () => {
      scheduleLocalReconcile = undefined
      scheduleRemoteReconcile = undefined
      await Promise.allSettled([
        closeServer(originServer),
        localTransport.dispose(),
        remoteTransport.dispose(),
      ])
    }
  }, 'deeppilot: independent transports')

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const connection of connections) {
      if (connection.isStale(now, 60_000)) {
        log('dropping stale connection')
        connection.closeIdle()
        connections.delete(connection)
      }
    }
  }, 30_000)
  ;(ctx as unknown as SubContext).effect(() => () => clearInterval(sweep), 'deeppilot: stale sweep')

  // Build the bridge's stable protocol-facing adapter from the public
  // Session/Workspace controllers.

  /**
   * Whether the resident Gateway Client represents a real phone surface. A
   * paired device remains answerable even while offline: HostBridge retains an
   * authoritative pending snapshot that the app pulls on reconnect, while
   * APNs is only a best-effort wakeup. With no paired device this Client calls
   * `next()`; Gateway's independent official Web delivery is unaffected.
   */
  const hasPairedPhoneSurface = (_kind: DshInteractionKind): boolean => {
    const devices = auth.devices?.list() ?? []
    return devices.some((device) => device.revokedAt === undefined)
  }

  ;(ctx as unknown as { inject: (deps: string[], fn: (sub: unknown) => void) => void }).inject(
    ['sessionController', 'connection', 'typertGateway'],
    (sub) => {
      if (currentConfig().enabled !== true) {
        log('bridge disabled; data plane stays inactive')
        return
      }
      const apiCtx = sub as unknown as Context & SubContext
      let proxy: DshApiProxy
      try {
        proxy = new DshApiProxy(apiCtx, { shouldSurfaceInteraction: hasPairedPhoneSurface })
      } catch (error) {
        log('DSH session bridge unavailable: ' + String(error))
        return
      }
      const bridge = new HostBridge(
        proxy,
        cfg.historyBufferMax,
        join(dataDir, 'prompt-deliveries-v1.json'),
        join(dataDir, 'schedule-mutations-v1.json'),
        join(dataDir, 'fork-mutations-v1.json'),
        log,
      )
      bridge.setPushOutlet(pushGateway)
      state.bridge = bridge
      bridge.start()
      log('data plane active (mux + host streams)')
      apiCtx.effect(() => () => {
        closeConnectionsForBridge(bridge)
        if (state.bridge === bridge) state.bridge = undefined
        bridge.dispose()
      }, 'deeppilot: host streams')
    },
  )

  ;(ctx as unknown as SubContext).effect(() => async () => {
    closeAllConnections()
    const bridge = state.bridge
    state.bridge = undefined
    bridge?.dispose()
    updateChecker.dispose()
    await pushGateway.dispose()
    const wssClosed = new Promise<void>((resolve) => wss.close(() => resolve()))
    await Promise.allSettled([wssClosed])
  }, 'deeppilot: process resources')
}
