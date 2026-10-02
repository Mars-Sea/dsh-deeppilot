/**
 * apply() 可观测面的基线快照（重构安全网）。
 *
 * 两种模式：
 *  - `RECORD=1 npx tsx --test tests/apply-baseline.test.ts`：按当前实现跑一遍，
 *    把结果写进 tests/apply-baseline.snapshot.json；
 *  - 默认：读快照逐项深比对，任何行为改变都必须是一次显式的 diff。
 *
 * 记录口径：只记"重构必须保持不变"的面——report 快照的字段与取值、两个自测的
 * 结果结构（含 https 门拒绝 http 中继的理由）、配对授权形状、配置改动后的传输
 * phase 迁移、Typert 贡献描述符、数据平面是否真的起来。易变量一律归一化：
 * 临时路径 → <dataDir>、时间戳 → <ts>、端口 → <port>、TLS 指纹 → <tlsFingerprint>、
 * LAN 地址 → <lanIp>；集合类只保留"元素形态"不保留个数（CI 与开发机的网卡不同）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootApply, reserveEphemeralPort, type ApplyHarness } from './apply-harness.ts'

const SNAPSHOT = new URL('./apply-baseline.snapshot.json', import.meta.url)
const RECORD = process.env.RECORD === '1'

/** 时间戳字段：一律归一化，避免快照依赖运行时刻。 */
const TIMESTAMP_KEYS = new Set(['updatedAt', 'expiresAt', 'firstSeenTs', 'lastSeenTs', 'ts', 'notAfter'])

/** 把集合归一成"元素形态"哨兵集合：个数无关，形状可断。 */
function sentinelSet(values: readonly unknown[], marker: string): string[] {
  return [...new Set(values.map(() => marker))]
}

/** 通用归一化：路径、时间戳、TLS 指纹、LAN 地址、URL 里的端口。 */
function normalize(value: unknown, dataDir: string): unknown {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1_000_000_000_000 && value < 10_000_000_000_000 ? '<ts>' : value
  }
  if (typeof value === 'string') {
    let out = value
    if (dataDir.length > 0) out = out.split(dataDir).join('<dataDir>')
    return out
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<lanIp>')
      .replace(/(:\d{2,5})\b/g, ':<port>')
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, dataDir))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (TIMESTAMP_KEYS.has(key)) out[key] = '<ts>'
      else if (key === 'tlsFingerprint') out[key] = '<tlsFingerprint>'
      else out[key] = normalize(item, dataDir)
    }
    return out
  }
  return value
}

/** 值的 JSON 形态，用于固化"哪些字段存在、是什么类型"。 */
function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** report.local 段小结：phase / 端口 / 端点形态 / TLS 指纹是否存在。 */
function summarizeLocal(local: any, maskPort: boolean): Record<string, unknown> {
  const endpoints = local.endpoints as string[]
  return {
    phase: local.phase,
    port: maskPort ? '<port>' : local.port,
    endpoints: sentinelSet(endpoints, '<endpoint>'),
    endpointsEveryEntryIsHttpsUrl: endpoints.every((entry) => /^https:\/\/<lanIp>:<port>$/.test(normalize(entry, '') as string)),
    // 可选字段只在存在时入镜：JSON 序列化会丢掉 undefined，两边口径必须一致。
    ...(local.tlsFingerprint === undefined ? {} : { tlsFingerprint: '<tlsFingerprint>' }),
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
    updatedAt: '<ts>',
  }
}

