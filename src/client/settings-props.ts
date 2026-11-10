/**
 * 设置页依赖的**接口**：一次声明页面消费的全部东西，外加一道归一化 seam。
 *
 * 迁移前页面签名是 `props: Record<string, any>`，20 个依赖全凭运行期 typeof
 * 守卫；拼错一个名字不会编译报错，只会在页面上变成一条诊断行。宿主注入面
 * （client/index.ts 的 inject 字面量）与页面之间没有任何类型级链接。
 *
 * 这里做两件事：
 * 1. `SettingsPageProps` 把 20 个依赖的类型钉住，宿主面与页面共享它；
 * 2. `normalizeSettingsPageProps` 是唯一的 seam：校验一次、缺省补齐、把
 *    「宿主没给全」折算成诊断列表与能力集合。页面体里不再出现任何 typeof。
 *
 * 关于 React 的硬约束：7 个 `useDeepPilot*` 是 hook，必须留在组件体内无条件
 * 调用，不能包进普通函数。因此 hook 缺失时在这里换成**模块级 fallback hook**
 * （引用恒定，React 不会把它当作 hook 顺序变化），缺省态与今天页面内的分支
 * 逐一对齐。
 */

import type {
  DebugState,
  EnabledState,
  LocalPortState,
  PageState,
  PreviewState,
  RemoteConnectionLimitState,
  RemoteEnabledState,
} from './index.ts'
import type { DeepPilotReport, PairingGrantSnapshot, PushTestResult, RelayTestResult } from '../report-wire.ts'
import type { Translate } from './i18n.ts'
import { DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE } from '../funnel-policy.ts'
import { DEFAULT_LOCAL_PORT } from '../local-policy.ts'

/** 一个选择器 hook：页面传恒等选择器取整份状态。 */
export type Selector<S> = (select: (state: S) => S) => S

export type ReportSelector = Selector<PageState>
export type EnabledSelector = Selector<EnabledState>
export type LocalPortSelector = Selector<LocalPortState>
export type RemoteEnabledSelector = Selector<RemoteEnabledState>
export type RemoteLimitSelector = Selector<RemoteConnectionLimitState>
export type DebugSelector = Selector<DebugState>
export type PreviewSelector = Selector<PreviewState>

/** 页面真正用到的报告字段（诊断与统计块都只读这些）。 */
export type SettingsReport = DeepPilotReport

export interface SettingsPageProps {
  // ---------- hooks（恒为函数：缺失时由 seam 换成 fallback） ----------
  useDeepPilotReport: ReportSelector
  useDeepPilotEnabled: EnabledSelector
  useDeepPilotLocalPort: LocalPortSelector
  useDeepPilotRemoteEnabled: RemoteEnabledSelector
  useDeepPilotRemoteConnectionLimit: RemoteLimitSelector
  useDeepPilotDebug: DebugSelector
  useDeepPilotPreview: PreviewSelector
  // ---------- 可选函数：在位情况见 `can` ----------
  refresh?: () => void
  beginPairing?: () => Promise<PairingGrantSnapshot>
  revokeDevice?: (deviceId: string) => Promise<unknown>
  setDeviceName?: (deviceId: string, customName: string | null) => Promise<unknown>
  testRelay?: () => Promise<RelayTestResult>
  testPush?: () => Promise<PushTestResult>
  setDeepPilotEnabled?: (enabled: boolean) => unknown
  setDeepPilotLocalPort?: (port: number) => Promise<unknown> | unknown
  setDeepPilotRemoteEnabled?: (enabled: boolean) => unknown
  setDeepPilotRemoteConnectionLimit?: (limit: number) => Promise<unknown> | unknown
  setDeepPilotDebug?: (enabled: boolean) => unknown
  setDeepPilotPreview?: (enabled: boolean) => unknown
  setDeepPilotHostWeb?: (enabled: boolean) => unknown
  /** 绑定的翻译函数；页面所有文案都经它。 */
  t: Translate
}

