/**
 * apply() 可观测面的基线快照（重构安全网）。
 *
 * 两种模式：
 *  - `RECORD=1 npx tsx --test tests/apply-baseline.test.ts`：按当前实现跑一遍，
 *    把结果写进 tests/apply-baseline.snapshot.json；
 *  - 默认：读快照逐项深比对，任何行为改变都必须是一次显式的 diff。
 *
 * 记录口径：只记「PushGateway / TransportReconciler 提取必须保持不变」的面——
 * report 快照的字段与取值、两个自测的结果形状（含 https 门拒绝 http 中继的
 * 理由）、配对授权形状、配置改动后的传输 phase 迁移、传输迁移的诊断日志行、
 * 数据平面与 Typert 贡献面是否真的起来、卸载后果。
 *
 * 硬约束由 tests/apply-harness.ts 保证：不碰网络（node:https.request 与全局
 * fetch 在测试期间是离线桩）、不绑固定端口（LAN 端口由 reserveEphemeralPort()
 * 向内核要）、不 spawn 进程（Funnel 场景的 remote.helperPath 指向一个必然不存在
 * 的路径，RemoteSupervisor 的 candidates 只有一项、access() 失败，phase 停在
 * unavailable）。
 *
 * 易变量一律归一化：临时目录 → <dataDir>、IPv4 → <lanIp>、`:port` → `:<port>`、
 * 13 位纪元毫秒 → <ts>、`sha256:` 指纹 → <fingerprint>、helper 绝对路径 → <path>；
 * 集合类只保留「元素形态」不保留个数（CI 与开发机的网卡不同）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootApply, isNetworkGateInstalled, reserveEphemeralPort, type ApplyHarness } from './apply-harness.ts'

const SNAPSHOT = new URL('./apply-baseline.snapshot.json', import.meta.url)
const RECORD = process.env.RECORD === '1'

interface NormalizeOptions {
  dataDir: string
  /** Funnel 场景里那个必然不存在的 helper 路径。 */
  helperPath?: string
  /** local.port 在 LAN 启用后是内核临时端口，必须遮掉。 */
  maskPort?: boolean
}

/** 通用归一化：路径、TLS 指纹、LAN 地址、URL 里的端口。 */
function normalize(value: unknown, opts: NormalizeOptions): unknown {
  if (typeof value === 'number') {
    // 13 位纪元毫秒一律归一化；端口、计数器、协议版本号保持原样。
    return Number.isInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000 ? '<ts>' : value
  }
  if (typeof value === 'string') {
    let out = value
    if (opts.helperPath !== undefined) out = out.split(opts.helperPath).join('<path>')
    if (opts.dataDir.length > 0) out = out.split(opts.dataDir).join('<dataDir>')
    return out
      .replace(/sha256:[A-Za-z0-9_-]+/g, '<fingerprint>')
      .replaceAll('0.0.0.0', '<bind>')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<lanIp>')
      .replace(/(:\d{2,5})\b/g, ':<port>')
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, opts))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'port' && opts.maskPort === true) out[key] = '<port>'
      else if (key === 'tlsFingerprint') out[key] = '<fingerprint>'
      // 网卡数量随机器而变（CI 上可能是 0 张私网网卡）；只保留「有没有」这个信息，
      // 这样快照在开发机与 CI 之间也逐字节一致。
      else if (key === 'lanAddresses' && Array.isArray(item)) out[key] = item.length === 0 ? [] : ['<lanIp>']
      else if (key === 'endpoints' && Array.isArray(item)) out[key] = item.length === 0 ? [] : ['<endpoint>']
      else out[key] = normalize(item, opts)
    }
    return out
  }
  return value
}

/** 值的 JSON 形态，用于固化「哪些字段存在、是什么类型」。 */
function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 传输迁移的日志行：只认相位变化，别的（设备注册表、数据平面）与主题无关。 */
const TRANSPORT_LOG_MARKERS = [
  'local transport',
  'remote Funnel',
  'LAN TLS identity',
]

function transportLogs(logs: readonly string[]): string[] {
  return logs.filter((line) => TRANSPORT_LOG_MARKERS.some((marker) => line.includes(marker)))
}

