/**
 * 设置页的 view model：把原先住在渲染函数里的三块逻辑变成可单测的纯模块。
 *
 * 迁移前 `settings-page.ts` 是一个 1059 行的组件，funnel phase → {dot, label}、
端口/连接数草稿的编辑与合法性、serviceStatus 派生全在渲染函数里，没有任何
直接测试。这里按 pairing-panel.ts 的形状把它们拆成 state / action / reduce /
view 四件套——shape 与该先例一致，但**不继承它唯一的泄漏**：view model 只返回
语义值，i18n key 的映射留在页面（措辞归页面，测试不跟着措辞漂）。
 */

import { createElement as h } from 'react'
import type { DeepPilotReport } from '../report-wire.ts'
import { DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE, MAX_FUNNEL_CONNECTIONS_PER_SOURCE } from '../funnel-policy.ts'
import { DEFAULT_LOCAL_PORT, MAX_LOCAL_PORT, MIN_LOCAL_PORT } from '../local-policy.ts'

// ---------- 传输 phase ----------

/** 点位的视觉状态。空串 = 无点位。 */
export type Dot = '' | ' pbb-dotWarn' | ' pbb-dotOk' | ' pbb-dotBad'

/** phase 的语义标签；页面负责把它映射成 i18n key。 */
export type RemotePhaseLabel =
  | 'disabled' | 'starting' | 'login_required' | 'online' | 'error' | 'unavailable' | 'stopped'
export type LocalPhaseLabel = 'disabled' | 'starting' | 'online' | 'error' | 'stopped'

export interface PhaseMeta<L extends string> {
  dot: Dot
  label: L
}

export const REMOTE_PHASE_META: Record<DeepPilotReport['remote']['phase'], PhaseMeta<RemotePhaseLabel>> = {
  disabled: { dot: '', label: 'disabled' },
  starting: { dot: ' pbb-dotWarn', label: 'starting' },
  login_required: { dot: ' pbb-dotWarn', label: 'login_required' },
  online: { dot: ' pbb-dotOk', label: 'online' },
  error: { dot: ' pbb-dotBad', label: 'error' },
  unavailable: { dot: ' pbb-dotBad', label: 'unavailable' },
  stopped: { dot: '', label: 'stopped' },
}

export const LOCAL_PHASE_META: Record<DeepPilotReport['local']['phase'], PhaseMeta<LocalPhaseLabel>> = {
  disabled: { dot: '', label: 'disabled' },
  starting: { dot: ' pbb-dotWarn', label: 'starting' },
  online: { dot: ' pbb-dotOk', label: 'online' },
  error: { dot: ' pbb-dotBad', label: 'error' },
  stopped: { dot: '', label: 'stopped' },
}

/** 从点位反推「需要注意 / 已在线」——原先页面用字符串 includes 猜类名。 */
export function dotState(dot: string | undefined): { attention: boolean; online: boolean } {
  return {
    attention: dot?.includes('pbb-dotBad') === true,
    online: dot?.includes('pbb-dotOk') === true,
  }
}

/** 服务状态：总开关未就绪 / 已关闭 / 需要注意 / 在线 / 仍在起。 */
export type ServiceStatusKind = 'loading' | 'off' | 'attention' | 'ready'

export interface ServiceStatus {
  kind: ServiceStatusKind
  dot: Dot
}

export function serviceStatus(input: {
  enabled: boolean
  switchReady: boolean
  localDot: string | undefined
  remoteDot: string | undefined
}): ServiceStatus {
  const local = dotState(input.localDot)
  const remote = dotState(input.remoteDot)
  const attention = local.attention || remote.attention
  const online = local.online || remote.online
  const kind: ServiceStatusKind = !input.switchReady
    ? 'loading'
    : !input.enabled
      ? 'off'
      : attention
        ? 'attention'
        : online
          ? 'ready'
          : 'loading'
  const dot: Dot = !input.enabled
    ? ''
    : attention
      ? ' pbb-dotBad'
      : online
        ? ' pbb-dotOk'
        : ' pbb-dotWarn'
  return { kind, dot }
}

// ---------- 数字草稿（本地端口 / Funnel 连接数） ----------

