/**
 * 推送网关（PushGateway）——离线推送的单一属主。
 *
 * 迁移前，这约 450 行住在 `apply()` 的闭包里：enrollment cell 与持久化、
 * `handlePushEnrollKey`、`resolvePushConfig`、`ensureRelayEnrolled`、
 * `senderFor` + cachedSender + 失败退避、两个 scheduler、`makePushOutlet`、
 * 两个自测。它今天的「接口」其实是「被 WidgetPushScheduler、
 * LiveActivityPushManager、PushOutlet 和两个 report 回调各自捕获的那几段代码」
 * ——没有任何一处能回答「推送为什么没到」。
 *
 * 现在：一个 module，实现 `PushOutlet`（HostBridge 消费的那四个方法）并额外
 * 暴露自测与零配置注册入口。enrollment、持久化、sender 缓存、退避、401 自愈
 * 全部入内；`apply()` 只做依赖注入。
 *
 * 两处本次收敛的重复：
 * - effective provider 推导（原先在 resolvePushConfig 与 relay 自测里各一份）；
 * - 401 自愈三元组（原先在 widget / liveActivity / fanOut 三处各一份，
 *   见 healRelayCredential）。
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_RELAY_URL,
  type Config,
} from './config.ts'
import { ApnsClient } from './apns.ts'
import { RelayClient } from './relay-client.ts'
import { WidgetPushScheduler } from './widget-push.ts'
import { LiveActivityPushManager } from './live-activity.ts'
import {
  mayReceivePush,
  pushContent,
  shouldPrunePushToken,
  shouldReEnrollRelayToken,
} from './push-policy.ts'
import { deviceDisplayName, expandHome, type DeviceStore } from './token.ts'
import type { ApnsEnvironment } from './token.ts'
import type { PushDelivery, PushNotification, SessionSummary } from './protocol.ts'
import type { PushOutlet } from './host-api.ts'
import type { PushTestResult, RelayTestResult } from './report-wire.ts'
import { runRelayProbe } from './relay-test.ts'

/** 零配置注册的持久化单元（deeppilot/push-relay.json）。 */
interface RelayEnrollmentCell {
  clientId?: string
  autoRelay?: boolean
  enrollKey?: string
  token?: string
}

type PushConfigSnapshot =
  | { kind: 'apns'; teamId: string; keyId: string; keyPath: string; bundleId: string }
  | { kind: 'relay'; url: string; token: string }

interface SendOutcome { outcome: 'sent' | 'invalid-token' | 'failed'; reason?: string }
type PushSender = (
  request: { deviceToken: string; environment: ApnsEnvironment; notification: PushDelivery },
) => Promise<SendOutcome>

interface CachedSender {
  fingerprint: string
  send: PushSender
  dispose?: () => Promise<void>
}

/** 274 秒（约 4.5 分钟）内的失败只记一次；其间同一指纹不再重试。 */
const SENDER_FAILURE_RETRY_MS = 60_000
/** 中继注册失败的节流：一次/分钟，避免中继抖动把每次通知变成一次外呼。 */
const ENROLL_RETRY_MS = 60_000

/** 网关需要的一切都从外部注入；它自己不创建配置、设备表或连接集合。 */
export interface PushGatewayDeps {
  config: () => Config
  /** 推送数据目录（push-relay.json 与 APNs 密钥默认路径的宿主）。 */
  dataDir: string
  devices: () => DeviceStore | null
  audience: () => string | null
  /** 当前活跃连接：用于跳过已有 WebSocket 的设备。 */
  connections: () => Iterable<{
    connectedDeviceId: string | undefined
    suppressesAlertPush: boolean
  }>
  enabledNow: () => boolean
  log: (message: string) => void
  /** 中继探测的传输实现：默认真实 fetch，测试注入假件以免碰网络。 */
  fetchImpl?: typeof fetch
}

export class PushGateway implements PushOutlet {
  private readonly pushRelayPath: string
  private readonly enrollmentCell: RelayEnrollmentCell = {}
  private enrollmentWriteTail: Promise<void> = Promise.resolve()
  private enrollAttemptFor: string | undefined
  private enrollLastAttemptAt = 0
  private cachedSender: CachedSender | undefined
  private senderFailedFor: { fingerprint: string; at: number } | undefined

