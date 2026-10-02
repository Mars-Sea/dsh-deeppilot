/**
 * settings-view-models 的直驱测试：不渲染 React，只驱动纯函数与 reducer。
 *
 * 这些逻辑迁移前住在 1059 行的渲染函数里，零覆盖。这里按四件套（state /
 * action / reduce / view）逐块钉住，重点是原先靠字符串猜类名、靠注释约定
 * 的那些不变量。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NumericDraftState } from '../src/client/settings-view-models.ts'
import {
  LOCAL_PHASE_META,
  LOCAL_PORT_RANGE,
  REMOTE_LIMIT_RANGE,
  REMOTE_PHASE_META,
  deviceLabel,
  dotState,
  initialNumericDraft,
  numericDraftReduce,
  numericDraftView,
  renderConnectionTile,
  serviceStatus,
  visibleDevices,
} from '../src/client/settings-view-models.ts'
import type { DeepPilotReport } from '../src/report-wire.ts'

// ---------- phase meta ----------

test('七个 remote phase 各有点位与语义标签', () => {
  assert.deepEqual(Object.keys(REMOTE_PHASE_META).sort(),
    ['disabled', 'error', 'login_required', 'online', 'starting', 'stopped', 'unavailable'])
  assert.deepEqual(REMOTE_PHASE_META.online, { dot: ' pbb-dotOk', label: 'online' })
  assert.deepEqual(REMOTE_PHASE_META.error, { dot: ' pbb-dotBad', label: 'error' })
  assert.deepEqual(REMOTE_PHASE_META.unavailable, { dot: ' pbb-dotBad', label: 'unavailable' })
  assert.deepEqual(REMOTE_PHASE_META.disabled, { dot: '', label: 'disabled' }, 'disabled 不点亮位')
})

test('五个 local phase 与 remote 同构但用各自的 label', () => {
  assert.deepEqual(Object.keys(LOCAL_PHASE_META).sort(), ['disabled', 'error', 'online', 'starting', 'stopped'])
  assert.equal(LOCAL_PHASE_META.online.dot, REMOTE_PHASE_META.online.dot)
  // local 没有 login_required / unavailable：Funnel 专属状态不能串到 LAN 上。
  assert.equal('login_required' in LOCAL_PHASE_META, false)
  assert.equal('unavailable' in LOCAL_PHASE_META, false)
})

test('dotState 从类名反推注意力与在线，未知类名两者皆假', () => {
  assert.deepEqual(dotState(' pbb-dotBad'), { attention: true, online: false })
  assert.deepEqual(dotState(' pbb-dotOk'), { attention: false, online: true })
  assert.deepEqual(dotState(' pbb-dotWarn'), { attention: false, online: false })
  assert.deepEqual(dotState(''), { attention: false, online: false })
  assert.deepEqual(dotState(undefined), { attention: false, online: false })
  assert.deepEqual(dotState('pbb-dotBad'), { attention: true, online: false }, '无前导空格也算')
})

// ---------- serviceStatus ----------

test('serviceStatus 的真值表与迁移前逐行对应', () => {
  const base = { enabled: true, switchReady: true, localDot: '', remoteDot: '' }
  assert.equal(serviceStatus({ ...base, switchReady: false }).kind, 'loading', '开关未就绪')
  assert.equal(serviceStatus({ ...base, enabled: false }).kind, 'off', '总开关关闭')
  assert.equal(serviceStatus({ ...base, enabled: false }).dot, '', '关闭时无点位')
  assert.equal(serviceStatus({ ...base, localDot: ' pbb-dotBad' }).kind, 'attention')
  assert.equal(serviceStatus({ ...base, remoteDot: ' pbb-dotBad' }).kind, 'attention', '任一传输需要注意')
  assert.equal(serviceStatus({ ...base, localDot: ' pbb-dotOk' }).kind, 'ready')
  assert.equal(serviceStatus({ ...base, remoteDot: ' pbb-dotOk' }).kind, 'ready')
  assert.equal(serviceStatus({ ...base, localDot: ' pbb-dotWarn' }).kind, 'loading', '起式中不算就绪')
  // 注意力优先于在线：一端报错、一端在线时按 attention 展示。
  assert.equal(serviceStatus({ ...base, localDot: ' pbb-dotOk', remoteDot: ' pbb-dotBad' }).kind, 'attention')
  assert.equal(serviceStatus({ ...base, localDot: ' pbb-dotOk', remoteDot: ' pbb-dotBad' }).dot, ' pbb-dotBad')
})

// ---------- 数字草稿 ----------

const DEFAULT_PORT = 3098

test('草稿初值取区间回落值，消息为空', () => {
  assert.deepEqual(initialNumericDraft(LOCAL_PORT_RANGE), { draft: String(DEFAULT_PORT), message: '', failed: false })
  assert.deepEqual(initialNumericDraft(REMOTE_LIMIT_RANGE), { draft: '8', message: '', failed: false })
})

test('编辑只改草稿，不同步清消息之外的 status', () => {
  const state = { draft: '3098', message: 'x', failed: true }
  assert.deepEqual(numericDraftReduce(state, { type: 'edit', draft: '4000' }, LOCAL_PORT_RANGE),
    { draft: '4000', message: 'x', failed: true })
})

test('外部值变化时把草稿拉回并清空消息', () => {
  const state: NumericDraftState = { draft: '4000', message: 'x', failed: true }
  assert.deepEqual(numericDraftReduce(state, { type: 'sync', value: 3098 }, LOCAL_PORT_RANGE),
    { draft: '3098', message: '', failed: false })
})

test('应用成功清消息，失败带消息并标记 failed', () => {
  const dirty: NumericDraftState = { draft: '4000', message: 'x', failed: true }
  const applied = numericDraftReduce(dirty, { type: 'applied' }, LOCAL_PORT_RANGE)
  assert.deepEqual(applied, { draft: '4000', message: '', failed: false })
  const clean: NumericDraftState = { draft: '4000', message: '', failed: false }
  const failed = numericDraftReduce(clean, { type: 'failed', message: 'boom' }, LOCAL_PORT_RANGE)
  assert.deepEqual(failed, { draft: '4000', message: 'boom', failed: true })
})

test('合法性判定覆盖边界与脏输入', () => {
  const range = LOCAL_PORT_RANGE
  const view = (draft: string) => numericDraftView({ draft, message: '', failed: false }, 3098, range)
  assert.equal(view('1024').valid, true, '下边界含')
  assert.equal(view('65535').valid, true, '上边界含')
  assert.equal(view('1023').valid, false)
  assert.equal(view('65536').valid, false)
  assert.equal(view('3098.5').valid, false, '非整数')
  assert.equal(view('abc').valid, false)
  assert.equal(view('').valid, false, '空串')
  assert.equal(view('3098').valid, true)
  assert.equal(view('3098').unchanged, true, '与生效值相同')
  assert.equal(view('4000').unchanged, false)
  // 非法时 unchanged 为假：应用按钮不因「与生效值相同」而漏掉非法提示。
  assert.equal(view('abc').unchanged, false)
})

test('Funnel 连接数区间是 1..16', () => {
  const view = (draft: string) => numericDraftView({ draft, message: '', failed: false }, 8, REMOTE_LIMIT_RANGE)
  assert.equal(view('1').valid, true)
  assert.equal(view('16').valid, true)
  assert.equal(view('0').valid, false)
  assert.equal(view('17').valid, false)
})

// ---------- 设备 ----------

const report = (devices: DeepPilotReport['devices']): DeepPilotReport =>
  ({ devices }) as unknown as DeepPilotReport

test('已撤销的设备不进列表', () => {
  const devices = [
    { deviceId: 'a', deviceName: 'A', firstSeenTs: 0, lastSeenTs: 0, fingerprint: 'f', scopes: [] },
    { deviceId: 'b', deviceName: 'B', firstSeenTs: 0, lastSeenTs: 0, fingerprint: 'f', scopes: [], revokedAt: 123 },
  ] as unknown as DeepPilotReport['devices']
  assert.deepEqual(visibleDevices(report(devices)).map((d) => d.deviceId), ['a'])
  assert.deepEqual(visibleDevices(null), [])
})

test('设备名：自定义名优先，空白回空串由页面兜底', () => {
  assert.equal(deviceLabel({ deviceName: 'iPhone', customName: '  ' }), '')
  assert.equal(deviceLabel({ deviceName: 'iPhone', customName: '我的手机' }), '我的手机')
  assert.equal(deviceLabel({ deviceName: ' iPhone ' }), 'iPhone')
  assert.equal(deviceLabel({ deviceName: '   ' }), '', '页面据此决定用 devices.unnamed 兜底')
})

// ---------- 连接磁贴 ----------

test('连接磁贴把点位与状态标签带进 aria 与 title', () => {
  const tile = renderConnectionTile(
    'local', '局域网', '已开启', true, true, ' pbb-dotOk', '在线', () => {},
  ) as { key: string; props: Record<string, any> }
  assert.equal(tile.props.className, 'pbb-connectionTile')
  assert.equal(tile.key, 'local', 'React 把 key 提到元素上，不在 props 里')
  const header = tile.props.children[0] as { props: Record<string, any> }
  const dotRow = header.props.children[0] as { props: Record<string, any> }
  const dot = dotRow.props.children[0] as { props: Record<string, any> }
  assert.equal(dot.props.className, 'pbb-dot pbb-dotOk')
  assert.equal(dot.props['aria-label'], '在线')
  assert.equal(dot.props.title, '在线', '鼠标悬停也要能读到状态')
  const button = header.props.children[1] as { props: Record<string, any> }
  assert.equal(button.props['aria-checked'], true)
  assert.equal(button.props.disabled, false)
  assert.equal(button.props.className, 'pbb-switch pbb-switchOn')
})

test('未就绪时开关禁用；extra 原样挂在末尾', () => {
  const extra = { marker: true }
  const tile = renderConnectionTile('remote', '远程', '关闭', false, false, '', '已关闭', () => {}, extra) as { key: string; props: Record<string, any> }
  assert.equal(tile.key, 'remote')
  const header = tile.props.children[0] as { props: Record<string, any> }
  const button = header.props.children[1] as { props: Record<string, any> }
  assert.equal(button.props.disabled, true, '状态未就绪时不允许拨动')
  assert.equal(tile.props.children[3], extra)
})