/** report.local 段小结：phase / 端口 / 端点形态 / TLS 指纹是否存在。 */
function summarizeLocal(local: any, maskPort: boolean): Record<string, unknown> {
  const endpoints = local.endpoints as string[]
  return {
    phase: local.phase,
    port: maskPort ? '<port>' : local.port,
    endpoints: endpoints.length === 0 ? [] : ['<endpoint>'],
    endpointsEveryEntryIsHttpsUrl: endpoints.every(
      // 先归一化再比：原串里的 LAN IP 与临时端口对每台机器、每次运行都不同。
      (entry: string) => /^https:\/\/<lanIp>:<port>$/.test(normalize(entry, { dataDir: '' }) as string),
    ),
    // 可选字段只在存在时入镜：JSON 序列化会丢掉 undefined，两边口径必须一致。
    ...(local.tlsFingerprint === undefined ? {} : { tlsFingerprint: '<fingerprint>' }),
    tlsIdentityRegenerated: local.tlsIdentityRegenerated === true,
    ...(local.message === undefined ? {} : { message: '<message>' }),
    updatedAt: '<ts>',
  }
}

/** report.remote 段小结：enabled=false 时必须停在 disabled 且不产生 URL。 */
function summarizeRemote(remote: any): Record<string, unknown> {
  return {
    provider: remote.provider,
    phase: remote.phase,
    ...(remote.publicURL === undefined ? {} : { publicURL: '<url>' }),
    ...(remote.authURL === undefined ? {} : { authURL: '<url>' }),
    ...(remote.message === undefined ? {} : { message: '<message>' }),
    updatedAt: '<ts>',
  }
}

interface ApplyBaseline {
  snapshot: unknown
  reportFieldTypes: Record<string, string>
  dataDirIsolation: boolean
  relayTestNotRelay: unknown
  pushTestDisabled: unknown
  pushTestHttpRelay: unknown
  relayTestHttpRelay: unknown
  pairingShape: string[]
  snapshotAfterLocalEnabled: unknown
  localSummaryAfterEnabled: Record<string, unknown>
  idleVolatileUpdateKeepsLocalOnline: boolean
  snapshotAfterRemoteEnabled: unknown
  remoteSummaryAfterEnabled: Record<string, unknown>
  mergeSemanticsProbe: Record<string, unknown>
  transportLogs: string[]
  updateCheckBlockedOffline: boolean
  updateFieldsAbsentInReport: boolean
  surfaces: Record<string, unknown>
  dispose: Record<string, unknown>
}

