import { createElement as h, Fragment, useEffect, useReducer, useRef, useState } from 'react'
import * as QRCode from 'qrcode/lib/browser.js'
import type { DeepPilotReport, PairingGrantSnapshot, PushTestResult, RelayTestResult } from '../report-wire.ts'
import { encodePairingLink, selectPairingTargets, type PairingTarget } from '../pairing-qr.ts'
import { initialPairingPanelState, pairingPanelReduce, pairingPanelView } from './pairing-panel.ts'
import { translateWith as t } from './i18n.ts'
import {
  normalizeSettingsPageProps,
  type SettingsCapability,
  type SettingsPageProps,
} from './settings-props.ts'
import type { PageState } from './index.ts'
import { DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE } from '../funnel-policy.ts'
import { DEFAULT_LOCAL_PORT } from '../local-policy.ts'
import {
  LOCAL_PHASE_META,
  LOCAL_PORT_RANGE,
  REMOTE_LIMIT_RANGE,
  REMOTE_PHASE_META,
  deviceLabel as deviceLabelOf,
  initialNumericDraft,
  numericDraftReduce,
  numericDraftView,
  renderConnectionTile,
  serviceStatus,
  visibleDevices as visibleDevicesOf,
  type LocalPhaseLabel,
  type NumericDraftAction,
  type NumericDraftState,
  type RemotePhaseLabel,
} from './settings-view-models.ts'

type T = (key: string, vars?: Readonly<Record<string, unknown>>) => string

/** phase 语义标签 → i18n key。措辞归页面，view model 只认语义。 */
const REMOTE_LABEL_KEY: Record<RemotePhaseLabel, string> = {
  disabled: 'phase.disabled',
  starting: 'phase.starting',
  login_required: 'phase.login_required',
  online: 'phase.online',
  error: 'phase.error',
  unavailable: 'phase.unavailable',
  stopped: 'phase.stopped',
}
const LOCAL_LABEL_KEY: Record<LocalPhaseLabel, string> = {
  disabled: 'local.phaseDisabled',
  starting: 'local.phaseStarting',
  online: 'local.phaseOnline',
  error: 'local.phaseError',
  stopped: 'local.phaseStopped',
}
/** 服务状态 → i18n key。 */
const SERVICE_STATUS_KEY = {
  loading: 'status.loading',
  off: 'status.off',
  attention: 'status.attention',
  ready: 'status.ready',
} as const

/** Inline trash icon for the compact destructive row action. Kept as a tiny
 *  element (no icon dependency) so the client bundle stays dependency-free
 *  apart from React. */