/** 可选能力的名字：页面的行为分支读集合，不再 typeof。 */
export type SettingsCapability =
  | 'refresh'
  | 'beginPairing'
  | 'revokeDevice'
  | 'setDeviceName'
  | 'testRelay'
  | 'testPush'
  | 'setEnabled'
  | 'setLocalPort'
  | 'setRemoteEnabled'
  | 'setRemoteLimit'
  | 'setDebug'
  | 'setPreview'
  | 'setHostWeb'

export interface SettingsPageSurface {
  props: SettingsPageProps
  can: ReadonlySet<SettingsCapability>
  /** 已翻译的诊断行，顺序与迁移前页面内的 diag[] 一致。 */
  diagnostics: string[]
  /** 报告 hook 整个缺失：统计/配对/系统区块整段跳过。 */
  reportHookMissing: boolean
}

// ---------- hook 缺失时的缺省态 ----------

export const MISSING_REPORT_HOOK: ReportSelector = () => ({ status: 'loading', report: null, message: '' })
export const MISSING_ENABLED_HOOK: EnabledSelector = () => ({ status: 'unavailable', enabled: true })
export const MISSING_LOCAL_PORT_HOOK: LocalPortSelector = () => ({ status: 'unavailable', value: DEFAULT_LOCAL_PORT })
export const MISSING_REMOTE_ENABLED_HOOK: RemoteEnabledSelector = () => ({ status: 'unavailable', enabled: false })
export const MISSING_REMOTE_LIMIT_HOOK: RemoteLimitSelector = () => ({ status: 'unavailable', value: DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE })
export const MISSING_DEBUG_HOOK: DebugSelector = () => ({ status: 'unavailable', enabled: false })
export const MISSING_PREVIEW_HOOK: PreviewSelector = () => ({ status: 'unavailable', enabled: true, hostWeb: false })

/** 诊断行的 key，集中在此便于对账（tests/settings-props.test.ts 逐条断言）。 */
const DIAG_KEY = {
  reportHook: 'diag.missingReportHook',
  enabledHook: 'diag.missingEnabledHook',
  localPortHook: 'diag.missingLocalPortHook',
  remoteEnabledHook: 'diag.missingRemoteEnabledHook',
  remoteLimitHook: 'diag.missingRemoteLimitHook',
  debugHook: 'diag.missingDebugHook',
  refresh: 'diag.missingRefresh',
  reveal: 'diag.missingReveal',
  rotate: 'diag.missingRotate',
  rename: 'diag.missingRename',
  testRelay: 'diag.missingTestRelay',
  testPush: 'diag.missingTestPush',
  setEnabled: 'diag.missingSetEnabled',
  setLocalPort: 'diag.missingSetLocalPort',
  setRemote: 'diag.missingSetRemote',
  setRemoteLimit: 'diag.missingSetRemoteLimit',
  setDebug: 'diag.missingSetDebug',
  previewHook: 'diag.missingPreviewHook',
  setPreview: 'diag.missingSetPreview',
  setHostWeb: 'diag.missingSetHostWeb',
  settingsUnavailable: 'diag.settingsUnavailable',
} as const

const CAPABILITY_BY_PROP: ReadonlyArray<[SettingsCapability, keyof SettingsPageProps]> = [
  ['refresh', 'refresh'],
  ['beginPairing', 'beginPairing'],
  ['revokeDevice', 'revokeDevice'],
  ['setDeviceName', 'setDeviceName'],
  ['testRelay', 'testRelay'],
  ['testPush', 'testPush'],
  ['setEnabled', 'setDeepPilotEnabled'],
  ['setLocalPort', 'setDeepPilotLocalPort'],
  ['setRemoteEnabled', 'setDeepPilotRemoteEnabled'],
  ['setRemoteLimit', 'setDeepPilotRemoteConnectionLimit'],
  ['setDebug', 'setDeepPilotDebug'],
  ['setPreview', 'setDeepPilotPreview'],
  ['setHostWeb', 'setDeepPilotHostWeb'],
]

