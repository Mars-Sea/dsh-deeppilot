import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebSocketServer } from 'ws'
import { BridgeConnection } from './connection.ts'
import { HostBridge } from './host-bridge.ts'
import type { ApiProxyLike, PushOutlet } from './host-bridge.ts'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { applyReportRemote } from './report-remote.ts'
import { runRelayProbe } from './relay-test.ts'
import type { PushTestResult } from './report-wire.ts'
import { DeviceStore, bridgeDataDir, expandHome, loadOrCreateToken, migrateLegacyBridgeDataDir, tokenMatches, writeNewToken } from './token.ts'
import type { ApnsEnvironment } from './token.ts'
import { ApnsClient } from './apns.ts'
import { RelayClient } from './relay-client.ts'
import type { PushNotification } from './protocol.ts'
import {
  DEFAULT_REMOTE_HOSTNAME,
  normalizeRemoteHostname,
  RemoteSupervisor,
  type RemoteStatus,
} from './remote-supervisor.ts'
import { localLANIPv4Addresses } from './local-address.ts'

/**
 * dsh-deeppilot — data bridge between the DSH host and DeepPilot
 * clients. Registers exactly one WebSocket upgrade route (/phone) plus an
 * optional health probe (/phone/health) on the existing web server. The web
 * UI is never touched.
 *
 * Data plane: an in-process HostBridge consumes apiProxy.events.mux()/host()
 * streams, mirrors session summaries, tracks pending approvals/questions,
 * and fans projected protocol-v1 pushes out to every connected device.
 *
 * Protocol: src/protocol.ts, v1. The private app repository carries the
 * matching normative document and Swift models.
 */

export const name = 'deeppilot'

export { HostBridge } from './host-bridge.ts'

/** No eager service requirement: profiles without a web stack simply skip. */
export const inject: string[] = []

export interface Config {
  /** Master switch; when false the plugin activates and does nothing. */
  enabled?: boolean
  /** Pairing token file (0600); generated on first boot when missing. */
  authTokenPath?: string
  /** Paired-device registry JSON path. */
  devicesPath?: string
  /** Replay ring buffer bound (frames) per deployment. */
  historyBufferMax?: number
  /** Verbose per-frame diagnostics (never prints token or message bodies). */
  debug?: boolean
  /** Optional embedded remote transport. Reconciled when settings change. */
  remote?: {
    enabled?: boolean
    provider?: string
    hostname?: string
    statePath?: string
    helperPath?: string
    funnelPort?: number
  }
  /**
   * Offline push (F-9). provider 'apns' sends direct Apple Push Notification
   * deliveries from this Mac — outbound-only, no relay server, requires the
   * user's own Apple developer credentials. provider 'relay' forwards notify
   * projections to an operator-run relay (relay/server.js) holding the
   * distributor's key — used when the App ships via TestFlight/App Store.
   *
   * Deliberately NO environment knob here: each device reports its own
   * environment when registering (derived from its build kind), and
   * deliveries route per device — mixed dev/TestFlight phones coexist.
   */
  push?: {
    /** 'none' (default) | 'apns' | 'relay'. */
    provider?: string
    // --- apns ---
    /** Apple Developer team id (JWT iss claim). */
    teamId?: string
    /** APNs auth key id (JWT kid header). */
    keyId?: string
    /** .p8 private key path; generated keys live under the bridge data dir. */
    keyPath?: string
    /** App bundle id — the apns-topic header. */
    bundleId?: string
    // --- relay ---
    /** Relay base URL (https). See relay/README.md. */
    relayUrl?: string
    /** Per-user bearer token issued by the relay operator. */
    relayToken?: string
  }
}

/** Operator-run relay used by distributed builds; overridable via config. */
const DEFAULT_RELAY_URL = 'https://pilot.hailab.dev'

export const Config = z.object({
  enabled: z.boolean().default(true),
  authTokenPath: z.string().default(join(bridgeDataDir(), 'auth-token')),
  devicesPath: z.string().default(join(bridgeDataDir(), 'devices.json')),
  historyBufferMax: z.natural().min(100).default(2000),
  debug: z.boolean().default(false),
  remote: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default('tailscale-funnel'),
    hostname: z.string().default(DEFAULT_REMOTE_HOSTNAME),
    statePath: z.string().default(join(bridgeDataDir(), 'tailscale')),
    helperPath: z.string().default(''),
    funnelPort: z.natural().default(443),
  }).default({
    enabled: false,
    provider: 'tailscale-funnel',
    hostname: DEFAULT_REMOTE_HOSTNAME,
    statePath: join(bridgeDataDir(), 'tailscale'),
    helperPath: '',
    funnelPort: 443,
  }),
  push: z.object({
    provider: z.string().default('none'),
    teamId: z.string().default(''),
    keyId: z.string().default(''),
    keyPath: z.string().default(join(bridgeDataDir(), 'apns', 'AuthKey.p8')),
    bundleId: z.string().default('dev.hailab.deeppilot'),
    relayUrl: z.string().default(DEFAULT_RELAY_URL),
    relayToken: z.string().default(''),
  }).default({
    provider: 'none',
    teamId: '',
    keyId: '',
    keyPath: join(bridgeDataDir(), 'apns', 'AuthKey.p8'),
    bundleId: 'dev.hailab.deeppilot',
    relayUrl: DEFAULT_RELAY_URL,
    relayToken: '',
  }),
})

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
  registerUpgrade(route: {
    path: string
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  }): () => void
}