interface ApplyBaseline {
  boot: {
    options: Record<string, unknown>
    dataDirIsolation: boolean
    report: unknown
    reportFieldTypes: Record<string, string>
    local: Record<string, unknown>
    remote: Record<string, unknown>
    relayTestNotRelay: unknown
    pushTestNotConfigured: unknown
    pairing: {
      keys: string[]
      codeLength: number
      codeIsBase64Url: boolean
      audienceMatchesPattern: boolean
      expiresInSeconds: number
    }
  }
  configSequence: {
    pushRelayHttp: {
      reportUnchangedOutsideTimestamps: boolean
      pushTest: unknown
      relayTest: unknown
    }
    localEnabled: {
      local: Record<string, unknown>
      idleVolatileUpdateKeepsLocalOnline: boolean
    }
  }
  surfaces: {
    dataPlaneActive: boolean
    residentClientStarted: boolean
    sessionListCallsAtBoot: number
    workspaceFollowOpened: boolean
    effectCleanupsRegistered: number
    updateFieldsAbsentInReport: boolean
    typertContribution: {
      package: string
      face: string
      serviceCount: number
      invocationIds: string[]
    }
    logSignals: {
      dataPlaneActive: boolean
      localDisabled: boolean
      deviceRegistryLoaded: boolean
    }
  }
  dispose: {
    typertUnregisterCalls: number
    dshHomeRestored: boolean
    tempDirRemoved: boolean
  }
}