/** 有界轮询：等某个可观测事实成立，超时即失败（而不是把偶发的 false 记进快照）。 */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function recordBaseline(): Promise<ApplyBaseline> {
  const previousHome = process.env.DSH_HOME
  const harness = await bootApply()
  const dataDir = harness.dataDir
  try {
    await harness.settle(30)
    // 等数据平面真的起来再取数：会话列表刷新、workspace 跟随流、常驻 DSH Client
    // 打开 Remote Events 流。慢机器上这些是毫秒级异步，未就绪就记录会把偶发的
    // false 固化成快照。
    await waitFor(() => harness.recorder.sessionListCalls >= 1, 'sessions.list at boot')
    await waitFor(() => harness.recorder.workspaceFollowOpened, 'workspace follow stream')
    await waitFor(
      () => harness.recorder.sharedFetchHandlerCreated
        && harness.recorder.wireStreamOpened
        && harness.recorder.wireStreamReadyYielded,
      'resident DSH Client',
    )

    // ---- 1. 启动即景：完整 report 快照 ----
    const snapshot = await harness.report() as any
    const dataDirIsolation = String(snapshot.identityPath).startsWith(dataDir)
    const reportFieldTypes = Object.fromEntries(
      Object.entries(snapshot).map(([key, value]) => [key, jsonType(value)]),
    )

    // ---- 2. 两个自测在 provider=none 下的确定回答 ----
    const relayTestNotRelay = await harness.testRelay()
    const pushTestDisabled = await harness.testPush()

    // ---- 3. 配对授权：只记字段形状（code / audience 是随机值）----
    const pairing = await harness.beginPairing() as any
    const pairingShape = Object.keys(pairing).sort()

    // ---- 4. 配置序列之一：http 中继必须被 https 门拒掉（发请求前就拒）----
    harness.setConfig({ push: { provider: 'relay', relayUrl: 'http://insecure.example', relayToken: '' } })
    const pushTestHttpRelay = await harness.testPush()
    const relayTestHttpRelay = await harness.testRelay()
    harness.setConfig({ push: { provider: 'none' } })

    // ---- 5. 配置序列之二：LAN 监听启用（内核临时端口）应走到 online ----
    const ephemeralPort = await reserveEphemeralPort()
    harness.setConfig({ local: { enabled: true, port: ephemeralPort } })
    await harness.waitForLocal((phase) => phase === 'online' || phase === 'error')
    const snapshotAfterLocalEnabled = await harness.report() as any
    assert.equal(snapshotAfterLocalEnabled.local.phase, 'online', 'LAN 传输必须走到 online')
    const localSummaryAfterEnabled = summarizeLocal(snapshotAfterLocalEnabled.local, true)
    // 无配置变化的 volatile-update 不得重开监听。注意**不能**比 updatedAt：
    // TransportReconciler 的 statusOf() 在每次查询时现算 Date.now()，LAN 的
    // updatedAt 语义已经从「最后一次迁移的时刻」变成「被查询的时刻」，两次读
    // 必然不同。真正要钉住的是「稳定字段不变 + 没有新的监听日志」。
    const transportLogsBeforeIdle = transportLogs(harness.logs)
    harness.volatileUpdate()
    await harness.settle(60)
    const snapshotAfterIdleUpdate = await harness.report() as any
    const idleVolatileUpdateKeepsLocalOnline = JSON.stringify(summarizeLocal(snapshotAfterIdleUpdate.local, true))
      === JSON.stringify(localSummaryAfterEnabled)
      && transportLogs(harness.logs).length === transportLogsBeforeIdle.length

    // ---- 6. 配置序列之三：Funnel 启用 + 不存在的 helperPath ----
    // helperPath 指向 dataDir 下一个必然不存在的文件：RemoteSupervisor.start()
    // 的 candidates 只有一项、access() 失败，于是 phase 停在 unavailable，而且
    // 永远走不到 spawn。若这里不设 helperPath，start() 会去找 bin/<platform>/
    // dsh-deeppilot-tunnel 并把它 spawn 起来。
    const missingHelperPath = join(dataDir, 'definitely-missing-tunnel-helper')
    harness.setConfig({ remote: { enabled: true, helperPath: missingHelperPath } })
    await harness.waitForRemote((phase) => phase === 'unavailable' || phase === 'error' || phase === 'stopped')
    const snapshotAfterRemoteEnabled = await harness.report() as any
    assert.equal(snapshotAfterRemoteEnabled.remote.phase, 'unavailable', 'Funnel 无 helper 时必须停在 unavailable')
    // remote 段没有端口字段，message 一律哨兵化（内容见 transportLogs 里的原文）。
    const remoteSummaryAfterEnabled = summarizeRemote(snapshotAfterRemoteEnabled.remote)

    // ---- 7. setConfig 合并语义探针 ----
    // 曾经的浅 Object.assign 会整段替换 remote，导致 provider 丢失、Funnel 场景
    // 静默 no-op。这里直接读 apply() 的生效配置，确认 sibling 字段都还在。
    const effective = harness.currentConfig() as any
    const mergeSemanticsProbe = {
      remoteProviderRetained: effective.remote.provider,
      remoteEnabledRetained: effective.remote.enabled,
      remoteHostnameRetained: effective.remote.hostname,
      localEnabledRetained: effective.local.enabled,
      localPortRetained: typeof effective.local.port === 'number',
      pushProviderRetained: effective.push.provider,
      pushRelayUrlRetained: effective.push.relayUrl,
      devicesPathUnderDataDir: String(effective.devicesPath).startsWith(dataDir),
    }

    // ---- 8. 离线闸门真的挡下过一次外连（不等同于「没报错」）----
    // UpdateChecker 启动 2 秒后才打 GitHub，所以在收尾前等它被打断。
    await waitFor(() => harness.network.blockedHttpsRequests >= 1, 'offline https stub blocks the background update check')
    const updateCheckBlockedOffline = harness.network.blockedHttpsRequests >= 1
    const updateFieldsAbsentInReport = !('updateAvailable' in snapshotAfterRemoteEnabled)
      && !('releaseUrl' in snapshotAfterRemoteEnabled)

    // ---- 9. 卸载后的可观测后果 ----
    const contribution = harness.recorder.typertContributions[0] as any
    const logs = transportLogs(harness.logs)
    await harness.dispose()

    return {
      snapshot: normalize(snapshot, { dataDir }),
      reportFieldTypes,
      dataDirIsolation,
      relayTestNotRelay,
      pushTestDisabled,
      pushTestHttpRelay,
      relayTestHttpRelay,
      pairingShape,
      snapshotAfterLocalEnabled: normalize(snapshotAfterLocalEnabled, { dataDir, maskPort: true }),
      localSummaryAfterEnabled,
      idleVolatileUpdateKeepsLocalOnline,
      snapshotAfterRemoteEnabled: normalize(snapshotAfterRemoteEnabled, {
        dataDir,
        helperPath: missingHelperPath,
        maskPort: true,
      }),
      remoteSummaryAfterEnabled,
      mergeSemanticsProbe,
      transportLogs: logs.map((line) => normalize(line, { dataDir, helperPath: missingHelperPath }) as string),
      updateCheckBlockedOffline,
      updateFieldsAbsentInReport,
      surfaces: {
        dataPlaneActive: harness.logs.some((line) => line.includes('data plane active')),
        residentClientStarted: harness.recorder.sharedFetchHandlerCreated
          && harness.recorder.wireStreamOpened
          && harness.recorder.wireStreamReadyYielded,
        sessionListStarted: harness.recorder.sessionListCalls >= 1,
        workspaceFollowOpened: harness.recorder.workspaceFollowOpened,
        typertContributionRegistered: contribution !== undefined,
        typertInvocations: ((contribution?.invocations ?? []) as Array<{ id: string }>).map((item) => item.id),
      },
      dispose: {
        typertUnregisterCalls: harness.recorder.typertUnregisterCalls,
        dshHomeRestored: process.env.DSH_HOME === previousHome,
        tempDirRemoved: !existsSync(dataDir),
        networkGateRestored: !isNetworkGateInstalled(),
      },
    }
  } finally {
    await harness.dispose()
  }
}