type SubContext = {
  effect: (setup: () => unknown, name?: string) => unknown
}

const SERVER_VERSION = '0.2.0'
const MAX_CLIENT_CONNECTIONS = 16
/**
 * Single-frame bound. Covers the protocol maximum (4 × 8 MB base64 images
 * plus prompt text) with headroom while keeping an unauthenticated client's
 * pre-hello buffering far below ws's 100 MiB default.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = JSON.stringify({ error: reason })
  socket.end(
    'HTTP/1.1 ' + status + ' Forbidden\r\n' +
    'Content-Type: application/json\r\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\r\n' +
    'Connection: close\r\n' +
    '\r\n' +
    body,
  )
}

/** Authorization is preferred; the query form remains for older app builds. */
export function requestToken(req: Pick<IncomingMessage, 'url' | 'headers'>): string | null {
  const authorization = req.headers.authorization
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
    if (match?.[1]) return match[1]
  }
  try {
    return new URL(req.url ?? '/', 'http://phone.local').searchParams.get('token')
  } catch {
    return null
  }
}

/**
 * Cordis hands the second argument in different shapes depending on host
 * composition: a reactive options getter, the resolved config value, or
 * nothing when the patch row omits `config`. Normalize all of them.
 */
function normalizeOptions(options: unknown): Config {
  if (typeof options === 'function') {
    return (options as () => Config)()
  }
  if (options && typeof options === 'object') {
    return options as Config
  }
  // Validate undefined through the schema so every default applies.
  const validated = (Config as unknown as (data: unknown) => Config)(undefined)
  return validated ?? {}
}