const TrashIcon = (): any =>
  h('svg', {
    className: 'pbb-actionIcon',
    viewBox: '0 0 16 16',
    width: 13,
    height: 13,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
    h('path', { d: 'M2.5 4.5h11' }),
    h('path', { d: 'M6.5 2.5h3' }),
    h('path', { d: 'M4 4.5l.6 8.2a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.2' }),
    h('path', { d: 'M6.6 7v4.2' }),
    h('path', { d: 'M9.4 7v4.2' }),
  )

const CheckIcon = (): any =>
  h('svg', {
    className: 'pbb-controlIcon', viewBox: '0 0 16 16', width: 14, height: 14,
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  }, h('path', { d: 'm3 8.3 3.1 3.1L13 4.8' }))

const CloseIcon = (): any =>
  h('svg', {
    className: 'pbb-controlIcon', viewBox: '0 0 16 16', width: 14, height: 14,
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', 'aria-hidden': true,
  }, h('path', { d: 'm4.5 4.5 7 7m0-7-7 7' }))

async function writeClipboard(t: T, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    // Some embedded browsers expire user activation while a remote call is in
    // flight. Keep a synchronous fallback scoped to a short-lived textarea.
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error(t('clipboard.rejected'))
}

/**
 * Slot component: hooks come from the slot renderer, named use<Key>.
 *
 * 组件的接口是 `SettingsPageProps`（见 settings-props.ts）：宿主注入面与页面
 * 共享同一份类型。这里只做一次归一化，之后全程消费类型化对象——页面里不再
 * 出现任何 typeof 守卫，也不再自己拼诊断行。
 */
export function DeepPilotSettingsPage(rawProps: Record<string, any>): any {
  const surface = normalizeSettingsPageProps(rawProps)
  const props: SettingsPageProps = surface.props
  const can = (capability: SettingsCapability): boolean => surface.can.has(capability)

  const [remoteLimitDraft, dispatchRemoteLimitDraft] = useReducer(
    (state: NumericDraftState, action: NumericDraftAction) => numericDraftReduce(state, action, REMOTE_LIMIT_RANGE),
    initialNumericDraft(REMOTE_LIMIT_RANGE),
  )
  const [localPortDraft, dispatchLocalPortDraft] = useReducer(
    (state: NumericDraftState, action: NumericDraftAction) => numericDraftReduce(state, action, LOCAL_PORT_RANGE),
    initialNumericDraft(LOCAL_PORT_RANGE),
  )
  const [selectedPairingHost, setSelectedPairingHost] = useState<string | null>(null)
  const [pairingPanel, dispatchPairingPanel] = useReducer(pairingPanelReduce, initialPairingPanelState)
  const qrRequestId = useRef(0)
  const [troubleshootingOpen, setTroubleshootingOpen] = useState(false)
  const [relayTestBusy, setRelayTestBusy] = useState(false)
  const [relayTestResult, setRelayTestResult] = useState<RelayTestResult | null>(null)
  const [relayTestError, setRelayTestError] = useState('')
  const [pushTestBusy, setPushTestBusy] = useState(false)
  const [pushTestResult, setPushTestResult] = useState<PushTestResult | null>(null)
  const [pushTestError, setPushTestError] = useState('')
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null)
  const [deviceBusyAction, setDeviceBusyAction] = useState<'rename' | 'revoke' | null>(null)
  const [deviceMessage, setDeviceMessage] = useState('')
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null)
  const [deviceNameDraft, setDeviceNameDraft] = useState('')

  useEffect(() => {
    if (!can('refresh')) return
    const refresh = props.refresh!
    refresh()
    const timer = globalThis.setInterval(() => refresh(), 3_000)
    return () => globalThis.clearInterval(timer)
  }, [props.refresh])

  const sendPushTest = (): void => {
    if (pushTestBusy) return
    if (!can('testPush')) {
      setPushTestError(t(props.t, 'push.staleHost'))
      return
    }
    setTroubleshootingOpen(true)
    setPushTestBusy(true)
    setPushTestError('')
    void props.testPush!().then((result: PushTestResult) => {
      setPushTestResult(result)
      setPushTestBusy(false)
    }, (error: unknown) => {
      setPushTestError(error instanceof Error ? error.message : String(error))
      setPushTestBusy(false)
    })
  }

  const runRelayTest = (): void => {
    if (relayTestBusy) return
    if (!can('testRelay')) {
      setRelayTestError(t(props.t, 'push.staleHostRelay'))
      return
    }
    setTroubleshootingOpen(true)
    setRelayTestBusy(true)
    setRelayTestError('')
    void props.testRelay!().then((result: RelayTestResult) => {
      setRelayTestResult(result)
      setRelayTestBusy(false)
    }, (error: unknown) => {
      setRelayTestError(error instanceof Error ? error.message : String(error))
      setRelayTestBusy(false)
    })
  }

  // 两个草稿的「应用结果」消息四秒后自动消失。reducer 的 applied 动作把消息
  // 清空，因此这里只需要一个触发器。
  useEffect(() => {
    if (remoteLimitDraft.message === '') return
    const timer = globalThis.setTimeout(() => dispatchRemoteLimitDraft({ type: 'applied' }), 4_000)
    return () => globalThis.clearTimeout(timer)
  }, [remoteLimitDraft.message])

  useEffect(() => {
    if (localPortDraft.message === '') return
    const timer = globalThis.setTimeout(() => dispatchLocalPortDraft({ type: 'applied' }), 4_000)
    return () => globalThis.clearTimeout(timer)
  }, [localPortDraft.message])

  useEffect(() => {
    if (pairingPanel.grant === null) return
    // The panel carries a single-use code, so it must not outlive the grant.
    const remaining = Math.max(0, pairingPanel.grant.expiresAt - Date.now())
    const timer = globalThis.setTimeout(() => {
      dispatchPairingPanel({ type: 'close', message: t(props.t, 'pair.qrExpired') })
    }, remaining)
    return () => globalThis.clearTimeout(timer)
  }, [pairingPanel.grant])

  useEffect(() => {
    if (!pairingPanel.notice) return
    const timer = globalThis.setTimeout(() => dispatchPairingPanel({ type: 'dismissNotice' }), 2_500)
    return () => globalThis.clearTimeout(timer)
  }, [pairingPanel.notice])

  // hook 必须在组件体内无条件调用（React 规则）：归一化 seam 已保证它们永远是
  // 函数——宿主没给时换成引用恒定的 fallback，缺省态与迁移前逐项对齐。
  // 它们仍是整个渲染里唯一可能抛的点（宿主 store 自己炸），因此保留渲染异常
  // 诊断：与迁移前一样折算成一行 diag.renderError 并把详情块展开。
  const diag = surface.diagnostics
  let failed = surface.reportHookMissing
  const readHooks = (): void => {
    const reportState = props.useDeepPilotReport((s: PageState) => s)
    hooks.report = reportState.report
    if (reportState.status === 'error' && reportState.message) {
      diag.push(reportState.message)
      failed = true
    }
    const enabledState = props.useDeepPilotEnabled((s) => s)
    hooks.enabled = enabledState.enabled
    hooks.switchReady = enabledState.status === 'ready'
    if (enabledState.status === 'unavailable') diag.push(t(props.t, 'diag.settingsUnavailable'))
    const localEnabledState = props.useDeepPilotLocalEnabled((s) => s)
    hooks.localEnabled = localEnabledState.enabled
    hooks.localSwitchReady = localEnabledState.status === 'ready'
    const localPortState = props.useDeepPilotLocalPort((s) => s)
    hooks.localPort = localPortState.value
    hooks.localPortReady = localPortState.status === 'ready'
    const remoteEnabledState = props.useDeepPilotRemoteEnabled((s) => s)
    hooks.remoteEnabled = remoteEnabledState.enabled
    hooks.remoteSwitchReady = remoteEnabledState.status === 'ready'
    const remoteLimitState = props.useDeepPilotRemoteConnectionLimit((s) => s)
    hooks.remoteConnectionLimit = remoteLimitState.value
    hooks.remoteConnectionLimitReady = remoteLimitState.status === 'ready'
    const debugState = props.useDeepPilotDebug((s) => s)
    hooks.debugEnabled = debugState.enabled
    hooks.debugSwitchReady = debugState.status === 'ready'
  }
  const hooks: {
    report: DeepPilotReport | null
    enabled: boolean
    switchReady: boolean
    localEnabled: boolean
    localSwitchReady: boolean
    localPort: number
    localPortReady: boolean
    remoteEnabled: boolean
    remoteSwitchReady: boolean
    remoteConnectionLimit: number
    remoteConnectionLimitReady: boolean
    debugEnabled: boolean
    debugSwitchReady: boolean
  } = {
    report: null, enabled: true, switchReady: false,
    localEnabled: true, localSwitchReady: false,
    localPort: DEFAULT_LOCAL_PORT, localPortReady: false,
    remoteEnabled: false, remoteSwitchReady: false,
    remoteConnectionLimit: DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE, remoteConnectionLimitReady: false,
    debugEnabled: false, debugSwitchReady: false,
  }
  try {
    readHooks()
  } catch (error) {
    diag.push(t(props.t, 'diag.renderError') + (error instanceof Error ? error.message : String(error)))
    failed = true
  }
  const report = hooks.report
  const enabled = hooks.enabled
  const switchReady = hooks.switchReady
  const localEnabled = hooks.localEnabled
  const localSwitchReady = hooks.localSwitchReady
  const localPort = hooks.localPort
  const localPortReady = hooks.localPortReady
  const remoteEnabled = hooks.remoteEnabled
  const remoteSwitchReady = hooks.remoteSwitchReady
  const remoteConnectionLimit = hooks.remoteConnectionLimit
  const remoteConnectionLimitReady = hooks.remoteConnectionLimitReady
  const debugEnabled = hooks.debugEnabled
  const debugSwitchReady = hooks.debugSwitchReady

  useEffect(() => {
    dispatchRemoteLimitDraft({ type: 'sync', value: remoteConnectionLimit })
  }, [remoteConnectionLimit])

  useEffect(() => {
    dispatchLocalPortDraft({ type: 'sync', value: localPort })
  }, [localPort])

  const localPortView = numericDraftView(localPortDraft, localPort, LOCAL_PORT_RANGE)
  const remoteLimitView = numericDraftView(remoteLimitDraft, remoteConnectionLimit, REMOTE_LIMIT_RANGE)
  const applyLocalPort = (): void => {
    if (!localPortView.valid || !can('setLocalPort')) {
      dispatchLocalPortDraft({ type: 'failed', message: t(props.t, 'local.portInvalid') })
      return
    }
    dispatchLocalPortDraft({ type: 'applied' })
    void Promise.resolve(props.setDeepPilotLocalPort!(localPortView.value)).then(() => {
      dispatchLocalPortDraft({ type: 'succeeded', message: t(props.t, 'local.portApplied') })
    }, (error: unknown) => {
      dispatchLocalPortDraft({
        type: 'failed',
        message: t(props.t, 'local.portFailed') + (error instanceof Error ? error.message : String(error)),
      })
    })
  }

  const applyRemoteLimit = (): void => {
    if (!remoteLimitView.valid || !can('setRemoteLimit')) {
      dispatchRemoteLimitDraft({ type: 'failed', message: t(props.t, 'remote.limitInvalid') })
      return
    }
    dispatchRemoteLimitDraft({ type: 'applied' })
    void Promise.resolve(props.setDeepPilotRemoteConnectionLimit!(remoteLimitView.value)).then(() => {
      dispatchRemoteLimitDraft({ type: 'succeeded', message: t(props.t, 'remote.limitApplied') })
    }, (error: unknown) => {
      dispatchRemoteLimitDraft({
        type: 'failed',
        message: t(props.t, 'remote.limitFailed') + (error instanceof Error ? error.message : String(error)),
      })
    })
  }

  const pairingTargets = report === null ? [] : selectPairingTargets(report.local, report.remote)
  const pairingTarget = pairingTargets.find(({ host }) => host === selectedPairingHost) ?? pairingTargets[0] ?? null
  const panel = pairingPanelView(pairingPanel)

  /**
   * Issue a grant and render the panel for one explicit target.
   *
   * The target is a parameter rather than component state on purpose: a click
   * handler must not depend on whether React has already re-rendered with the
   * newly selected host. A grant is bound to the host it was issued for, so
   * switching between LAN and public always mints a fresh one.
   */
  const showPairingQR = (target: PairingTarget): void => {
    if (!can('beginPairing')) return
    // Each request carries a token: a fast LAN/public switch can leave two
    // issues in flight, and only the newest may render its grant.
    const requestId = qrRequestId.current + 1
    qrRequestId.current = requestId
    dispatchPairingPanel({ type: 'show', target, requestId })
    void (props.beginPairing!() as Promise<PairingGrantSnapshot>)
      .then(async (grant: PairingGrantSnapshot) => {
        // The QR code and the copy field carry the same short link, so the app
        // accepts it from the camera and from the paste field alike.
        const link = encodePairingLink(target.host, grant, target.tlsFingerprint)
        return {
          grant,
          link,
          svg: await QRCode.toString(link, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 512 }),
        }
      })
      .then(({ grant, link, svg }) => {
        if (qrRequestId.current !== requestId) return
        dispatchPairingPanel({
          type: 'issued',
          requestId,
          grant,
          link,
          qrDataURL: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg),
        })
      }, (error: unknown) => {
        if (qrRequestId.current !== requestId) return
        dispatchPairingPanel({
          type: 'failed',
          requestId,
          message: t(props.t, 'pair.qrFailed') + (error instanceof Error ? error.message : String(error)),
        })
      })
  }

  const hidePairingQR = (): void => {
    // Invalidate any in-flight issue so a late response cannot reopen the panel.
    qrRequestId.current += 1
    dispatchPairingPanel({ type: 'close' })
  }

  const copyPairingInfo = (): void => {
    const link = pairingPanel.link
    if (link === null) return
    dispatchPairingPanel({ type: 'notice', message: '' })
    void writeClipboard(props.t as T, link).then(() => {
      dispatchPairingPanel({ type: 'notice', message: t(props.t, 'pair.infoCopyDone') })
    }, (error: unknown) => {
      dispatchPairingPanel({
        type: 'notice',
        message: t(props.t, 'pair.infoCopyFailed') + (error instanceof Error ? error.message : String(error)),
      })
    })
  }

  // Primary facts stay visible; technical details collapse into t(props.t, 'advanced.summary').
  const primaryRows: any[] = []
  const advancedRows: any[] = []
  if (report !== null) {
    primaryRows.push(
      h('div', { className: 'pbb-stat', key: 'conn' },
        h('span', { className: 'pbb-statLabel' }, t(props.t, 'panel.activeConnections')),
        h('span', { className: 'pbb-statValue' }, String(report.activeConnections))),
      h('div', { className: 'pbb-stat', key: 'identity' },
        h('span', { className: 'pbb-statLabel' }, t(props.t, 'panel.identity')),
        h('code', { className: 'pbb-token ' + (report.pairingReady ? 'pbb-ok' : 'pbb-bad') },
            report.pairingReady ? t(props.t, 'panel.identityReady') : t(props.t, 'panel.identityNotReady'))))
    if (report.local.phase === 'online' && report.local.tlsFingerprint) {
      advancedRows.push(
        h('div', { className: 'pbb-runtimeRow', key: 'tls' },
          h('div', { className: 'pbb-row' },
            h('span', { className: 'pbb-label' }, t(props.t, 'local.tlsFingerprint')),
            h('code', { className: 'pbb-token' }, report.local.tlsFingerprint))),
      )
    }
    advancedRows.push(
      h('div', { className: 'pbb-runtimeRow', key: 'proto' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.protocolVersion')),
          h('span', { className: 'pbb-value' }, 'v' + String(report.protocolVersion)))),
      h('div', { className: 'pbb-runtimeRow', key: 'server' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.serverVersion')),
          h('span', { className: 'pbb-value' }, report.serverVersion))),
      h('div', { className: 'pbb-runtimeRow', key: 'path' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.identityPath')),
          h('span', { className: 'pbb-value' }, report.identityPath))),
      h('div', { className: 'pbb-runtimeRow', key: 'buffer' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.bufferMax')),
          h('span', { className: 'pbb-value' }, String(report.historyBufferMax) + t(props.t, 'advanced.frames')))),
    )
  }

  const revokeDevice = (deviceId: string, name: string): void => {
    if (!can('revokeDevice')) return
    if (typeof window !== 'undefined' && !window.confirm(t(props.t, 'devices.revokeConfirm', { name }))) return
    setDeviceBusy(deviceId)
    setDeviceBusyAction('revoke')
    setDeviceMessage('')
    void props.revokeDevice!(deviceId).then(() => {
      setDeviceMessage(t(props.t, 'devices.revoked'))
    }, (error: unknown) => {
      setDeviceMessage(t(props.t, 'devices.revokeFailed') + (error instanceof Error ? error.message : String(error)))
    }).finally(() => {
      setDeviceBusy(null)
      setDeviceBusyAction(null)
    })
  }

  const deviceLabel = (device: { deviceName: string; customName?: string }): string =>
    deviceLabelOf(device) || t(props.t, 'devices.unnamed')

  const beginDeviceRename = (device: { deviceId: string; deviceName: string; customName?: string }): void => {
    setEditingDeviceId(device.deviceId)
    setDeviceNameDraft(device.customName ?? device.deviceName)
    setDeviceMessage('')
  }

  const cancelDeviceRename = (): void => {
    setEditingDeviceId(null)
    setDeviceNameDraft('')
    setDeviceMessage('')
  }

  const saveDeviceName = (deviceId: string): void => {
    if (!can('setDeviceName')) return
    const normalized = deviceNameDraft.trim()
    if (normalized.length > 64) {
      setDeviceMessage(t(props.t, 'devices.nameInvalid'))
      return
    }
    setDeviceBusy(deviceId)
    setDeviceBusyAction('rename')
    setDeviceMessage('')
    void props.setDeviceName!(deviceId, normalized === '' ? null : normalized).then(() => {
      setDeviceMessage(normalized === '' ? t(props.t, 'devices.nameCleared') : t(props.t, 'devices.renamed'))
      setEditingDeviceId(null)
      setDeviceNameDraft('')
    }, (error: unknown) => {
      setDeviceMessage(t(props.t, 'devices.renameFailed') + (error instanceof Error ? error.message : String(error)))
    }).finally(() => {
      setDeviceBusy(null)
      setDeviceBusyAction(null)
    })
  }

  const visibleDevices = visibleDevicesOf(report)
  const deviceTable = visibleDevices.length > 0
    ? h('div', { className: 'pbb-tableWrap' },
        h('table', { className: 'pbb-table' },
          h('thead', null, h('tr', null,
            h('th', null, t(props.t, 'devices.col.name')),
            h('th', null, t(props.t, 'devices.col.lastSeen')),
            h('th', { className: 'pbb-tableActionHead' }, t(props.t, 'devices.col.actions')))),
          h('tbody', null, visibleDevices.map((d) => {
            const editing = editingDeviceId === d.deviceId
            const busy = deviceBusy === d.deviceId
            const label = deviceLabel(d)
            return h('tr', { key: d.deviceId, 'aria-busy': busy },
              h('td', null,
                editing
                  ? h('form', {
                    className: 'pbb-deviceRenameForm',
                    onSubmit: (event: { preventDefault: () => void }) => {
                      event.preventDefault()
                      saveDeviceName(d.deviceId)
                    },
                  },
                    h('div', { className: 'pbb-deviceRenameControls' },
                      h('input', {
                        className: 'pbb-deviceNameInput',
                        type: 'text',
                        value: deviceNameDraft,
                        maxLength: 64,
                        autoFocus: true,
                        disabled: busy,
                        placeholder: t(props.t, 'devices.namePlaceholder'),
                        'aria-label': t(props.t, 'devices.nameLabel'),
                        onChange: (event: { currentTarget: { value: string } }) => setDeviceNameDraft(event.currentTarget.value),
                        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            saveDeviceName(d.deviceId)
                          } else if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelDeviceRename()
                          }
                        },
                      }),
                      h('div', { className: 'pbb-deviceRenameActions' },
                        h('button', {
                          type: 'submit',
                          className: 'pbb-action pbb-deviceIconAction pbb-buttonPrimary',
                          disabled: busy || deviceNameDraft.length > 64,
                          title: busy ? t(props.t, 'devices.nameSaving') : t(props.t, 'devices.nameSave'),
                          'aria-label': busy ? t(props.t, 'devices.nameSaving') : t(props.t, 'devices.nameSave'),
                        }, busy ? h('span', { className: 'pbb-inlineSpinner', 'aria-hidden': true }) : CheckIcon()),
                        h('button', {
                          type: 'button',
                          className: 'pbb-action pbb-deviceIconAction',
                          disabled: busy,
                          title: t(props.t, 'devices.nameCancel'),
                          'aria-label': t(props.t, 'devices.nameCancel'),
                          onClick: cancelDeviceRename,
                        }, CloseIcon()))),
                    deviceNameDraft.length > 64
                      ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'devices.nameInvalid'))
                      : null)
                  : h('div', null,
                    h('div', { className: 'pbb-deviceNameRow' },
                      h('span', { className: 'pbb-deviceName' }, label),
                      d.customName ? h('span', { className: 'pbb-badge' }, t(props.t, 'devices.customBadge')) : null),
                    h('span', { className: 'pbb-deviceMeta' },
                      d.appVersion,
                      ' · ',
                      h('code', null, (d.fingerprint ?? '').slice(0, 12))))),
              h('td', { className: 'pbb-lastSeen' }, new Date(d.lastSeenTs ?? 0).toLocaleString()),
              h('td', { className: 'pbb-tableActionCell' },
                !editing
                  ? h('button', {
                    type: 'button',
                    className: 'pbb-action',
                    disabled: busy || editingDeviceId !== null || !can('setDeviceName'),
                    'aria-label': t(props.t, 'devices.renameAria', { name: label }),
                    onClick: () => beginDeviceRename(d),
                  }, t(props.t, 'devices.rename'))
                  : null,
                h('button', {
                  type: 'button',
                  className: 'pbb-action pbb-actionDangerGhost',
                  disabled: busy,
                  'aria-label': busy && deviceBusyAction === 'revoke'
                    ? t(props.t, 'devices.deleting', { name: label })
                    : t(props.t, 'devices.revokeAria', { name: label }),
                  onClick: () => revokeDevice(d.deviceId, label),
                },
                  busy && deviceBusyAction === 'revoke' ? null : TrashIcon(),
                  busy && deviceBusyAction === 'revoke'
                    ? h('span', { className: 'pbb-actionBusy' }, t(props.t, 'devices.deleting'))
                    : t(props.t, 'devices.revoke'))))
          }))))
    : h('p', { className: 'pbb-empty' }, t(props.t, 'devices.empty'))

  const switchTitle = t(props.t, 'master.title')
  const switchDesc = switchReady
    ? (enabled
        ? t(props.t, 'master.on')
        : t(props.t, 'master.off'))
    : t(props.t, 'master.loading')
  const localMeta = report === null ? null : LOCAL_PHASE_META[report.local.phase]
  const remoteMeta = report === null ? null : REMOTE_PHASE_META[report.remote.phase]
  // 服务状态与点位由 view model 推导：不再用类名 includes 反推布尔。
  const service = serviceStatus({
    enabled,
    switchReady,
    localDot: localMeta?.dot,
    remoteDot: remoteMeta?.dot,
  })
  const serviceStatusText = t(props.t, SERVICE_STATUS_KEY[service.kind])
  const serviceDot = service.dot

  return h('div', { className: 'pbb-section' },
    h('header', { className: 'pbb-pageHeader' },
      h('div', null,
        h('h2', { className: 'pbb-title' }, 'DeepPilot'),
        h('p', { className: 'pbb-intro' }, t(props.t, 'meta.intro'))),
      h('button', {
        type: 'button',
        className: 'pbb-refresh',
        onClick: () => { if (can('refresh')) props.refresh!() },
      }, t(props.t, 'meta.refresh'))),
    h('div', { className: 'pbb-card pbb-primaryCard' },
      h('div', { className: 'pbb-cardHeader' },
        h('div', null,
          h('h3', { className: 'pbb-cardTitle' }, t(props.t, 'connection.title')),
          h('p', { className: 'pbb-cardDescription' }, t(props.t, 'connection.description'))),
        h('span', { className: 'pbb-statusBadge' },
          h('span', { className: 'pbb-dot' + serviceDot }),
          serviceStatusText)),
      h('div', { className: 'pbb-masterRow' },
        h('div', { className: 'pbb-switchText' },
          h('span', { className: 'pbb-switchTitle' }, switchTitle),
          h('span', { className: 'pbb-switchDesc' }, switchDesc)),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': enabled,
          'aria-label': switchTitle,
          disabled: !switchReady,
          className: 'pbb-switch' + (enabled ? ' pbb-switchOn' : ''),
          onClick: () => {
            if (can('setEnabled')) props.setDeepPilotEnabled!(!enabled)
          },
        }),
      ),
      h('div', { className: 'pbb-connectionGrid' },
        renderConnectionTile(
          'local',
          t(props.t, 'local.title'),
          localSwitchReady
            ? (localEnabled ? t(props.t, 'local.on', { port: localPort }) : t(props.t, 'local.off'))
            : t(props.t, 'master.loading'),
          localEnabled,
          localSwitchReady,
          localMeta?.dot ?? '',
          localMeta === null ? t(props.t, 'phase.unknown') : t(props.t, LOCAL_LABEL_KEY[localMeta.label]),
          () => {
            if (can('setLocalEnabled')) props.setDeepPilotLocalEnabled!(!localEnabled)
          },
          h(Fragment, null,
            report !== null && report.local.message && report.local.phase === 'error'
              ? h('p', { className: 'pbb-diag pbb-diagBad' }, report.local.message)
              : null,
            report !== null && report.local.tlsIdentityRegenerated === true
              ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'local.tlsRegenerated'))
              : null) as any,
        ),
        renderConnectionTile(
          'remote',
          t(props.t, 'remote.title'),
          remoteSwitchReady
            ? (remoteEnabled ? t(props.t, 'remote.on') : t(props.t, 'remote.off'))
            : t(props.t, 'master.loading'),
          remoteEnabled,
          remoteSwitchReady,
          remoteMeta?.dot ?? '',
          remoteMeta === null ? t(props.t, 'phase.unknown') : t(props.t, REMOTE_LABEL_KEY[remoteMeta.label]),
          () => {
            if (can('setRemoteEnabled')) props.setDeepPilotRemoteEnabled!(!remoteEnabled)
          },
          h(Fragment, null,
            report !== null && report.remote.phase === 'login_required'
              && typeof report.remote.authURL === 'string' && report.remote.authURL.startsWith('https://')
              ? h('div', { className: 'pbb-rowAction' },
                  h('a', { className: 'pbb-action pbb-buttonPrimary', href: report.remote.authURL, target: '_blank', rel: 'noreferrer' }, t(props.t, 'remote.openAuth')))
              : null,
            report !== null && report.remote.message && (report.remote.phase === 'error' || report.remote.phase === 'unavailable')
              ? h('p', { className: 'pbb-diag pbb-diagBad' }, report.remote.message)
              : null),
        )),
      report === null ? null : h('div', { className: 'pbb-statGrid' }, primaryRows),
      h('details', { className: 'pbb-inlineDetails' },
        h('summary', null, t(props.t, 'connection.optionsSummary')),
        h('div', { className: 'pbb-helpBody' },
          h('div', { className: 'pbb-limitRow pbb-limitNested' },
            h('div', { className: 'pbb-switchText' },
              h('label', { className: 'pbb-switchTitle', htmlFor: 'deeppilot-local-port' }, t(props.t, 'local.portTitle')),
              h('span', { className: 'pbb-switchDesc' }, t(props.t, 'local.portDescription')),
              !localPortView.valid
                ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'local.portInvalid'))
                : localPortDraft.message
                  ? h('p', {
                      className: 'pbb-diag' + (localPortDraft.failed ? ' pbb-diagBad' : ''),
                    }, localPortDraft.message)
                  : null,
            ),
            h('div', { className: 'pbb-limitControl' },
              h('input', {
                id: 'deeppilot-local-port',
                className: 'pbb-numberInput',
                type: 'number',
                min: LOCAL_PORT_RANGE.min,
                max: LOCAL_PORT_RANGE.max,
                step: 1,
                inputMode: 'numeric',
                value: localPortDraft.draft,
                disabled: !localPortReady,
                'aria-label': t(props.t, 'local.portTitle'),
                onChange: (event: { currentTarget: { value: string } }) => dispatchLocalPortDraft({ type: 'edit', draft: event.currentTarget.value }),
                onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    applyLocalPort()
                  }
                },
              }),
              h('button', {
                type: 'button',
                className: 'pbb-action',
                disabled: !localPortReady || !localPortView.valid || localPortView.unchanged,
                onClick: applyLocalPort,
              }, t(props.t, 'remote.limitApply')),
            ),
          ),
          h('div', { className: 'pbb-limitRow pbb-limitNested' },
            h('div', { className: 'pbb-switchText' },
              h('label', { className: 'pbb-switchTitle', htmlFor: 'deeppilot-funnel-source-limit' }, t(props.t, 'remote.limitTitle')),
              h('span', { className: 'pbb-switchDesc' }, t(props.t, 'remote.limitDescription')),
              !remoteLimitView.valid
                ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'remote.limitInvalid'))
                : remoteLimitDraft.message
                  ? h('p', {
                      className: 'pbb-diag' + (remoteLimitDraft.failed ? ' pbb-diagBad' : ''),
                    }, remoteLimitDraft.message)
                  : null,
            ),
            h('div', { className: 'pbb-limitControl' },
              h('input', {
                id: 'deeppilot-funnel-source-limit',
                className: 'pbb-numberInput',
                type: 'number',
                min: 1,
                max: REMOTE_LIMIT_RANGE.max,
                step: 1,
                inputMode: 'numeric',
                value: remoteLimitDraft.draft,
                disabled: !remoteConnectionLimitReady,
                'aria-label': t(props.t, 'remote.limitTitle'),
                onChange: (event: { currentTarget: { value: string } }) => dispatchRemoteLimitDraft({ type: 'edit', draft: event.currentTarget.value }),
                onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    applyRemoteLimit()
                  }
                },
              }),
              h('button', {
                type: 'button',
                className: 'pbb-action',
                disabled: !remoteConnectionLimitReady || !remoteLimitView.valid || remoteLimitView.unchanged,
                onClick: applyRemoteLimit,
              }, t(props.t, 'remote.limitApply')),
            ),
          ),
        ),
      ),
      h('details', { className: 'pbb-help' },
        h('summary', null, t(props.t, 'help.remoteTitle')),
        h('div', { className: 'pbb-helpBody' },
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, t(props.t, 'help.recommended')),
            h('ol', { className: 'pbb-helpList' },
              h('li', null, t(props.t, 'help.step1')),
              h('li', null, t(props.t, 'help.step2')),
              h('li', null, t(props.t, 'help.step3')),
              h('li', null, t(props.t, 'help.step4')),
            ),
            h('p', { className: 'pbb-helpText' }, t(props.t, 'help.funnelHint')),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, t(props.t, 'help.httpsTitle')),
            h('ol', { className: 'pbb-helpList' },
              h('li', null, t(props.t, 'help.httpsStep1')),
              h('li', null, t(props.t, 'help.httpsStep2')),
              h('li', null, t(props.t, 'help.httpsStep3')),
            ),
            h('p', { className: 'pbb-helpText' }, t(props.t, 'help.httpsHint')),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, t(props.t, 'help.allowTitle')),
            h('p', { className: 'pbb-helpText' }, t(props.t, 'help.allowBody')),
            h('code', { className: 'pbb-helpCode' }, '"nodeAttrs": [\n  {\n    "target": ["autogroup:member"],\n    "attr": ["funnel"],\n  },\n],'),
            h('p', { className: 'pbb-helpText' }, t(props.t, 'help.allowHint')),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, t(props.t, 'help.faqTitle')),
            h('ul', { className: 'pbb-helpList' },
              h('li', null, t(props.t, 'help.faq1')),
              h('li', null, t(props.t, 'help.faq2')),
              h('li', null, t(props.t, 'help.faq3')),
              h('li', null, t(props.t, 'help.faq4')),
            ),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, t(props.t, 'help.securityTitle')),
            h('ul', { className: 'pbb-helpList' },
              h('li', null, t(props.t, 'help.security1')),
              h('li', null, t(props.t, 'help.security2')),
              h('li', null, t(props.t, 'help.security3')),
              h('li', null, t(props.t, 'help.security4')),
              h('li', null, t(props.t, 'help.security5')),
            ),
            h('p', { className: 'pbb-helpText' },
              t(props.t, 'help.docsPrefix'),
              h('a', { className: 'pbb-helpLink', href: 'https://tailscale.com/docs/features/tailscale-funnel', target: '_blank', rel: 'noreferrer' }, t(props.t, 'help.funnelDocs'))),
          ),
        ),
      ),
    ),
    report === null ? null : h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-cardHeader' },
        h('div', null,
          h('h3', { className: 'pbb-cardTitle' }, t(props.t, 'pair.qrPanelTitle')),
          h('p', { className: 'pbb-cardDescription' }, t(props.t, 'pair.description'))),
        pairingTarget === null
          ? h('span', { className: 'pbb-statusBadge pbb-bad' }, t(props.t, 'pair.noAddress'))
          : h('button', {
            type: 'button',
            className: 'pbb-action pbb-buttonPrimary',
            disabled: panel.busy || !report.pairingReady,
            onClick: () => {
              if (panel.open) hidePairingQR()
              else showPairingQR(pairingTarget)
            },
          }, t(props.t, panel.action))),
      h('div', { className: 'pbb-pairingBody' },
        pairingTarget === null
          ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'pair.noAddressHelp'))
          : null,
        pairingTargets.length < 2 ? null : h('div', { className: 'pbb-targetList' },
          pairingTargets.map((target) => h('button', {
            type: 'button',
            key: target.host,
            className: 'pbb-targetButton' + (target.host === pairingTarget?.host ? ' pbb-targetSelected' : ''),
            // A grant is single-use and cannot be recalled, so a switch clicked
            // while one is already being issued would spend a second code that
            // nothing ever displays. Wait for the in-flight issue instead.
            disabled: panel.busy,
            onClick: () => {
              setSelectedPairingHost(target.host)
              // Switching between LAN and public keeps the panel open by
              // re-issuing a grant for the newly selected address, so both
              // networks are one tap away instead of a collapse and re-open.
              if (panel.open) showPairingQR(target)
              else hidePairingQR()
            },
          }, (target.kind === 'public' ? t(props.t, 'pair.kind.public') : t(props.t, 'pair.kind.lan')) + ' · ' + target.host)),
        ),
        panel.message ? h('p', { className: 'pbb-diag pbb-diagBad' }, panel.message) : null,
        panel.notice ? h('p', { className: 'pbb-diag' }, panel.notice) : null,
        panel.failed && pairingTarget !== null
          ? h('div', { className: 'pbb-rowAction' },
              h('button', {
                type: 'button',
                className: 'pbb-action',
                disabled: panel.busy || !report.pairingReady,
                onClick: () => showPairingQR(pairingTarget),
              }, t(props.t, 'pair.qrRetry')))
          : null,
        panel.open ? h('div', { className: 'pbb-qrPanel' },
          panel.qrDataURL === null ? h('p', { className: 'pbb-diag' }, t(props.t, 'pair.qrGenerating')) : h('img', {
            className: 'pbb-qrImage',
            src: panel.qrDataURL,
            alt: t(props.t, 'pair.qrAlt'),
          }),
          // The only credentials row on this page: host, single-use code and
          // (for LAN) the certificate pin travel together in one string, so the
          // phone needs one paste and nothing is shown twice.
          panel.link === null ? null : h('div', { className: 'pbb-pairCodeBlock' },
            h('span', { className: 'pbb-pairCodeLabel' }, t(props.t, 'pair.infoLabel')),
            h('div', { className: 'pbb-pairCodeRow' },
              h('code', { className: 'pbb-pairCode' }, panel.link),
              h('button', {
                type: 'button',
                className: 'pbb-action pbb-buttonPrimary',
                onClick: copyPairingInfo,
                'data-testid': 'pairingInfoCopy',
              }, t(props.t, 'panel.tokenAction.copy')))),
          h('p', { className: 'pbb-qrHint' },
            t(props.t, 'pair.qrHint', {
              kind: panel.target?.kind === 'public' ? t(props.t, 'pair.kind.public') : t(props.t, 'pair.kind.lan'),
            }),
          ),
        ) : null,
      ),
    ),
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-cardHeader' },
        h('div', null,
          h('h3', { className: 'pbb-cardTitle' }, t(props.t, 'devices.title')),
          h('p', { className: 'pbb-cardDescription' }, t(props.t, 'devices.description'))),
        h('span', { className: 'pbb-countBadge' }, String(visibleDevices.length))),
      h('div', { className: 'pbb-cardBody' },
        deviceMessage ? h('p', {
          className: 'pbb-diag' + (deviceMessage.startsWith(t(props.t, 'devices.renameFailed')) || deviceMessage.startsWith(t(props.t, 'devices.revokeFailed')) ? ' pbb-diagBad' : ''),
        }, deviceMessage) : null,
        deviceTable)),
    h('details', {
      className: 'pbb-card pbb-disclosure',
      open: troubleshootingOpen,
      onToggle: (event: { currentTarget: { open: boolean } }) => setTroubleshootingOpen(event.currentTarget.open),
    },
      h('summary', null,
        h('span', { className: 'pbb-disclosureTitle' }, t(props.t, 'troubleshooting.summary')),
        h('span', { className: 'pbb-disclosureMeta' },
          relayTestResult !== null
            ? (relayTestResult.overall === 'ok' ? t(props.t, 'push.relayOk') : t(props.t, 'push.relayBad'))
            : pushTestResult !== null
              ? (pushTestResult.overall === 'sent' ? t(props.t, 'push.pushSent') : t(props.t, 'push.pushFailed'))
              : t(props.t, 'troubleshooting.title'))),
      h('div', { className: 'pbb-disclosureBody' },
        h('div', { className: 'pbb-sectionIntro' },
          h('h3', { className: 'pbb-cardTitle' }, t(props.t, 'troubleshooting.title')),
          h('p', { className: 'pbb-cardDescription' }, t(props.t, 'troubleshooting.description'))),
        h('div', { className: 'pbb-testGrid' },
          h('div', { className: 'pbb-testItem' },
            h('div', { className: 'pbb-switchText' },
              h('span', { className: 'pbb-testTitle' }, t(props.t, 'push.relayTitle')),
              h('span', { className: 'pbb-testDescription' }, t(props.t, 'push.relayDefault'))),
            h('button', {
              type: 'button',
              className: 'pbb-action',
              disabled: relayTestBusy,
              onClick: runRelayTest,
            }, relayTestBusy ? t(props.t, 'push.relayTesting') : t(props.t, 'push.testRelay'))),
          h('div', { className: 'pbb-testItem' },
            h('div', { className: 'pbb-switchText' },
              h('span', { className: 'pbb-testTitle' }, t(props.t, 'push.testPush')),
              h('span', { className: 'pbb-testDescription' }, t(props.t, 'push.pushDefault'))),
            h('button', {
              type: 'button',
              className: 'pbb-action',
              disabled: pushTestBusy,
              onClick: sendPushTest,
            }, pushTestBusy ? t(props.t, 'push.pushSending') : t(props.t, 'push.testPush'))),
          h('div', { className: 'pbb-testItem' },
            h('div', { className: 'pbb-switchText' },
              h('span', { className: 'pbb-testTitle' }, t(props.t, 'troubleshooting.debugTitle')),
              h('span', { className: 'pbb-testDescription' }, t(props.t, 'troubleshooting.debugDescription'))),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': debugEnabled,
              'aria-label': t(props.t, 'troubleshooting.debugTitle'),
              disabled: !debugSwitchReady,
              className: 'pbb-switch' + (debugEnabled ? ' pbb-switchOn' : ''),
              onClick: () => {
                if (can('setDebug')) props.setDeepPilotDebug!(!debugEnabled)
              },
            }))),
        relayTestError ? h('p', { className: 'pbb-diag pbb-diagBad' }, relayTestError) : null,
        relayTestResult === null
          ? h('p', { className: 'pbb-diag' }, t(props.t, 'push.relayDefault'))
          : h('div', { className: 'pbb-helpBody' },
              h('div', { className: 'pbb-row' },
                h('span', { className: 'pbb-label' }, relayTestResult.url || t(props.t, 'push.relayUrlEmpty')),
                h('code', { className: 'pbb-token ' + (relayTestResult.overall === 'ok' ? 'pbb-ok' : 'pbb-bad') },
                  relayTestResult.overall === 'ok' ? t(props.t, 'push.relayOk') : t(props.t, 'push.relayBad')),
              ),
              relayTestResult.steps.map((step: any, index: number) =>
                h('p', { className: 'pbb-diag', key: String(index) },
                  (step.ok ? '✓ ' : '✗ ') + (step.id === 'health' ? t(props.t, 'push.relayStep.health') : t(props.t, 'push.relayStep.enroll'))
                    + (step.latencyMs !== undefined ? ` (${String(step.latencyMs)}ms)` : '')
                    + ' — ' + step.message),
              ),
            ),
        pushTestError ? h('p', { className: 'pbb-diag pbb-diagBad' }, pushTestError) : null,
        pushTestResult === null
          ? h('p', { className: 'pbb-diag' }, t(props.t, 'push.pushDefault'))
          : h('div', { className: 'pbb-helpBody' },
              h('div', { className: 'pbb-row' },
                h('code', { className: 'pbb-token ' + (pushTestResult.overall === 'sent' ? 'pbb-ok' : pushTestResult.overall === 'failed' ? 'pbb-bad' : '') },
                  pushTestResult.overall === 'sent' ? t(props.t, 'push.pushSent')
                    : pushTestResult.overall === 'failed' ? t(props.t, 'push.pushFailed')
                      : pushTestResult.overall === 'no-targets' ? t(props.t, 'push.pushNoTargets') : t(props.t, 'push.pushNotEnabled'))),
              pushTestResult.message ? h('p', { className: 'pbb-diag' }, pushTestResult.message) : null,
              pushTestResult.results.map((r: any, index: number) =>
                h('p', { className: 'pbb-diag', key: String(index) },
                  (r.outcome === 'sent' ? '✓ ' : '✗ ') + r.name + ' [' + r.environment + '] — '
                    + r.outcome + (r.reason ? '（' + r.reason + '）' : '')
                    + (r.tokenFingerprint ? '　token:' + r.tokenFingerprint + '…' : ''))),
            ),
      ),
    ),
    report === null ? null : h('details', { className: 'pbb-card pbb-disclosure' },
      h('summary', null,
        h('span', { className: 'pbb-disclosureTitle' }, t(props.t, 'system.summary')),
        h('span', { className: 'pbb-disclosureMeta' }, 'v' + report.pluginVersion)),
      h('div', { className: 'pbb-disclosureBody' },
        h('div', { className: 'pbb-sectionIntro' },
          h('h3', { className: 'pbb-cardTitle' }, t(props.t, 'system.title')),
          h('p', { className: 'pbb-cardDescription' }, t(props.t, 'system.description'))),
        h('div', { className: 'pbb-runtimeList' },
          h('div', { className: 'pbb-runtimeRow' },
            h('span', { className: 'pbb-label' }, 'DeepPilot'),
            h('span', { className: 'pbb-value' }, 'v' + report.pluginVersion)),
          advancedRows,
          report.updateAvailable === true
            ? h('div', { className: 'pbb-updateRow' },
                h('span', null, t(props.t, 'update.badge')),
                h('a', {
                  className: 'pbb-action pbb-buttonPrimary',
                  href: typeof report.releaseUrl === 'string' && /^https:\/\//.test(report.releaseUrl)
                    ? report.releaseUrl
                    : 'https://github.com/Mars-Sea/dsh-deeppilot/releases',
                  target: '_blank',
                  rel: 'noreferrer',
                }, t(props.t, 'update.badge')))
            : null))),
    diag.length > 0 ? h('details', {
      className: 'pbb-card pbb-disclosure pbb-diagnostics',
      open: failed,
    },
      h('summary', null, t(props.t, 'diag.summary')),
      h('div', { className: 'pbb-disclosureBody' },
        h('p', { className: 'pbb-diag' + (failed ? ' pbb-diagBad' : '') },
          t(props.t, 'diag.prefix') + diag.join(' | ')))) : null,
  )
}