function effectCleanupsRegistered(harness: ApplyHarness): number {
  const own = harness.ctx.effects.filter((record) => typeof record.cleanup === 'function').length
  const sub = harness.ctx.subContexts
    .flatMap((subCtx) => subCtx.effects)
    .filter((record) => typeof record.cleanup === 'function').length
  return own + sub
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
    const sessionListCallsAtBoot = harness.recorder.sessionListCalls

    // ---- 1. 启动即景 ----
    const bootReport = await harness.report() as any
    const dataDirIsolation = String(bootReport.identityPath).startsWith(dataDir)
    const localSummary = summarizeLocal(bootReport.local, false)
    const remoteSummary = summarizeRemote(bootReport.remote)

    // ---- 2. 两个自测在 provider=none 下的确定回答 ----
    const relayTestNotRelay = await harness.testRelay()
    const pushTestNotConfigured = await harness.testPush()

    // ---- 3. 配对授权：形状 + 派生事实（code/audience 是随机值，只记形态）----
    const pairing = await harness.beginPairing() as any
    const pairingFacts = {
      keys: Object.keys(pairing).sort(),
      codeLength: String(pairing.code).length,
      codeIsBase64Url: /^[A-Za-z0-9_-]{32}$/.test(String(pairing.code)),
      audienceMatchesPattern: /^deeppilot:[A-Za-z0-9_-]{22}$/.test(String(pairing.audience)),
      expiresInSeconds: Math.round((Number(pairing.expiresAt) - Date.now()) / 1000),
    }

    // ---- 4. 配置序列之一：http 中继必须被 https 门拒掉 ----
    harness.setConfig({ push: { provider: 'relay', relayUrl: 'http://insecure.example', relayToken: '' } })
    const pushTestHttpRelay = await harness.testPush()
    const relayTestHttpRelay = await harness.testRelay()
    const reportAfterPushConfig = await harness.report() as any
    const reportUnchangedOutsideTimestamps = JSON.stringify(normalize(bootReport, dataDir))
      === JSON.stringify(normalize(reportAfterPushConfig, dataDir))
    harness.setConfig({ push: { provider: 'none' } })

    // ---- 5. 配置序列之二：LAN 监听启用（临时端口）应走到 online ----
    const ephemeralPort = await reserveEphemeralPort()
    harness.setConfig({ local: { enabled: true, port: ephemeralPort } })
    await harness.waitForLocal((phase) => phase === 'online' || phase === 'error')
    const reportAfterLocal = await harness.report() as any
    const localEnabled = summarizeLocal(reportAfterLocal.local, true)
    // 无配置变化的 volatile-update 不得重开监听：phase 与 updatedAt 都不动。
    harness.volatileUpdate()
    await harness.settle(60)
    const reportAfterIdleUpdate = await harness.report() as any
    const idleVolatileUpdateKeepsLocalOnline = JSON.stringify(localEnabled)
      === JSON.stringify(summarizeLocal(reportAfterIdleUpdate.local, true))

    const contribution = harness.recorder.typertContributions[0] as any
    const effectCount = effectCleanupsRegistered(harness)
    const updateFieldsAbsentInReport = !('updateAvailable' in bootReport) && !('releaseUrl' in bootReport)

    // ---- 6. 收尾：卸载后的可观测后果 ----
    await harness.dispose()
    return {
      boot: {
        options: {
          enabled: true,
          local: { enabled: false },
          remote: { enabled: false },
          push: { provider: 'none' },
        },
        dataDirIsolation,
        report: normalize(bootReport, dataDir),
        reportFieldTypes: Object.fromEntries(Object.entries(bootReport).map(([key, value]) => [key, jsonType(value)])),
        local: localSummary,
        remote: remoteSummary,
        relayTestNotRelay,
        pushTestNotConfigured,
        pairing: pairingFacts,
      },
      configSequence: {
        pushRelayHttp: {
          reportUnchangedOutsideTimestamps,
          pushTest: pushTestHttpRelay,
          relayTest: relayTestHttpRelay,
        },
        localEnabled: {
          local: localEnabled,
          idleVolatileUpdateKeepsLocalOnline,
        },
      },
      surfaces: {
        dataPlaneActive: harness.logs.some((line) => line.includes('data plane active')),
        residentClientStarted: harness.recorder.sharedFetchHandlerCreated
          && harness.recorder.wireStreamOpened
          && harness.recorder.wireStreamReadyYielded,
        sessionListCallsAtBoot,
        workspaceFollowOpened: harness.recorder.workspaceFollowOpened,
        effectCleanupsRegistered: effectCount,
        updateFieldsAbsentInReport,
        typertContribution: {
          package: contribution.package,
          face: contribution.face,
          serviceCount: (contribution.model?.services ?? []).length,
          invocationIds: (contribution.invocations ?? []).map((item: { id: string }) => item.id),
        },
        logSignals: {
          dataPlaneActive: harness.logs.some((line) => line.includes('data plane active')),
          localDisabled: harness.logs.some((line) => line.includes('local transport disabled')),
          deviceRegistryLoaded: harness.logs.some((line) => line.includes('device registry loaded')),
        },
      },
      dispose: {
        typertUnregisterCalls: harness.recorder.typertUnregisterCalls,
        dshHomeRestored: process.env.DSH_HOME === previousHome,
        tempDirRemoved: !existsSync(dataDir),
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
  await t.test('启动即景（report 快照与字段形态）', () => {
    assert.deepEqual(actual.boot.report, expected.boot.report)
    assert.deepEqual(actual.boot.reportFieldTypes, expected.boot.reportFieldTypes)
    assert.deepEqual(actual.boot.local, expected.boot.local)
    assert.deepEqual(actual.boot.remote, expected.boot.remote)
    assert.equal(actual.boot.dataDirIsolation, expected.boot.dataDirIsolation)
  })
  await t.test('provider=none 的两个自测', () => {
    assert.deepEqual(actual.boot.relayTestNotRelay, expected.boot.relayTestNotRelay)
    assert.deepEqual(actual.boot.pushTestNotConfigured, expected.boot.pushTestNotConfigured)
  })
  await t.test('配对授权形状', () => assert.deepEqual(actual.boot.pairing, expected.boot.pairing))
  await t.test('http 中继被 https 门拒绝', () => {
    assert.deepEqual(actual.configSequence.pushRelayHttp, expected.configSequence.pushRelayHttp)
  })
  await t.test('LAN 监听启用后走到 online', () => {
    assert.deepEqual(actual.configSequence.localEnabled, expected.configSequence.localEnabled)
  })
  await t.test('数据平面、Typert 贡献面与卸载后果', () => {
    assert.deepEqual(actual.surfaces, expected.surfaces)
    assert.deepEqual(actual.dispose, expected.dispose)
  })
})