export function apply(ctx: Context, options: unknown): void {
  const cfg = normalizeOptions(options)

  const log = (message: string): void => {
    console.log('[deeppilot] ' + message)
  }

  /**
   * Settings-section source: while a settings service is attached this holds
   * the user-edited section value; otherwise the composition defaults. Read
   * through currentConfig() everywhere (normalizeOptions prefers it).
   */
  let liveSource: (() => Config) | undefined
  let scheduleRemoteReconcile: (() => void) | undefined
  const currentConfig = (): Config => {
    if (liveSource !== undefined) return normalizeOptions(liveSource())
    return normalizeOptions(options)
  }
  const enabledNow = (): boolean => currentConfig().enabled === true

  // Web settings page: a "deeppilot" section with the plugin knobs.
  // Values persist through the settings document and re-enter via setSource;
  // `enabled` decides whether the bridge starts at all (next restart). This is
  // registered unconditionally so the master switch stays reachable even while
  // the bridge is off — otherwise a disabled bridge could never be re-enabled.
  installSettingsSection(ctx, settingsNamespace('deeppilot'), Config, normalizeOptions(undefined), {
    setSource: (source) => {
      liveSource = source
      // Settings can attach after webServer. Defer one microtask so the
      // settings service can finish publishing the new source before the
      // remote runtime reads it.
      queueMicrotask(() => scheduleRemoteReconcile?.())
    },
    onChange: () => queueMicrotask(() => scheduleRemoteReconcile?.()),
  })

  // Master switch, resolved against the latest available settings document.
  // Individual injected services also read currentConfig() when they activate.
  if (currentConfig().enabled !== true) {
    log('disabled via settings; bridge stays inactive (rumors of /phone below are skipped)')
  }

  // Resolved asynchronously; route handlers await readiness. Never rejects:
  // a storage failure degrades the bridge instead of killing the host.
  // The token lives in a mutable cell so rotation can swap the secret (and
  // invalidate the old one) without restarting the host.
  const dataDir = bridgeDataDir()

  // ---------- zero-touch push enrollment (distributed builds) ----------

  /**
   * Persistent relay-enrollment cell (deeppilot/push-relay.json). A
   * distributed app presents the distributor's shared enrollKey during
   * c2s.push.register; the bridge then auto-enables relay mode, enrolls with
   * the operator's relay and caches the issued token. Users never fill in
   * anything; explicit config always wins over the auto flag.
   */
  interface RelayEnrollmentCell {
    clientId?: string
    autoRelay?: boolean
    enrollKey?: string
    token?: string
  }
  const pushRelayPath = join(dataDir, 'push-relay.json')
  const enrollmentCell: RelayEnrollmentCell = {}

  function persistEnrollment(): void {
    void (async () => {
      try {
        await mkdir(dataDir, { recursive: true })
        await writeFile(pushRelayPath, JSON.stringify({ version: 1, ...enrollmentCell }, null, 2) + '\n', { mode: 0o600 })
      } catch {
        // best-effort persistence; enrollment retries on next trigger
      }
    })()
  }

  /** Fired from BridgeConnection when an app presents its built-in key. */
  const handlePushEnrollKey = async (enrollKey: string): Promise<void> => {
    if (enrollmentCell.enrollKey !== enrollKey) {
      enrollmentCell.enrollKey = enrollKey
    }
    const configuredProvider = currentConfig().push?.provider
    // Only flip when the user has not made an explicit choice.
    if (!configuredProvider || configuredProvider === 'none') {
      if (!enrollmentCell.autoRelay) {
        enrollmentCell.autoRelay = true
        log('push relay mode auto-enabled by enrolled app')
      }
    }
    persistEnrollment()
    // Enroll inline so the register handler sees final readiness: the first
    // offline notification must not depend on a reconnect.
    const url = (currentConfig().push?.relayUrl ?? '').trim() || DEFAULT_RELAY_URL
    await ensureRelayEnrolled(url)
  }
  const auth: { token: string | null; tokenPath: string; devices: DeviceStore | null } = {
    token: null,
    tokenPath: cfg.authTokenPath ?? join(dataDir, 'auth-token'),
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
      auth.tokenPath = cfg.authTokenPath ?? join(dataDir, 'auth-token')
      auth.token = await loadOrCreateToken(auth.tokenPath)
      auth.devices = await DeviceStore.load(cfg.devicesPath ?? join(dataDir, 'devices.json'))
      {
        // Startup visibility: makes "registrations vanished after restart"
        // instantly diagnosable (0 push rows ⇒ the file itself lost data).
        const rows = auth.devices.list()
        const registered = rows.filter((row) => row.apns !== undefined).length
        log(`device registry loaded from ${expandHome(cfg.devicesPath ?? join(dataDir, 'devices.json'))}: ${rows.length} device(s), ${registered} push registration(s)`)
      }
      // Restore zero-touch push enrollment state (best effort).
      try {
        const raw = JSON.parse(await readFile(pushRelayPath, 'utf8')) as RelayEnrollmentCell
        if (typeof raw.clientId === 'string') enrollmentCell.clientId = raw.clientId
        if (typeof raw.enrollKey === 'string') enrollmentCell.enrollKey = raw.enrollKey
        if (typeof raw.token === 'string') enrollmentCell.token = raw.token
        if (raw.autoRelay === true) enrollmentCell.autoRelay = true
      } catch {
        // first boot: no enrollment yet
      }
    } catch (error) {
      log('auth material unavailable, bridge degraded: ' + String(error))
      return { token: null, devices: null }
    }
    return { token: auth.token, devices: auth.devices }
  })()

  /**
   * Replace the pairing secret: persist a fresh token, clear the paired-device
   * registry, and drop every live phone socket. Handshake-time auth means an
   * already-open socket would otherwise outlive its token; terminating forces
   * each device to re-pair with the new secret. The old token is invalid the
   * moment the file is rewritten.
   *
   * Serialized through rotateTail so two overlapping invocations can never
   * return a token that a later write already invalidated.
   */
  const doRotate = async (): Promise<string> => {
    const { devices } = await ready
    if (auth.token === null || devices === null) {
      throw new Error('pairing token unavailable')
    }
    auth.token = await writeNewToken(auth.tokenPath)
    devices.clear()
    let dropped = 0
    for (const connection of connections) {
      connection.terminate()
      dropped += 1
    }
    connections.clear()
    log(`pairing token rotated; ${dropped} live phone connection(s) dropped`)
    return auth.token
  }
  let rotateTail: Promise<unknown> = Promise.resolve()
  const rotatePairingToken = (): Promise<string> => {
    const next = rotateTail.then(doRotate)
    rotateTail = next.catch(() => {})
    return next
  }

  /**
   * Settings-page push self-test: force one synthetic notification down the
   * active pathway to EVERY registered device, deliberately ignoring the
   * connected-skip and category-mute filters — an explicit user action must
   * always be able to prove delivery end to end.
   */
  const runPushSelfTest = async (): Promise<PushTestResult> => {
    const resolved = resolvePushConfig(currentConfig())
    if (!resolved.ok) {
      return {
        transport: 'none',
        overall: 'not-configured',
        message: '推送未启用（' + resolved.reason + '）。可先用「测试访问与注册」完成中继注册，或在配置中设置 push.provider',
        results: [],
      }
    }
    const tokenized = (auth.devices?.list() ?? []).filter((device) => device.apns !== undefined)
    if (!auth.devices || tokenized.length === 0) {
      return {
        transport: resolved.value.kind,
        overall: 'no-targets',
        message: '还没有设备注册离线推送——在手机上打开 DeepPilot 并允许系统通知，等状态变为「已就绪」后再试',
        results: [],
      }
    }
    const send = await senderFor(resolved.value)
    if (!send) {
      return { transport: resolved.value.kind, overall: 'failed', message: '发送通道不可用（检查 .p8 密钥文件或中继配置）', results: [] }
    }
    const notification: PushNotification = {
      notificationId: 'test-' + Date.now(),
      category: 'turn.completed',
      sessionId: 'push-test',
      title: 'DeepPilot 测试推送',
      body: '收到这条通知说明离线推送链路正常',
    }
    const results = await Promise.all(tokenized.map(async (device) => {
      const registration = device.apns!
      const { outcome, reason } = await send({
        deviceToken: registration.token,
        environment: registration.environment,
        notification,
      })
      return {
        name: device.deviceName,
        environment: registration.environment,
        outcome,
        // First 10 hex chars let the operator verify the stored token matches
        // what the device currently holds (tokens rotate on reinstall).
        tokenFingerprint: registration.token.slice(0, 10),
        ...(reason !== undefined ? { reason } : {}),
      }
    }))
    const overall: PushTestResult['overall'] = results.some((r) => r.outcome === 'sent') ? 'sent' : 'failed'
    log('push self-test: ' + overall + ' (' + results.map((r) => `"${r.name}"=${r.outcome}${r.reason ? '/' + r.reason : ''}`).join(', ') + ')')
    return { transport: resolved.value.kind, overall, results }
  }

  const connections = new Set<BridgeConnection>()

  // ---------- offline push outlet (F-9) ----------

  type PushConfigSnapshot =
    | { kind: 'apns'; teamId: string; keyId: string; keyPath: string; bundleId: string }
    | { kind: 'relay'; url: string; token: string }

  const resolvePushConfig = (config: Config): { ok: true; value: PushConfigSnapshot } | { ok: false; reason: string } => {
    const push = config.push ?? {}
    // Auto-enabled by an enrolled distributed app when the user made no
    // explicit provider choice.
    const configured = push.provider ?? 'none'
    const effectiveProvider = configured === 'none' && enrollmentCell.autoRelay === true ? 'relay' : configured
    if (effectiveProvider === 'relay') {
      const url = (push.relayUrl ?? '').trim() || DEFAULT_RELAY_URL
      const token = (push.relayToken ?? '').trim() || enrollmentCell.token || ''
      if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'relayUrl must be an https URL' }
      if (!token) return { ok: false, reason: 'relay token not enrolled yet' }
      return { ok: true, value: { kind: 'relay', url, token } }
    }
    if (effectiveProvider === 'apns') {
      const teamId = (push.teamId ?? '').trim()
      const keyId = (push.keyId ?? '').trim()
      const keyPath = expandHome((push.keyPath ?? '').trim() || join(dataDir, 'apns', 'AuthKey.p8'))
      const bundleId = (push.bundleId ?? '').trim()
      if (!teamId || !keyId || !bundleId) return { ok: false, reason: 'teamId/keyId/bundleId missing' }
      return { ok: true, value: { kind: 'apns', teamId, keyId, keyPath, bundleId } }
    }
    return { ok: false, reason: 'provider disabled' }
  }

  /**
   * Zero-touch enrollment against the operator's relay. Idempotent and
   * cached in the persistent cell; a failure disables push for this config
   * fingerprint with one log line until something changes.
   */
  let enrollAttemptFor: string | undefined
  let enrollLastAttemptAt = 0
  const ensureRelayEnrolled = async (url: string): Promise<string | undefined> => {
    // The enrollment body carries the distributor's shared key; a mis-typed
    // http:// relayUrl must never leak it in cleartext. (Send-path requests
    // are already gated by resolvePushConfig — enrollment call sites are not.)
    if (!/^https:\/\//i.test(url.trim())) {
      log('push relay enrollment refused: relayUrl must be an https URL')
      return undefined
    }
    if (enrollmentCell.token) return enrollmentCell.token
    const fingerprint = url + ':' + String(enrollmentCell.enrollKey ?? '')
    if (fingerprint !== enrollAttemptFor) {
      enrollAttemptFor = fingerprint
      enrollLastAttemptAt = 0
    }
    // Same fingerprint failing repeatedly: throttle to one attempt/minute so
    // a down relay cannot turn every notification into an outbound storm,
    // while transient failures still recover quickly.
    if (Date.now() - enrollLastAttemptAt < 60_000) return undefined
    enrollLastAttemptAt = Date.now()
    try {
      if (!enrollmentCell.clientId) {
        enrollmentCell.clientId = 'u_' + randomBytes(16).toString('base64url')
        persistEnrollment()
      }
      const client = new RelayClient({ url, debug: currentConfig().debug === true, log })
      const token = await client.enroll(enrollmentCell.clientId, enrollmentCell.enrollKey ?? '')
      if (!token) {
        log('push relay enrollment failed (' + url + '); will retry on next trigger')
        return undefined
      }
      enrollmentCell.token = token
      persistEnrollment()
      log('push relay enrollment succeeded')
      return token
    } catch (error) {
      log('push relay enrollment error: ' + String(error))
      return undefined
    }
  }

  interface SendOutcome { outcome: 'sent' | 'invalid-token' | 'failed'; reason?: string }
  type PushSender = (
    request: { deviceToken: string; environment: ApnsEnvironment; notification: Parameters<PushOutlet['fanOut']>[0] },
  ) => Promise<SendOutcome>

  interface CachedSender {
    fingerprint: string
    send: PushSender
    dispose?: () => Promise<void>
  }
  let cachedSender: CachedSender | undefined
  /**
   * Last failed APNs-sender build. The config fingerprint cannot see the
   * filesystem, so remembering a failure forever meant "copy the .p8 into
   * place later" never recovered without an edit or restart; throttle the
   * retry by time instead — same pattern as relay enrollment below.
   */
  let senderFailedFor: { fingerprint: string; at: number } | undefined
  const SENDER_FAILURE_RETRY_MS = 60_000

  /**
   * Lazily build the push sender for the current config. A broken config
   * (unreadable .p8) disables push for that fingerprint with exactly one log
   * line instead of failing on every event.
   */
  const senderFor = async (resolved: PushConfigSnapshot): Promise<PushSender | undefined> => {
    const fingerprint = JSON.stringify(resolved)
    if (cachedSender?.fingerprint === fingerprint) return cachedSender.send
    // A recent failure only blocks retries for a short window: a permanently
    // broken config must not log-storm on every event, but the same config
    // with the key file since added MUST get another chance.
    if (
      senderFailedFor?.fingerprint === fingerprint &&
      Date.now() - senderFailedFor.at < SENDER_FAILURE_RETRY_MS
    ) {
      return undefined
    }
    if (cachedSender) {
      await cachedSender.dispose?.().catch(() => {})
      cachedSender = undefined
    }
    if (resolved.kind === 'relay') {
      // resolvePushConfig already guarantees a token exists in the cell
      // (config token or a completed enrollment).
      const client = new RelayClient({ url: resolved.url, token: resolved.token, debug: currentConfig().debug === true, log })
      cachedSender = {
        fingerprint,
        send: (request) => client.send(request),
      }
      log('push relay enabled')
    } else {
      try {
        await readFile(expandHome(resolved.keyPath), 'utf8')
      } catch (error) {
        senderFailedFor = { fingerprint, at: Date.now() }
        log('apns push unavailable (key unreadable at ' + resolved.keyPath + '): ' + String(error))
        return undefined
      }
      const client = new ApnsClient({
        teamId: resolved.teamId,
        keyId: resolved.keyId,
        keyPath: resolved.keyPath,
        bundleId: resolved.bundleId,
        debug: currentConfig().debug === true,
        log,
      })
      cachedSender = {
        fingerprint,
        send: (request) => client.send({
          ...request.notification,
          deviceToken: request.deviceToken,
          environment: request.environment,
        }),
        dispose: () => client.dispose(),
      }
      log('apns push enabled')
    }
    senderFailedFor = undefined
    return cachedSender.send
  }

  /**
   * Fan one notification-worthy event out to paired devices holding an APNs
   * token. Rules:
   *  - devices with a live WebSocket are skipped (they already got the WS
   *    frame and will raise the local notification themselves);
   *  - each device is delivered on ITS registered environment (the build
   *    kind it self-reported), so sandbox and production devices coexist;
   *  - the device's per-category switches suppress muted categories;
   *  - Unregistered/BadDeviceToken outcomes prune the stored token.
   */
  const makePushOutlet = (): PushOutlet => ({
    // The capability bit must tell the truth: only advertise push when the
    // provider is fully configured, otherwise clients would suppress their
    // local banners expecting a delivery that never happens.
    isAvailable: () => {
      const resolved = resolvePushConfig(currentConfig())
      if (!resolved.ok) return false
      // Relay mode is only truly ready once enrollment produced a token;
      // advertising earlier would make clients suppress their local banners
      // for deliveries that cannot happen yet.
      if (resolved.value.kind === 'relay' && !resolved.value.token) return false
      return true
    },
    fanOut: (notification) => {
      void (async () => {
        let resolved = resolvePushConfig(currentConfig())
        if (!resolved.ok && resolved.reason === 'relay token not enrolled yet') {
          // A registration carried the enrollKey but enrollment has not run —
          // try once now, then re-resolve.
          const relayUrl = (currentConfig().push?.relayUrl ?? '').trim() || DEFAULT_RELAY_URL
          await ensureRelayEnrolled(relayUrl)
          resolved = resolvePushConfig(currentConfig())
        }
        if (!resolved.ok) return
        const devices = auth.devices
        if (!devices) return
        const send = await senderFor(resolved.value)
        if (!send) return
        const transport = resolved.value.kind
        const connectedIds = new Set<string>()
        for (const connection of connections) {
          const id = connection.connectedDeviceId
          if (id) connectedIds.add(id)
        }
        // Observability first: push failures used to be completely silent
        // (outcomes were debug-gated), which made field diagnosis impossible.
        // Every dispatch and every skip now leaves one flat log line —
        // categories and outcomes only, never message bodies.
        const candidates = devices.list().filter((device) => {
          const registration = device.apns
          if (!registration) return false
          if (connectedIds.has(device.deviceId)) return false
          if (registration.categories?.[notification.category] === false) {
            if (currentConfig().debug === true) {
              log(`push skip "${device.deviceName}": category ${notification.category} muted`)
            }
            return false
          }
          return true
        })
        if (candidates.length === 0) {
          const tokenized = devices.list().filter((device) => device.apns !== undefined).length
          log(`push(${transport}) ${notification.category}: no offline targets (connected=${connectedIds.size}, tokenized=${tokenized})`)
          return
        }
        for (const device of candidates) {
          const registration = device.apns!
          void send({ deviceToken: registration.token, environment: registration.environment, notification })
            .then(({ outcome, reason }) => {
              log(`push(${transport}) ${notification.category} → "${device.deviceName}" [${registration.environment}] = ${outcome}${reason ? ' (' + reason + ')' : ''}`)
              if (outcome === 'invalid-token') {
                devices.clearPushToken(device.deviceId)
                log(`push: pruned stale token of "${device.deviceName}" (${reason ?? 'unknown'}) — app re-registers on next launch`)
              }
            })
            .catch(() => {})
        }
      })()
    },
  })


  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  let remoteSupervisor: RemoteSupervisor | undefined
  const remoteStatus = (): RemoteStatus => remoteSupervisor?.status() ?? {
    provider: 'tailscale-funnel',
    phase: currentConfig().remote?.enabled === true ? 'stopped' : 'disabled',
    updatedAt: Date.now(),
  }

  // Typert Remote for the web settings page (deeppilot/report).
  applyReportRemote(ctx, async () => {
    let tokenReady = false
    let devices: Array<{ deviceId: string; deviceName: string; appVersion: string; firstSeenTs: number; lastSeenTs: number; apns?: { environment: 'development' | 'production'; updatedAt: number } }> = []
    try {
      await ready
      tokenReady = auth.token !== null
      // Strip the raw APNs token at the source; the report carries only the
      // registration fact (environment + freshness).
      devices = (auth.devices?.list() ?? []).map(({ deviceId, deviceName, appVersion, firstSeenTs, lastSeenTs, apns }) => ({
        deviceId,
        deviceName,
        appVersion,
        firstSeenTs,
        lastSeenTs,
        ...(apns ? { apns: { environment: apns.environment, updatedAt: apns.updatedAt } } : {}),
      }))
    } catch {
      // degraded: report the minimum without token facts
    }
    return {
      protocolVersion: 1,
      serverVersion: SERVER_VERSION,
      enabled: currentConfig().enabled === true,
      tokenPath: expandHome(currentConfig().authTokenPath ?? join(bridgeDataDir(), 'auth-token')),
      tokenReady,
      activeConnections: connections.size,
      historyBufferMax: currentConfig().historyBufferMax ?? 2000,
      debug: currentConfig().debug === true,
      lanAddresses: localLANIPv4Addresses(),
      remote: remoteStatus(),
      devices,
    }
  }, async () => {
    await ready
    if (auth.token === null) throw new Error('pairing token unavailable')
    return auth.token
  }, rotatePairingToken, async () => {
      const push = currentConfig().push ?? {}
      const configured = push.provider ?? 'none'
      const effective = configured === 'none' && enrollmentCell.autoRelay === true ? 'relay' : configured
      if (effective !== 'relay') {
        return {
          url: '',
          overall: 'failed' as const,
          tokenIssued: false,
          steps: [{ id: 'health' as const, ok: false, message: `当前推送模式不是中继（provider=${configured}）。启用方式二选一：① 零配置——在 ios/project.yml 填写 DSPushEnrollKey（与服务器 RELAY_ENROLL_KEY 一致）并重新安装 App，打开 App 即自动启用；② 手动——将 push.provider 设为 relay 并填入 relayToken` }],
        }
      }
      const url = (push.relayUrl ?? '').trim() || DEFAULT_RELAY_URL
      if (!/^https:\/\//i.test(url)) {
        return {
          url,
          overall: 'failed' as const,
          tokenIssued: false,
          steps: [{ id: 'health' as const, ok: false, message: 'relayUrl 必须是 https 地址：注册请求携带共享密钥，明文 HTTP 会把它暴露给链路上的任何节点' }],
        }
      }
      // The enroll step needs an identity; mint one now so a successful test
      // doubles as a completed enrollment.
      if (!enrollmentCell.clientId && enrollmentCell.enrollKey) {
        enrollmentCell.clientId = 'u_' + randomBytes(16).toString('base64url')
        persistEnrollment()
      }
      return await runRelayProbe({
        url,
        clientId: enrollmentCell.clientId,
        enrollKey: enrollmentCell.enrollKey,
        manualToken: Boolean((push.relayToken ?? '').trim()),
        onEnrolled: (token) => {
          enrollmentCell.token = token
          persistEnrollment()
          log('push relay enrollment succeeded (via settings self-test)')
        },
      })
    }, async () => {
      return await runPushSelfTest()
    })
  const state: { bridge?: HostBridge } = {}

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void (async () => {
      try {
        if (!enabledNow()) {
          rejectUpgrade(socket, 503, 'bridge disabled')
          return
        }
        if (connections.size >= MAX_CLIENT_CONNECTIONS) {
          rejectUpgrade(socket, 429, 'too many connections')
          return
        }
        const { devices } = await ready
        const token = auth.token
        if (!token || !devices) {
          rejectUpgrade(socket, 503, 'bridge degraded')
          return
        }
        const presentedToken = requestToken(req)
        if (presentedToken !== null && !tokenMatches(presentedToken, token)) {
          rejectUpgrade(socket, 401, 'invalid token')
          return
        }
        const bridge = state.bridge
        if (!bridge) {
          rejectUpgrade(socket, 503, 'bridge not ready')
          return
        }
        // Rotation may have swapped the secret while this handshake was in
        // flight; a connection validated against the previous token must not
        // survive it.
        if (auth.token !== token) {
          rejectUpgrade(socket, 401, 'invalid token')
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          const connection = new BridgeConnection(ws, {
            bridge,
            devices,
            serverVersion: SERVER_VERSION,
            expectedToken: token,
            transportAuthenticated: presentedToken !== null,
            log,
            debug: currentConfig().debug === true,
            onClosed: (closed) => connections.delete(closed),
            onPushEnrollKey: handlePushEnrollKey,
          })
          connections.add(connection)
        })
      } catch (error) {
        log('upgrade failed: ' + String(error))
        rejectUpgrade(socket, 500, 'internal error')
      }
    })()
  }

  const handleHealth = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await ready
      const token = auth.token
      res.setHeader('Content-Type', 'application/json')
      if (!token) {
        res.statusCode = 503
        res.end(JSON.stringify({ ok: false, degraded: true }))
        return
      }
      if (!tokenMatches(requestToken(req), token)) {
        res.statusCode = 401
        res.end(JSON.stringify({ ok: false }))
        return
      }
      res.statusCode = 200
      res.end(JSON.stringify({
        ok: true,
        enabled: enabledNow(),
        protocolVersion: 1,
        serverVersion: SERVER_VERSION,
        dataPlane: Boolean(state.bridge),
      }))
    } catch {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false }))
    }
  }

  // Data plane: consume mux/host streams once the API gateway exists.
  ;(ctx as unknown as { inject: (deps: string[], fn: (sub: unknown) => void) => void }).inject(
    ['apiProxy'],
    (sub) => {
      if (currentConfig().enabled !== true) {
        log('bridge disabled; data plane stays inactive')
        return
      }
      const apiCtx = sub as unknown as { apiProxy?: ApiProxyLike } & SubContext
      const proxy = apiCtx.apiProxy
      if (!proxy) {
        log('apiProxy service absent; data plane stays inactive')
        return
      }
      const bridge = new HostBridge(proxy, cfg.historyBufferMax)
      bridge.setPushOutlet(makePushOutlet())
      state.bridge = bridge
      bridge.start()
      log('data plane active (mux + host streams)')
      apiCtx.effect(() => () => bridge.dispose(), 'deeppilot: host streams')
    },
  )

  // Transport plane: /phone WebSocket + /phone/health probe.
  ;(ctx as unknown as { inject: (deps: string[], fn: (sub: unknown) => void) => void }).inject(
    ['webServer'],
    (sub) => {
      const webCtx = sub as unknown as { webServer?: WebServerLike } & SubContext
      const web = webCtx.webServer
      if (!web) {
        log('webServer service absent in this profile; bridge stays inactive')
        return
      }
      // Routes are registered regardless of the master switch so a mid-session
      // toggle always stays serviceable; every handler refuses work when the
      // bridge is currently disabled (evaluated per request so it is robust to
      // the settings scope attaching before or after webServer).
      webCtx.effect(
        () =>
          web.registerUpgrade({
            path: '/phone',
            handler: handleUpgrade,
          }),
        'deeppilot: /phone WebSocket',
      )

      webCtx.effect(
        () =>
          web.register({
            kind: 'exact',
            path: '/phone/health',
            handler: handleHealth,
          }),
        'deeppilot: /phone/health',
      )

      const sweep = setInterval(() => {
        const now = Date.now()
        for (const connection of connections) {
          if (connection.isStale(now, 60_000)) {
            log('dropping stale connection')
            connection.terminate()
            connections.delete(connection)
          }
        }
      }, 30_000)
      webCtx.effect(() => () => clearInterval(sweep), 'deeppilot: stale sweep')

      // The settings source is not guaranteed to attach before webServer.
      // Keep a loopback origin ready and reconcile the helper whenever that
      // source appears or changes, instead of freezing the schema defaults at
      // injection time.
      const originServer = createServer((req, res) => {
        let path = '/'
        try { path = new URL(req.url ?? '/', 'http://phone.local').pathname } catch { /* reject below */ }
        if (path === '/phone/health') {
          void handleHealth(req, res)
        } else {
          res.statusCode = 404
          res.end('not found')
        }
      })
      originServer.on('upgrade', (req, socket, head) => {
        let path = '/'
        try { path = new URL(req.url ?? '/', 'http://phone.local').pathname } catch { /* reject below */ }
        if (path !== '/phone') {
          socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
          return
        }
        handleUpgrade(req, socket, head)
      })

      let originURL: string | undefined
      let appliedRemoteKey: string | undefined
      let remoteDisposed = false
      let reconcileTail = Promise.resolve()
      const reconcileRemote = async (): Promise<void> => {
        if (remoteDisposed || originURL === undefined) return
        const config = currentConfig()
        const remoteConfig = config.remote ?? {}
        const remotePort: 443 | 8443 | 10000 = remoteConfig.funnelPort === 8443 || remoteConfig.funnelPort === 10000
          ? remoteConfig.funnelPort
          : 443
        const helperPath = remoteConfig.helperPath?.trim() || undefined
        const next = {
          enabled: config.enabled === true && remoteConfig.enabled === true && remoteConfig.provider === 'tailscale-funnel',
          hostname: normalizeRemoteHostname(remoteConfig.hostname),
          statePath: remoteConfig.statePath?.trim() || join(dataDir, 'tailscale'),
          helperPath,
          funnelPort: remotePort,
        }
        const nextKey = JSON.stringify(next)
        if (nextKey === appliedRemoteKey) return

        const previous = remoteSupervisor
        remoteSupervisor = undefined
        if (previous !== undefined) await previous.dispose()
        if (remoteDisposed) return

        const supervisor = new RemoteSupervisor({
          enabled: next.enabled,
          hostname: next.hostname,
          statePath: next.statePath,
          ...(next.helperPath ? { helperPath: next.helperPath } : {}),
          funnelPort: next.funnelPort,
          log,
        })
        remoteSupervisor = supervisor
        appliedRemoteKey = nextKey
        await supervisor.start(originURL)
      }
      scheduleRemoteReconcile = () => {
        reconcileTail = reconcileTail
          .then(reconcileRemote)
          .catch((error) => log('remote reconcile failed: ' + String(error)))
      }

      originServer.listen(0, '127.0.0.1', () => {
        const address = originServer.address()
        if (address && typeof address === 'object') {
          originURL = `http://127.0.0.1:${address.port}`
          scheduleRemoteReconcile?.()
        }
      })
      originServer.on('error', (error) => log('remote origin failed: ' + String(error)))
      webCtx.effect(() => () => {
        remoteDisposed = true
        scheduleRemoteReconcile = undefined
        originServer.close()
        reconcileTail = reconcileTail.then(async () => {
          const supervisor = remoteSupervisor
          remoteSupervisor = undefined
          if (supervisor !== undefined) await supervisor.dispose()
        })
      }, 'deeppilot: embedded Funnel')
      if (enabledNow()) {
        log('/phone WebSocket registered')
      } else {
        log('bridge disabled; /phone refuses connections until re-enabled and restarted')
      }
    },
  )
}