/** 一个数字草稿的合法区间。 */
export interface NumericRange {
  min: number
  max: number
  fallback: number
}

export const LOCAL_PORT_RANGE: NumericRange = { min: MIN_LOCAL_PORT, max: MAX_LOCAL_PORT, fallback: DEFAULT_LOCAL_PORT }
export const REMOTE_LIMIT_RANGE: NumericRange = {
  min: 1,
  max: MAX_FUNNEL_CONNECTIONS_PER_SOURCE,
  fallback: DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE,
}

export interface NumericDraftState {
  /** 输入框里的原文；空串表示尚未编辑。 */
  draft: string
  /** 上一次应用结果的消息；空串表示无消息。 */
  message: string
  /** 消息是否表示失败（页面据此染红）。 */
  failed: boolean
}

export type NumericDraftAction =
  /** 输入框变化。 */
  | { type: 'edit'; draft: string }
  /** 外部值变化：把草稿同步回最新值。 */
  | { type: 'sync'; value: number }
  /** 应用完成：清空消息（也用于四秒后的自动清除）。 */
  | { type: 'applied' }
  /** 应用成功并给出提示文案。 */
  | { type: 'succeeded'; message: string }
  | { type: 'failed'; message: string }

export function initialNumericDraft(range: NumericRange): NumericDraftState {
  return { draft: String(range.fallback), message: '', failed: false }
}

export function numericDraftReduce(state: NumericDraftState, action: NumericDraftAction, range: NumericRange): NumericDraftState {
  switch (action.type) {
    case 'edit':
      return { ...state, draft: action.draft }
    case 'sync':
      return { ...state, draft: String(action.value), message: '', failed: false }
    case 'applied':
      return { ...state, message: '', failed: false }
    case 'succeeded':
      return { ...state, message: action.message, failed: false }
    case 'failed':
      return { ...state, message: action.message, failed: true }
  }
}

export interface NumericDraftView {
  /** 解析出的值；非法时为 NaN。 */
  value: number
  valid: boolean
  /** 与当前生效值相同（应用按钮据此禁用）。 */
  unchanged: boolean
}

export function numericDraftView(state: NumericDraftState, current: number, range: NumericRange): NumericDraftView {
  const value = Number(state.draft)
  const valid = Number.isInteger(value) && value >= range.min && value <= range.max
  return { value, valid, unchanged: valid && value === current }
}

// ---------- 设备列表 ----------

/** 页面渲染设备行所需的字段（report.devices 的子集）。 */
export interface SettingsDevice {
  deviceId: string
  deviceName: string
  customName?: string
  revokedAt?: number
  appVersion?: string
  fingerprint?: string
  lastSeenTs?: number
}

/** 已撤销的设备不展示。 */
export function visibleDevices(report: DeepPilotReport | null): SettingsDevice[] {
  return (report?.devices ?? []).filter((device) => device.revokedAt === undefined)
}

/** 设备展示名：自定义名优先，都没有则空串（兜底文案归页面）。 */
export function deviceLabel(device: { deviceName: string; customName?: string }): string {
  return (device.customName ?? device.deviceName).trim()
}

// ---------- 连接磁贴 ----------

/** 渲染一块连接磁贴。纯数据函数：九参进，元素树出。 */
export function renderConnectionTile(
  key: string,
  title: string,
  description: string,
  checked: boolean,
  ready: boolean,
  dot: string,
  statusLabel: string,
  onToggle: () => void,
  extra: any = null,
): any {
  return h('div', { className: 'pbb-connectionTile', key },
    h('div', { className: 'pbb-connectionTileHeader' },
      h('span', { className: 'pbb-switchTitle pbb-dotRow' },
        h('span', {
          className: 'pbb-dot' + dot,
          role: 'img',
          'aria-label': statusLabel,
          title: statusLabel,
        }),
        title),
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': title,
        disabled: !ready,
        className: 'pbb-switch' + (checked ? ' pbb-switchOn' : ''),
        onClick: onToggle,
      })),
    h('span', { className: 'pbb-connectionState' }, statusLabel),
    h('p', { className: 'pbb-connectionDescription' }, description),
    extra,
  )
}