const isFn = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function'

/**
 * 把宿主注入的原始对象归一化成页面可消费的面。
 *
 * 逐项复刻迁移前页面内的行为：hook 缺失换 fallback 并记诊断；函数缺失则该
 * 能力不进 `can` 并记诊断；诊断顺序与原先的 `diag[]` 完全一致（宿主过期时
 * 用户看到的技术诊断因此一字不差）。
 */
export function normalizeSettingsPageProps(raw: unknown): SettingsPageSurface {
  const source = (raw ?? {}) as Record<string, unknown>
  const t = typeof source.t === 'function' ? (source.t as Translate) : ((key: string) => key)
  const diagnostics: string[] = []
  const can = new Set<SettingsCapability>()

  const useReport = isFn(source.useDeepPilotReport) ? (source.useDeepPilotReport as ReportSelector) : MISSING_REPORT_HOOK
  const useEnabled = isFn(source.useDeepPilotEnabled) ? (source.useDeepPilotEnabled as EnabledSelector) : MISSING_ENABLED_HOOK
  const useLocalPort = isFn(source.useDeepPilotLocalPort) ? (source.useDeepPilotLocalPort as LocalPortSelector) : MISSING_LOCAL_PORT_HOOK
  const useRemoteEnabled = isFn(source.useDeepPilotRemoteEnabled) ? (source.useDeepPilotRemoteEnabled as RemoteEnabledSelector) : MISSING_REMOTE_ENABLED_HOOK
  const useRemoteLimit = isFn(source.useDeepPilotRemoteConnectionLimit) ? (source.useDeepPilotRemoteConnectionLimit as RemoteLimitSelector) : MISSING_REMOTE_LIMIT_HOOK
  const useDebug = isFn(source.useDeepPilotDebug) ? (source.useDeepPilotDebug as DebugSelector) : MISSING_DEBUG_HOOK
  const usePreview = isFn(source.useDeepPilotPreview) ? (source.useDeepPilotPreview as PreviewSelector) : MISSING_PREVIEW_HOOK

  // 顺序必须与迁移前页面内的 diag[] 一致，否则宿主过期时用户看到的技术诊断会变样。
  if (!isFn(source.useDeepPilotReport)) diagnostics.push(t(DIAG_KEY.reportHook))
  if (!isFn(source.useDeepPilotEnabled)) diagnostics.push(t(DIAG_KEY.enabledHook))
  if (!isFn(source.refresh)) diagnostics.push(t(DIAG_KEY.refresh))
  if (!isFn(source.beginPairing)) diagnostics.push(t(DIAG_KEY.reveal))
  if (!isFn(source.revokeDevice)) diagnostics.push(t(DIAG_KEY.rotate))
  if (!isFn(source.setDeviceName)) diagnostics.push(t(DIAG_KEY.rename))
  if (!isFn(source.testRelay)) diagnostics.push(t(DIAG_KEY.testRelay))
  if (!isFn(source.testPush)) diagnostics.push(t(DIAG_KEY.testPush))
  if (!isFn(source.setDeepPilotEnabled)) diagnostics.push(t(DIAG_KEY.setEnabled))
  if (!isFn(source.useDeepPilotLocalPort)) diagnostics.push(t(DIAG_KEY.localPortHook))
  if (!isFn(source.setDeepPilotLocalPort)) diagnostics.push(t(DIAG_KEY.setLocalPort))
  if (!isFn(source.useDeepPilotRemoteEnabled)) diagnostics.push(t(DIAG_KEY.remoteEnabledHook))
  if (!isFn(source.setDeepPilotRemoteEnabled)) diagnostics.push(t(DIAG_KEY.setRemote))
  if (!isFn(source.useDeepPilotRemoteConnectionLimit)) diagnostics.push(t(DIAG_KEY.remoteLimitHook))
  if (!isFn(source.setDeepPilotRemoteConnectionLimit)) diagnostics.push(t(DIAG_KEY.setRemoteLimit))
  if (!isFn(source.useDeepPilotDebug)) diagnostics.push(t(DIAG_KEY.debugHook))
  if (!isFn(source.setDeepPilotDebug)) diagnostics.push(t(DIAG_KEY.setDebug))
  // 新增项追加在末尾，既有诊断行的顺序保持不变。
  if (!isFn(source.useDeepPilotPreview)) diagnostics.push(t(DIAG_KEY.previewHook))
  if (!isFn(source.setDeepPilotPreview)) diagnostics.push(t(DIAG_KEY.setPreview))
  if (!isFn(source.setDeepPilotHostWeb)) diagnostics.push(t(DIAG_KEY.setHostWeb))

  for (const [capability, prop] of CAPABILITY_BY_PROP) {
    if (isFn(source[prop])) can.add(capability)
  }

  const props: SettingsPageProps = {
    useDeepPilotReport: useReport,
    useDeepPilotEnabled: useEnabled,
    useDeepPilotLocalPort: useLocalPort,
    useDeepPilotRemoteEnabled: useRemoteEnabled,
    useDeepPilotRemoteConnectionLimit: useRemoteLimit,
    useDeepPilotDebug: useDebug,
    useDeepPilotPreview: usePreview,
    t: t as Translate,
    refresh: isFn(source.refresh) ? (source.refresh as () => void) : undefined,
    beginPairing: isFn(source.beginPairing) ? (source.beginPairing as () => Promise<PairingGrantSnapshot>) : undefined,
    revokeDevice: isFn(source.revokeDevice) ? (source.revokeDevice as (deviceId: string) => Promise<unknown>) : undefined,
    setDeviceName: isFn(source.setDeviceName) ? (source.setDeviceName as SettingsPageProps['setDeviceName']) : undefined,
    testRelay: isFn(source.testRelay) ? (source.testRelay as () => Promise<RelayTestResult>) : undefined,
    testPush: isFn(source.testPush) ? (source.testPush as () => Promise<PushTestResult>) : undefined,
    setDeepPilotEnabled: isFn(source.setDeepPilotEnabled) ? (source.setDeepPilotEnabled as SettingsPageProps['setDeepPilotEnabled']) : undefined,
    setDeepPilotLocalPort: isFn(source.setDeepPilotLocalPort) ? (source.setDeepPilotLocalPort as SettingsPageProps['setDeepPilotLocalPort']) : undefined,
    setDeepPilotRemoteEnabled: isFn(source.setDeepPilotRemoteEnabled) ? (source.setDeepPilotRemoteEnabled as SettingsPageProps['setDeepPilotRemoteEnabled']) : undefined,
    setDeepPilotRemoteConnectionLimit: isFn(source.setDeepPilotRemoteConnectionLimit) ? (source.setDeepPilotRemoteConnectionLimit as SettingsPageProps['setDeepPilotRemoteConnectionLimit']) : undefined,
    setDeepPilotDebug: isFn(source.setDeepPilotDebug) ? (source.setDeepPilotDebug as SettingsPageProps['setDeepPilotDebug']) : undefined,
    setDeepPilotPreview: isFn(source.setDeepPilotPreview) ? (source.setDeepPilotPreview as SettingsPageProps['setDeepPilotPreview']) : undefined,
    setDeepPilotHostWeb: isFn(source.setDeepPilotHostWeb) ? (source.setDeepPilotHostWeb as SettingsPageProps['setDeepPilotHostWeb']) : undefined,
  }

  return { props, can, diagnostics, reportHookMissing: !isFn(source.useDeepPilotReport) }
}