test('apply() 可观测面与基线快照一致', async (t) => {
  const actual = await recordBaseline()

  if (RECORD || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + '\n')
    t.diagnostic('apply baseline written to tests/apply-baseline.snapshot.json')
    return
  }

  const expected = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as ApplyBaseline
  await t.test('启动即景（完整 report 快照与字段形态）', () => {
    assert.deepEqual(actual.snapshot, expected.snapshot)
    assert.deepEqual(actual.reportFieldTypes, expected.reportFieldTypes)
    assert.equal(actual.dataDirIsolation, expected.dataDirIsolation)
  })
  await t.test('provider=none 的两个自测', () => {
    assert.deepEqual(actual.relayTestNotRelay, expected.relayTestNotRelay)
    assert.deepEqual(actual.pushTestDisabled, expected.pushTestDisabled)
  })
  await t.test('http 中继被 https 门拒绝（零网络路径）', () => {
    assert.deepEqual(actual.pushTestHttpRelay, expected.pushTestHttpRelay)
    assert.deepEqual(actual.relayTestHttpRelay, expected.relayTestHttpRelay)
  })
  await t.test('配对授权形状', () => assert.deepEqual(actual.pairingShape, expected.pairingShape))
  await t.test('启用 LAN 后走到 online', () => {
    assert.deepEqual(actual.snapshotAfterLocalEnabled, expected.snapshotAfterLocalEnabled)
    assert.deepEqual(actual.localSummaryAfterEnabled, expected.localSummaryAfterEnabled)
    assert.equal(actual.idleVolatileUpdateKeepsLocalOnline, expected.idleVolatileUpdateKeepsLocalOnline)
  })
  await t.test('启用 Funnel（无 helper）后走到 unavailable', () => {
    assert.deepEqual(actual.snapshotAfterRemoteEnabled, expected.snapshotAfterRemoteEnabled)
    assert.deepEqual(actual.remoteSummaryAfterEnabled, expected.remoteSummaryAfterEnabled)
  })
  await t.test('setConfig 合并语义：sibling 字段不丢', () => {
    assert.deepEqual(actual.mergeSemanticsProbe, expected.mergeSemanticsProbe)
  })
  await t.test('传输迁移的诊断日志行', () => {
    assert.deepEqual(actual.transportLogs, expected.transportLogs)
  })
  await t.test('离线闸门生效、更新字段不出现', () => {
    assert.equal(actual.updateCheckBlockedOffline, expected.updateCheckBlockedOffline)
    assert.equal(actual.updateFieldsAbsentInReport, expected.updateFieldsAbsentInReport)
  })
  await t.test('数据平面、Typert 贡献面与卸载后果', () => {
    assert.deepEqual(actual.surfaces, expected.surfaces)
    assert.deepEqual(actual.dispose, expected.dispose)
  })
})
