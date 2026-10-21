/**
 * 连接诊断（src/diagnostics.ts）的直驱单测。
 *
 * 覆盖验收要求里的四件事：4401 分因映射、日志节流、`/phone/health` 新字段、
 * attemptId 解析；另外钉住环形容量、报告 wire 的新字段校验与落盘滚动
 * （按天文件 + 7 天保留 + 5MB 上限），因为它们是「重启后还能查」的保证。
 *
 * 这里不渲染 React、不建 socket：全是纯函数与临时目录，单测可以精确控制
 * 时间（注入 now）与输出（注入 write）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ATTEMPT_ID_HEADER,
  DiagnosticsStore,
  MAX_DIAGNOSTICS_BYTES,
  attemptIdFromRequest,
  buildHealthPayload,
  formatLogLine,
  normalizeAttemptId,
} from '../src/diagnostics.ts'
import { classifyAuthFailure } from '../src/connection-gate.ts'
import { reportSchema } from '../src/report-wire.ts'
import { DeviceStore } from '../src/token.ts'
import { createTestIdentity, registerTestIdentity } from './auth-fixture.ts'

// ---------- 日志行 ----------

test('日志行带 ISO 时间戳与级别', () => {
  const at = Date.parse('2026-10-21T01:02:03.004Z')
  assert.equal(
    formatLogLine('warn', 'hello', at),
    '[deeppilot] 2026-10-21T01:02:03.004Z WARN hello',
  )
  assert.equal(
    formatLogLine('info', 'ok', at),
    '[deeppilot] 2026-10-21T01:02:03.004Z INFO ok',
  )
})

// ---------- 4401 分因 ----------

const CHALLENGE = { nonce: 'nonce-1', audience: 'deeppilot:aud', issuedAt: 1_000, expiresAt: 2_000 }
const MATCHING_PROOF = {
  nonce: CHALLENGE.nonce,
  audience: CHALLENGE.audience,
  issuedAt: CHALLENGE.issuedAt,
  expiresAt: CHALLENGE.expiresAt,
  signature: 'sig',
}

test('4401 分因：未知设备 / 已撤销优先于字段判定', () => {
  assert.equal(classifyAuthFailure({
    device: 'unknown',
    proof: MATCHING_PROOF,
    challenge: CHALLENGE,
    now: 1_500,
  }), 'unknown-device')
  // 已撤销的设备即使 nonce 全对也归 revoked：注册表状态是最终事实。
  assert.equal(classifyAuthFailure({
    device: 'revoked',
    proof: { ...MATCHING_PROOF, nonce: 'other' },
    challenge: CHALLENGE,
    now: 1_500,
  }), 'revoked')
})

test('4401 分因：nonce / audience / 过期 / 时钟偏差 / 坏签名各有其名', () => {
  const base = { device: 'active' as const, challenge: CHALLENGE, now: 1_500 }
  assert.equal(classifyAuthFailure({ ...base, proof: { ...MATCHING_PROOF, nonce: 'n2' } }), 'nonce-mismatch')
  assert.equal(classifyAuthFailure({ ...base, proof: { ...MATCHING_PROOF, audience: 'other' } }), 'audience-mismatch')
  assert.equal(
    classifyAuthFailure({ ...base, proof: MATCHING_PROOF, now: CHALLENGE.expiresAt + 1 }),
    'challenge-expired',
  )
  assert.equal(classifyAuthFailure({ ...base, proof: { ...MATCHING_PROOF, issuedAt: 999 } }), 'clock-skew')
  assert.equal(classifyAuthFailure({ ...base, proof: { ...MATCHING_PROOF, expiresAt: 2_001 } }), 'clock-skew')
  assert.equal(classifyAuthFailure({ ...base, proof: MATCHING_PROOF }), 'bad-signature')
})

// ---------- 节流 ----------

test('同 kind + reason + source 60 秒内只输出一行，恢复时带 suppressed 计数', () => {
  let now = 1_700_000_000_000
  const lines: string[] = []
  const store = new DiagnosticsStore({ now: () => now, write: (line) => lines.push(line) })

  store.record('upgrade-rejected', 'too many connections', { source: 'aaa' })
  store.record('upgrade-rejected', 'too many connections', { source: 'aaa' })
  store.record('upgrade-rejected', 'too many connections', { source: 'aaa' })
  // 不同来源不受彼此节流影响。
  store.record('upgrade-rejected', 'too many connections', { source: 'bbb' })
  assert.equal(lines.length, 2)
  assert.match(lines[0] ?? '', /upgrade-rejected too-many-connections src=aaa/)
  assert.match(lines[1] ?? '', /src=bbb/)

  now += 60_000
  store.record('upgrade-rejected', 'too many connections', { source: 'aaa' })
  assert.equal(lines.length, 3)
  assert.match(lines[2] ?? '', /src=aaa/)
  assert.match(lines[2] ?? '', /suppressed=2/, '恢复输出时标注被压掉的次数')

  // 事件始终进入环形，节流只影响日志行。
  assert.equal(store.recent().length, 5)
})

// ---------- 环形缓冲 ----------

test('环形缓冲按容量淘汰最旧事件，lastFailure 只看失败级别', () => {
  const store = new DiagnosticsStore({ capacity: 3, write: () => {} })
  for (let index = 1; index <= 5; index += 1) {
    store.record('connection-opened', 'try-' + String(index), { level: 'info' })
  }
  assert.deepEqual(store.recent().map((event) => event.reason), ['try-3', 'try-4', 'try-5'])
  assert.equal(store.lastFailure(), undefined, '连接建立是 info，不算失败')

  store.record('auth-failed', 'nonce-mismatch', { closeCode: 4401 })
  assert.equal(store.lastFailure()?.reason, 'nonce-mismatch')
  assert.deepEqual(store.lastFailureSummary(), {
    kind: 'auth-failed',
    reason: 'nonce-mismatch',
    ts: store.recent().at(-1)?.ts,
  })
})

// ---------- attemptId ----------

test('attemptId 只接受 ≤16 位的 [A-Za-z0-9_-]', () => {
  assert.equal(normalizeAttemptId('abc_DEF-123'), 'abc_DEF-123')
  assert.equal(normalizeAttemptId('a'.repeat(16)), 'a'.repeat(16))
  assert.equal(normalizeAttemptId('a'.repeat(17)), undefined, '超长丢弃')
  assert.equal(normalizeAttemptId('has space'), undefined)
  assert.equal(normalizeAttemptId('中文'), undefined)
  assert.equal(normalizeAttemptId(undefined), undefined)
  assert.equal(normalizeAttemptId(42), undefined)
})

test('attemptId 优先取 HTTP header，其次取 WS 升级 query `at`', () => {
  assert.equal(attemptIdFromRequest({ headers: { [ATTEMPT_ID_HEADER]: 'hdr1' }, url: '/phone?at=query1' }), 'hdr1')
  assert.equal(attemptIdFromRequest({ headers: { [ATTEMPT_ID_HEADER]: ['arr1'] } }), 'arr1')
  assert.equal(attemptIdFromRequest({ url: '/phone?at=query1' }), 'query1')
  // header 非法时回退 query：两个来源是补充关系。
  assert.equal(attemptIdFromRequest({ headers: { [ATTEMPT_ID_HEADER]: 'bad id' }, url: '/phone?at=query1' }), 'query1')
  assert.equal(attemptIdFromRequest({ url: '/phone?at=' + 'x'.repeat(20) }), undefined, '不可信输入限长')
  assert.equal(attemptIdFromRequest({ url: '/phone?at=' }), undefined)
  assert.equal(attemptIdFromRequest({}), undefined)
})

// ---------- /phone/health 新字段 ----------

test('health 载荷只加不删：新字段齐全，且不含 debug 与地址候选', () => {
  const payload = buildHealthPayload({
    startedAt: 111,
    enabled: true,
    protocolVersion: 2,
    serverVersion: '0.9.8',
    dataPlaneActive: true,
    localPhase: 'online',
    localPort: 3098,
    tlsIdentityRegenerated: true,
    lastFailure: { kind: 'auth-failed', reason: 'nonce-mismatch', ts: 222 },
  })
  assert.deepEqual(payload, {
    ok: true,
    enabled: true,
    protocolVersion: 2,
    serverVersion: '0.9.8',
    dataPlane: true,
    dataPlanePhase: 'active',
    local: { phase: 'online', port: 3098 },
    tlsRebuilt: true,
    startedAt: 111,
    lastFailure: { kind: 'auth-failed', reason: 'nonce-mismatch', ts: 222 },
  })
  assert.equal('debug' in payload, false, '不向手机暴露 debug 开关')
  assert.equal('lanAddresses' in payload, false, 'health 不返回地址候选')

  const quiet = buildHealthPayload({
    startedAt: 1,
    enabled: false,
    protocolVersion: 2,
    serverVersion: 'x',
    dataPlaneActive: false,
    localPhase: 'disabled',
    localPort: 3098,
    tlsIdentityRegenerated: false,
    lastFailure: undefined,
  })
  assert.equal(quiet.dataPlanePhase, 'inactive')
  assert.equal(quiet.lastFailure, null)
})

// ---------- 落盘 ----------

test('事件按天写 JSONL；超过保留期的旧文件被清理', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-diagnostics-'))
  try {
    const now = Date.parse('2026-10-21T06:00:00.000Z')
    const day = '2026-10-21'
    // 7 天保留期 = 今天 + 前 6 天；10-14 应删，10-15 应留。
    await writeFile(join(dir, 'diagnostics-2026-10-14.jsonl'), '{"old":true}\n')
    await writeFile(join(dir, 'diagnostics-2026-10-15.jsonl'), '{"kept":true}\n')
    await writeFile(join(dir, 'unrelated.txt'), 'ignore me\n')

    const store = new DiagnosticsStore({ dir, now: () => now, write: () => {} })
    store.record('auth-failed', 'nonce-mismatch', {
      source: 'abc123def456',
      attemptId: 'try_1',
      closeCode: 4401,
    })
    await store.flush()

    const text = await readFile(join(dir, `diagnostics-${day}.jsonl`), 'utf8')
    const rows = text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.kind, 'auth-failed')
    assert.equal(rows[0]?.reason, 'nonce-mismatch')
    assert.equal(rows[0]?.attemptId, 'try_1')
    assert.equal(rows[0]?.closeCode, 4401)
    assert.equal(rows[0]?.level, 'warn')

    await assert.rejects(stat(join(dir, 'diagnostics-2026-10-14.jsonl')), '超过 7 天的文件被删除')
    assert.equal((await stat(join(dir, 'diagnostics-2026-10-15.jsonl'))).isFile(), true)
    assert.equal((await stat(join(dir, 'unrelated.txt'))).isFile(), true, '非诊断文件不碰')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('目录总量达到 5MB 后停止追加，不影响内存事件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-diagnostics-cap-'))
  try {
    const now = Date.parse('2026-10-21T06:00:00.000Z')
    const day = '2026-10-21'
    const path = join(dir, `diagnostics-${day}.jsonl`)
    await writeFile(path, 'x'.repeat(MAX_DIAGNOSTICS_BYTES))
    const store = new DiagnosticsStore({ dir, now: () => now, write: () => {} })
    store.record('storage', 'registry-write-failed')
    await store.flush()
    assert.equal((await stat(path)).size, MAX_DIAGNOSTICS_BYTES, '超上限不再写盘')
    assert.equal(store.recent().length, 1, '内存事件仍然保留')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('落盘失败不抛错（诊断不能反过来搞崩握手路径）', async () => {
  // 指向一个已被文件占用的路径：mkdir 必然 ENOTDIR。
  const parent = await mkdtemp(join(tmpdir(), 'deeppilot-diagnostics-fail-'))
  try {
    const blocker = join(parent, 'blocked')
    await writeFile(blocker, 'file')
    const lines: string[] = []
    const store = new DiagnosticsStore({ dir: join(blocker, 'diagnostics'), write: (line) => lines.push(line) })
    store.record('storage', 'registry-write-failed')
    await store.flush()
    assert.equal(store.recent().length, 1)
    assert.ok(lines.some((line) => line.includes('diagnostics write failed')), '写盘失败只报一次')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

// ---------- report wire 新字段 ----------

function validReport(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 2,
    serverVersion: '0.9.8',
    pluginVersion: '0.9.8',
    enabled: true,
    identityPath: '/tmp/devices-v2.json',
    pairingReady: true,
    activeConnections: 0,
    historyBufferMax: 2000,
    lanAddresses: [],
    local: { phase: 'disabled', port: 3098, endpoints: [], updatedAt: 0 },
    remote: { provider: 'tailscale-funnel', phase: 'disabled', updatedAt: 0 },
    devices: [],
    ...extra,
  }
}

test('report 的 diagnostics 字段通过严格 codec，并可缺省', () => {
  const parsed = reportSchema.parse(validReport({
    diagnostics: {
      startedAt: 10,
      recentFailures: [{
        ts: 20,
        kind: 'auth-failed',
        reason: 'nonce-mismatch',
        attemptId: 'try_1',
        source: 'abcdef012345',
        closeCode: 4401,
        durationMs: 12,
      }],
    },
  }))
  assert.deepEqual(parsed.diagnostics, {
    startedAt: 10,
    recentFailures: [{
      ts: 20,
      kind: 'auth-failed',
      reason: 'nonce-mismatch',
      attemptId: 'try_1',
      source: 'abcdef012345',
      closeCode: 4401,
      durationMs: 12,
    }],
  })
  assert.equal(reportSchema.parse(validReport()).diagnostics, undefined, '旧 Host 缺字段仍然合法')
})

test('report 的 diagnostics 拒绝任意文本与坏形态', () => {
  const withFailures = (failures: unknown[]): Record<string, unknown> => validReport({
    diagnostics: { startedAt: 10, recentFailures: failures },
  })
  assert.throws(() => reportSchema.parse(withFailures([
    { ts: 20, kind: 'auth-failed', reason: 'Bad Reason!' },
  ])), /invalid diagnostics.reason/)
  assert.throws(() => reportSchema.parse(withFailures([
    { ts: 20, kind: 'auth-failed', reason: 'nonce-mismatch', attemptId: 'has space' },
  ])), /invalid diagnostics.attemptId/)
  assert.throws(() => reportSchema.parse(withFailures([
    { ts: 20, kind: 'auth-failed', reason: 'nonce-mismatch', source: '192.168.1.5' },
  ])), /invalid diagnostics.source/, 'source 只能是哈希，不能是原始 IP')
  assert.throws(() => reportSchema.parse(withFailures(
    Array.from({ length: 21 }, (_unused, index) => ({
      ts: index, kind: 'auth-failed', reason: 'nonce-mismatch',
    })),
  )), /invalid diagnostics.recentFailures/)
})

// ---------- 注册表分因 ----------

test('DeviceStore.statusOf 区分 active / revoked / unknown（只给日志用）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'deeppilot-status-'))
  try {
    const store = await DeviceStore.load(join(dir, 'devices.json'))
    const identity = createTestIdentity()
    registerTestIdentity(store, identity)
    assert.equal(store.statusOf(identity.deviceId), 'active')
    assert.equal(store.statusOf('never-registered'), 'unknown')
    store.revoke(identity.deviceId, Date.now())
    assert.equal(store.statusOf(identity.deviceId), 'revoked')
    // 准入判定仍只认 authorized()：statusOf 不改变 4401 的结论。
    assert.equal(store.authorized(identity.deviceId), undefined)
    await store.drain()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