  private readonly widgetPush: WidgetPushScheduler
  private readonly liveActivityPush: LiveActivityPushManager

  constructor(private readonly deps: PushGatewayDeps) {
    this.pushRelayPath = join(deps.dataDir, 'push-relay.json')
    this.widgetPush = new WidgetPushScheduler(async () => { await this.flushWidgetPushes() })
    this.liveActivityPush = new LiveActivityPushManager(
      () => deps.devices() ?? undefined,
      async (deviceToken, environment, notification) => this.sendLiveActivity(deviceToken, environment, notification),
    )
  }

  // ---------- 生命周期 ----------

  /** 首启恢复零配置注册状态（best effort）。 */
  async restore(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.pushRelayPath, 'utf8')) as RelayEnrollmentCell
      if (typeof raw.clientId === 'string') this.enrollmentCell.clientId = raw.clientId
      if (typeof raw.enrollKey === 'string') this.enrollmentCell.enrollKey = raw.enrollKey
      if (typeof raw.token === 'string') this.enrollmentCell.token = raw.token
      if (raw.autoRelay === true) this.enrollmentCell.autoRelay = true
    } catch {
      // first boot: no enrollment yet
    }
  }

  /** 写盘串行化：并发注册不会交错写坏同一个文件。 */
  private persistEnrollment(): void {
    const snapshot = JSON.stringify({ version: 1, ...this.enrollmentCell }, null, 2) + '\n'
    this.enrollmentWriteTail = this.enrollmentWriteTail.then(async () => {
      const tempPath = this.pushRelayPath + '.' + randomBytes(6).toString('hex') + '.tmp'
      try {
        await mkdir(this.deps.dataDir, { recursive: true })
        await writeFile(tempPath, snapshot, { mode: 0o600 })
        await rename(tempPath, this.pushRelayPath)
      } catch {
        await unlink(tempPath).catch(() => {})
        // best-effort persistence; enrollment retries on next trigger
      }
    })
  }

  /** 等注册状态的写盘尾部排空；测试与收尾都用它取得确定性。 */
  async persisted(): Promise<void> {
    await this.enrollmentWriteTail
  }

  /** 进程收尾：等写盘尾部落盘，释放 sender。 */
  async dispose(): Promise<void> {
    this.widgetPush.dispose()
    this.liveActivityPush.dispose()
    const sender = this.cachedSender
    this.cachedSender = undefined
    await Promise.allSettled([
      this.enrollmentWriteTail,
      sender?.dispose?.() ?? Promise.resolve(),
    ])
  }

  // ---------- PushOutlet（HostBridge 消费） ----------

  widgetChanged(): void {
    this.widgetPush.changed()
  }

  liveActivityChanged(sessions: SessionSummary[]): void {
    this.liveActivityPush.changed(sessions)
  }

  /** 能力位必须说真话：只在 provider 完全就绪时才广告 push。 */
  isAvailable(): boolean {
    const resolved = this.resolvePushConfig(this.deps.config())
    if (!resolved.ok) return false
    // 中继模式要等注册产出 token 才算就绪；提前广告会让客户端压掉本地通知，
    // 而那条通知永远不会到。
    if (resolved.value.kind === 'relay' && !resolved.value.token) return false
    return true
  }

  /**
   * 把一个值得通知的事件扇到持有 APNs token 的已配对设备。规则：
   *  - 有活跃 WebSocket 的设备跳过（它们已收到 WS 帧，会自己弹本地通知）；
   *  - 只考虑被授予 `notifications.register` 的设备——scope 被收窄的设备不得
   *    再收到离线推送（R1/P2 S→C 权限策略）；
   *  - 每设备按它自己注册的环境投递，沙盒与生产设备可共存；
   *  - 设备按类别的静音开关抑制对应类别；
   *  - 只有 APNs 的终态 Unregistered/ExpiredToken 才清理存储；
   *    BadDeviceToken 可能是环境不匹配，保留可诊断性。
   */
  fanOut(sourceNotification: PushNotification): void {
    const notification = pushContent(
      { ...sourceNotification, hostAudience: this.deps.audience() ?? undefined },
      this.deps.config().push?.contentMode,
    )
    void (async () => {
      let resolved = this.resolvePushConfig(this.deps.config())
      if (!resolved.ok && resolved.reason === 'relay token not enrolled yet') {
        // 注册时带着 enrollKey 但注册还没跑完——立刻试一次再重新解析。
        await this.ensureRelayEnrolled(this.relayUrl())
        resolved = this.resolvePushConfig(this.deps.config())
      }
      if (!resolved.ok) return
      const devices = this.deps.devices()
      if (!devices) return
      const send = await this.senderFor(resolved.value)
      if (!send) return
      const transport = resolved.value.kind
      const connectedIds = new Set<string>()
      for (const connection of this.deps.connections()) {
        const id = connection.connectedDeviceId
        if (id && connection.suppressesAlertPush) connectedIds.add(id)
      }
      // 可观测性优先：推送失败曾经完全静默（受 debug 门控），现场无法诊断。
      // 现在每次派送与每次跳过都留一行平铺日志——只有类别与结果，绝不带消息体。
      const candidates = devices.list().filter((device) => {
        const registration = device.apns
        if (!registration) return false
        if (connectedIds.has(device.deviceId)) return false
        if (!mayReceivePush(device, notification)) {
          if (this.deps.config().diagnostics?.debug === true) {
            this.deps.log(`push skip "${deviceDisplayName(device)}": notification permission not granted`)
          }
          return false
        }
        if (registration.categories?.[notification.category] === false) {
          if (this.deps.config().diagnostics?.debug === true) {
            this.deps.log(`push skip "${deviceDisplayName(device)}": category ${notification.category} muted`)
          }
          return false
        }
        return true
      })
      if (candidates.length === 0) {
        const tokenized = devices.list().filter((device) => device.apns !== undefined).length
        this.deps.log(`push(${transport}) ${notification.category}: no offline targets (connected=${connectedIds.size}, tokenized=${tokenized})`)
        return
      }
      // 自愈输入每次派送解析一次：实际发送所用的 URL，以及凭据是否来自零配置
      // 单元（显式配置的 relayToken 永不被改写）。
      const relayUrl = resolved.value.kind === 'relay' ? resolved.value.url : undefined
      const relayTokenUsed = resolved.value.kind === 'relay' ? resolved.value.token : undefined
      const usedCellToken = relayTokenUsed !== undefined && relayTokenUsed === this.enrollmentCell.token
      const hasEnrollKey = Boolean(this.enrollmentCell.enrollKey)
      for (const device of candidates) {
        const registration = device.apns!
        void send({ deviceToken: registration.token, environment: registration.environment, notification })
          .then(({ outcome, reason }) => {
            this.deps.log(`push(${transport}) ${notification.category} → "${deviceDisplayName(device)}" [${registration.environment}] = ${outcome}${reason ? ' (' + reason + ')' : ''}`)
            if (shouldPrunePushToken(outcome, reason)) {
              devices.clearPushToken(device.deviceId)
              this.deps.log(`push: pruned stale token of "${deviceDisplayName(device)}" (${reason ?? 'unknown'}) — app re-registers on next launch`)
              return
            }
            if (
              relayUrl !== undefined &&
              shouldReEnrollRelayToken(transport, outcome, reason, {
                usedCellToken,
                hasEnrollKey,
                // Compare-and-clear：另一请求携带旧凭据的迟到 401 不得擦掉
                // 已被更早回调刷新过的 token。
                tokenStillCurrent: this.enrollmentCell.token === relayTokenUsed,
              })
            ) {
              // 中继不再认这个凭据。丢掉并从 enroll key 重新派生；
              // ensureRelayEnrolled 自己的节流避免并行 401 打爆端点，
              // senderFor 的配置指纹会在下次派送时用新 token 重建客户端。
              void this.healRelayCredential(relayUrl, relayTokenUsed, 'push relay credential rejected (HTTP 401); re-enrolling')
            }
          })
          .catch(() => {})
      }
    })()
  }

  // ---------- 零配置注册与自测（report remote 与 wire 帧消费） ----------

  /** 分布式 App 在 c2s.push.register 里呈上分发方的共享钥匙时触发。 */
  async enrollKey(enrollKey: string): Promise<void> {
    if (this.enrollmentCell.enrollKey !== enrollKey) {
      this.enrollmentCell.enrollKey = enrollKey
    }
    const configuredProvider = this.deps.config().push?.provider
    // 只在用户没有显式选择时才翻转。
    if (!configuredProvider || configuredProvider === 'none') {
      if (!this.enrollmentCell.autoRelay) {
        this.enrollmentCell.autoRelay = true
        this.deps.log('push relay mode auto-enabled by enrolled app')
      }
    }
    this.persistEnrollment()
    // 内联完成注册，让 register handler 看到最终就绪状态：第一条离线通知
    // 不应依赖一次重连。
    await this.ensureRelayEnrolled(this.relayUrl())
  }

  /** 设置页推送自测：强制一条合成通知走完整链路到每个已注册设备。 */
  async selfTest(): Promise<PushTestResult> {
    const resolved = this.resolvePushConfig(this.deps.config())
    if (!resolved.ok) {
      return {
        transport: 'none',
        overall: 'not-configured',
        message: '推送未启用（' + resolved.reason + '）。可先用「测试访问与注册」完成中继注册，或在配置中设置 push.provider',
        results: [],
      }
    }
    const devices = this.deps.devices()
    const tokenized = (devices?.list() ?? []).filter((device) => device.apns !== undefined)
    if (!devices || tokenized.length === 0) {
      return {
        transport: resolved.value.kind,
        overall: 'no-targets',
        message: '还没有设备注册离线推送——在手机上打开 DeepPilot 并允许系统通知，等状态变为「已就绪」后再试',
        results: [],
      }
    }
    const send = await this.senderFor(resolved.value)
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
        name: deviceDisplayName(device),
        environment: registration.environment,
        outcome,
        // 前 10 位十六进制让运维能核对存储的 token 与设备当前持有的一致
        // （重装会轮换 token）。
        tokenFingerprint: registration.token.slice(0, 10),
        ...(reason !== undefined ? { reason } : {}),
      }
    }))
    const overall: PushTestResult['overall'] = results.some((r) => r.outcome === 'sent') ? 'sent' : 'failed'
    this.deps.log('push self-test: ' + overall + ' (' + results.map((r) => `"${r.name}"=${r.outcome}${r.reason ? '/' + r.reason : ''}`).join(', ') + ')')
    return { transport: resolved.value.kind, overall, results }
  }

  /** 设置页中继自测：健康检查 + 注册往返，成功即完成一次注册。 */
  async relayTest(): Promise<RelayTestResult> {
    const push = this.deps.config().push ?? {}
    const configured = push.provider ?? 'none'
    const effective = configured === 'none' && this.enrollmentCell.autoRelay === true ? 'relay' : configured
    if (effective !== 'relay') {
      return {
        url: '',
        overall: 'failed',
        tokenIssued: false,
        steps: [{ id: 'health', ok: false, message: `当前推送模式不是中继（provider=${configured}）。启用方式二选一：① 零配置——在 ios/project.yml 填写 DSPushEnrollKey（与服务器 RELAY_ENROLL_KEY 一致）并重新安装 App，打开 App 即自动启用；② 手动——将 push.provider 设为 relay 并填入 relayToken` }],
      }
    }
    const url = this.relayUrl()
    if (!/^https:\/\//i.test(url)) {
      return {
        url,
        overall: 'failed',
        tokenIssued: false,
        steps: [{ id: 'health', ok: false, message: 'relayUrl 必须是 https 地址：注册请求携带共享密钥，明文 HTTP 会把它暴露给链路上的任何节点' }],
      }
    }
    // 注册步骤需要一个身份：现在铸造，于是一次成功的自测同时就是一次完成的注册。
    if (!this.enrollmentCell.clientId && this.enrollmentCell.enrollKey) {
      this.enrollmentCell.clientId = 'u_' + randomBytes(16).toString('base64url')
      this.persistEnrollment()
    }
    return await runRelayProbe({
      url,
      clientId: this.enrollmentCell.clientId,
      enrollKey: this.enrollmentCell.enrollKey,
      manualToken: Boolean((push.relayToken ?? '').trim()),
      ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
      onEnrolled: (token) => {
        this.enrollmentCell.token = token
        this.persistEnrollment()
        this.deps.log('push relay enrollment succeeded (via settings self-test)')
      },
    })
  }

  // ---------- 内部：配置解析 / 注册 / sender ----------

  private relayUrl(): string {
    return (this.deps.config().push?.relayUrl ?? '').trim() || DEFAULT_RELAY_URL
  }

  private resolvePushConfig(config: Config):
    | { ok: true; value: PushConfigSnapshot }
    | { ok: false; reason: string } {
    const push = config.push ?? {}
    // 已注册的分布式 App 在用户没有显式选择时自动启用中继模式。
    const configured = push.provider ?? 'none'
    const effectiveProvider = configured === 'none' && this.enrollmentCell.autoRelay === true ? 'relay' : configured
    if (effectiveProvider === 'relay') {
      const url = this.relayUrl()
      const token = (push.relayToken ?? '').trim() || this.enrollmentCell.token || ''
      if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'relayUrl must be an https URL' }
      if (!token) return { ok: false, reason: 'relay token not enrolled yet' }
      return { ok: true, value: { kind: 'relay', url, token } }
    }
    if (effectiveProvider === 'apns') {
      const teamId = (push.teamId ?? '').trim()
      const keyId = (push.keyId ?? '').trim()
      const keyPath = expandHome((push.keyPath ?? '').trim() || join(this.deps.dataDir, 'apns', 'AuthKey.p8'))
      const bundleId = (push.bundleId ?? '').trim()
      if (!teamId || !keyId || !bundleId) return { ok: false, reason: 'teamId/keyId/bundleId missing' }
      return { ok: true, value: { kind: 'apns', teamId, keyId, keyPath, bundleId } }
    }
    return { ok: false, reason: 'provider disabled' }
  }

  /**
   * 对运营方中继做零配置注册。幂等且结果缓存在持久化单元里；一次失败只留
   * 一行日志，直到配置指纹变化。
   */
  private async ensureRelayEnrolled(url: string): Promise<string | undefined> {
    // 注册体携带分发方的共享钥匙；配置错的 http:// relayUrl 绝不能让它明文
    // 泄露。（发送路径的请求已由 resolvePushConfig 把门，注册调用点没有。）
    if (!/^https:\/\//i.test(url.trim())) {
      this.deps.log('push relay enrollment refused: relayUrl must be an https URL')
      return undefined
    }
    if (this.enrollmentCell.token) return this.enrollmentCell.token
    const fingerprint = url + ':' + String(this.enrollmentCell.enrollKey ?? '')
    if (fingerprint !== this.enrollAttemptFor) {
      this.enrollAttemptFor = fingerprint
      this.enrollLastAttemptAt = 0
    }
    // 同一指纹反复失败：节流到一分钟一次，宕机的中继不会把每次通知变成一次
    // 外呼风暴，同时瞬时故障仍能快速恢复。
    if (Date.now() - this.enrollLastAttemptAt < ENROLL_RETRY_MS) return undefined
    this.enrollLastAttemptAt = Date.now()
    try {
      if (!this.enrollmentCell.clientId) {
        this.enrollmentCell.clientId = 'u_' + randomBytes(16).toString('base64url')
        this.persistEnrollment()
      }
      const client = new RelayClient({ url, debug: this.deps.config().diagnostics?.debug === true, log: this.deps.log })
      const token = await client.enroll(this.enrollmentCell.clientId, this.enrollmentCell.enrollKey ?? '')
      if (!token) {
        this.deps.log('push relay enrollment failed (' + url + '); will retry on next trigger')
        return undefined
      }
      this.enrollmentCell.token = token
      this.persistEnrollment()
      this.deps.log('push relay enrollment succeeded')
      return token
    } catch (error) {
      this.deps.log('push relay enrollment error: ' + String(error))
      return undefined
    }
  }

  /**
   * 按当前配置惰性构建 sender。坏配置（读不到的 .p8）只让该指纹失效并留
   * 一行日志，而不是每个事件都失败。
   */
  private async senderFor(resolved: PushConfigSnapshot): Promise<PushSender | undefined> {
    const fingerprint = JSON.stringify(resolved)
    if (this.cachedSender?.fingerprint === fingerprint) return this.cachedSender.send
    // 最近的失败只在短窗口内阻止重试：长期坏配置不能把每个事件都变成日志风暴，
    // 但同一配置在密钥文件补放之后 MUST 再获得一次机会。
    if (
      this.senderFailedFor?.fingerprint === fingerprint &&
      Date.now() - this.senderFailedFor.at < SENDER_FAILURE_RETRY_MS
    ) {
      return undefined
    }
    if (this.cachedSender) {
      await this.cachedSender.dispose?.().catch(() => {})
      this.cachedSender = undefined
    }
    if (resolved.kind === 'relay') {
      // resolvePushConfig 已保证单元里存在 token（配置 token 或已完成的注册）。
      const client = new RelayClient({
        url: resolved.url,
        token: resolved.token,
        debug: this.deps.config().diagnostics?.debug === true,
        log: this.deps.log,
      })
      this.cachedSender = {
        fingerprint,
        send: (request) => client.send(request),
      }
      this.deps.log('push relay enabled')
    } else {
      try {
        await readFile(expandHome(resolved.keyPath), 'utf8')
      } catch (error) {
        this.senderFailedFor = { fingerprint, at: Date.now() }
        this.deps.log('apns push unavailable (key unreadable at ' + resolved.keyPath + '): ' + String(error))
        return undefined
      }
      const client = new ApnsClient({
        teamId: resolved.teamId,
        keyId: resolved.keyId,
        keyPath: resolved.keyPath,
        bundleId: resolved.bundleId,
        debug: this.deps.config().diagnostics?.debug === true,
        log: this.deps.log,
      })
      this.cachedSender = {
        fingerprint,
        send: (request) => client.send({
          ...request.notification,
          deviceToken: request.deviceToken,
          environment: request.environment,
        }),
        dispose: () => client.dispose(),
      }
      this.deps.log('apns push enabled')
    }
    this.senderFailedFor = undefined
    return this.cachedSender.send
  }

  /**
   * 小组件总览推送：令牌新鲜、三项 scope 齐全、7 天内的设备，按环境去重后
   * 各投一次；中继拒绝凭据时自愈。
   */
  private async flushWidgetPushes(): Promise<void> {
    if (!this.deps.enabledNow()) return
    const resolved = this.resolvePushConfig(this.deps.config())
    if (!resolved.ok) return
    const devices = this.deps.devices()
    const send = await this.senderFor(resolved.value)
    if (!devices || !send) return
    const sent = new Set<string>()
    for (const device of devices.list()) {
      const registration = device.widgetApns
      if (!registration || device.revokedAt !== undefined ||
          !(['notifications.register', 'sessions.read', 'interactions.respond'] as const).every((scope) =>
            device.scopes?.includes(scope)) ||
          Date.now() - registration.updatedAt > 7 * 24 * 60 * 60 * 1000) continue
      const key = registration.environment + ':' + registration.token
      if (sent.has(key)) continue
      sent.add(key)
      const { outcome, reason } = await send({
        deviceToken: registration.token, environment: registration.environment,
        notification: { kind: 'widget' },
      })
      if (shouldPrunePushToken(outcome, reason)) {
        devices.clearWidgetPushToken(device.deviceId, registration.token)
      }
      if (resolved.value.kind === 'relay' && reason === 'HTTP 401') {
        await this.healRelayCredential(resolved.value.url, resolved.value.token)
      }
    }
  }

  /** Live Activity 推送：与 alert 推送共用 sender 与自愈。 */
  private async sendLiveActivity(
    deviceToken: string,
    environment: ApnsEnvironment,
    notification: PushDelivery,
  ): Promise<SendOutcome> {
    if (!this.deps.enabledNow()) return { outcome: 'failed' }
    const resolved = this.resolvePushConfig(this.deps.config())
    if (!resolved.ok) return { outcome: 'failed' }
    const send = await this.senderFor(resolved.value)
    if (!send) return { outcome: 'failed' }
    const result = await send({ deviceToken, environment, notification })
    if (resolved.value.kind === 'relay' && result.reason === 'HTTP 401') {
      await this.healRelayCredential(resolved.value.url, resolved.value.token)
    }
    return result
  }

  /**
   * 401 自愈（原先是三份拷贝：widget / liveActivity / fanOut）。
   * 中继不再认这个凭据：丢掉它，从 enroll key 重新派生。节流由
   * ensureRelayEnrolled 自己负责，并行 401 不会打爆端点。
   */
  private async healRelayCredential(
    url: string,
    token: string | undefined,
    logLine?: string,
  ): Promise<void> {
    if (token === undefined || this.enrollmentCell.token !== token) return
    if (!this.enrollmentCell.enrollKey) return
    this.enrollmentCell.token = undefined
    this.persistEnrollment()
    if (logLine !== undefined) this.deps.log(logLine)
    await this.ensureRelayEnrolled(url)
  }
}
