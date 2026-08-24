/**
 * Browser half of the dsh-deeppilot bundle.
 *
 * Registers a "DeepPilot" settings page following the exact structure of the
 * working settings pages in the harness: a controller + snapshot store
 * (createSnapshotStore) surfaced to the slot component as a `use` hook, with
 * the report fetched Host-side through the deeppilot/report Typert Remote.
 * The master switch (enabled) is read/written through the shared settings
 * namespace (`ctx.settingsScope.bind({ namespace: 'deeppilot' })`), the
 * same seam the Host registers via installSettingsSection.
 *
 * The slot `inject` MUST be a thunk returning the inject face — the renderer
 * calls `entry.inject(...)`; passing a plain object used to throw
 * "inject is not a function" inside the slot boundary and silently blank the
 * whole section. The component renders a visible diagnostic line on any
 * failure mode so a broken setup is never a silent blank panel.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createElement as h, useEffect, useState } from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import * as QRCode from 'qrcode/lib/browser.js'
import type { DeepPilotReport } from '../report-wire.ts'
import { encodePairingQRPayload, selectPairingTarget } from '../pairing-qr.ts'
import { mountReportRemote } from './report-mount.ts'
import type { ClientRemoteLike, ReportRemote } from './report-mount.ts'
import type { PushTestResult, RelayTestResult } from '../report-wire.ts'

type AnyCtx = Context & {
  locale?: { register: (key: string, table: unknown) => unknown; bind: (key: string) => (k: string) => string }
  remote?: ClientRemoteLike
  slots?: {
    inject: (name: string, cb: () => unknown) => unknown
    register: (entry: unknown, component: unknown) => unknown
  }
  settingsScope?: {
    bind(spec: { namespace: string }): SettingsScopeLike | undefined
  }
}

/** Minimal structural face over the settings-namespace scope (client contract). */
interface SettingsScopeLike {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value?: { enabled?: boolean; remote?: { enabled?: boolean; [key: string]: unknown } }
    writable?: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

const CSS = [
  '.pbb-section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}',
  '.pbb-title{margin:0;font-size:18px;font-weight:600}',
  '.pbb-intro{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}',
  '.pbb-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:4px 16px}',
  '.pbb-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
  '.pbb-field+.pbb-field{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.pbb-row{display:flex;align-items:center;gap:8px}',
  '.pbb-label{flex:1;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);min-width:0}',
  '.pbb-value{font-size:13px;color:var(--dsw-alias-label-secondary);word-break:break-all;text-align:right}',
  '.pbb-badge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;white-space:nowrap}',
  '.pbb-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));font-weight:500}',
  '.pbb-bad{color:var(--dsw-alias-label-error);font-weight:500}',
  '.pbb-table{width:100%;border-collapse:collapse;font-size:12px}',
  '.pbb-table th{color:var(--dsw-alias-label-tertiary);text-align:left;font-weight:500;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.pbb-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
  '.pbb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}',
  '.pbb-diag{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5}',
  '.pbb-diagBad{color:var(--dsw-alias-label-error)}',
  '.pbb-refresh{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;padding:0}',
  '.pbb-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
  '.pbb-refresh:disabled{cursor:default;opacity:.5}',
  '.pbb-tokenRow{flex-wrap:wrap}',
  '.pbb-token{max-width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
  '.pbb-tokenActions{display:flex;align-items:center;gap:8px}',
  '.pbb-action{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:3px 8px}',
  '.pbb-action:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}',
  '.pbb-action:disabled{cursor:default;opacity:.5}',
  '.pbb-actionDanger:not(:disabled){color:#fff;background:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}',
  '.pbb-qrPanel{display:flex;flex-direction:column;align-items:center;gap:9px;padding:12px 0 4px}',
  '.pbb-qrImage{width:240px;height:240px;max-width:100%;background:#fff;border-radius:10px;padding:8px;box-sizing:border-box}',
  '.pbb-qrHint{max-width:420px;text-align:center;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}',
  // master-switch row
  '.pbb-switchRow{padding:12px 0;display:flex;align-items:center;gap:12px}',
  '.pbb-switchRow+.pbb-field{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.pbb-switchText{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
  '.pbb-switchTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.pbb-dotRow{display:flex;align-items:center;gap:7px}',
  '.pbb-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}',
  '.pbb-dotOk{background:var(--dsw-alias-state-success-primary,#22a06b)}',
  '.pbb-dotWarn{background:var(--dsw-alias-state-warning-primary,#e2b203)}',
  '.pbb-dotBad{background:var(--dsw-alias-label-error)}',
  '.pbb-rowAction{display:flex;gap:8px;margin-top:4px}',
  '.pbb-switchDesc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4}',
  '.pbb-switch{appearance:none;-webkit-appearance:none;width:38px;height:22px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);position:relative;cursor:pointer;padding:0;flex:none;transition:background .15s ease}',
  '.pbb-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}',
  '.pbb-switchOn{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}',
  '.pbb-switchOn::after{transform:translateX(16px);background:#fff}',
  '.pbb-switch:disabled{opacity:.5;cursor:default}',
  '.pbb-help{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0}',
  '.pbb-help summary{cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;user-select:none}',
  '.pbb-help summary:hover{color:var(--dsw-alias-label-secondary)}',
  '.pbb-helpBody{display:flex;flex-direction:column;gap:14px;padding:12px 0 2px}',
  '.pbb-helpSection{display:flex;flex-direction:column;gap:6px}',
  '.pbb-helpHeading{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.pbb-helpList{margin:0;padding-left:20px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
  '.pbb-helpList li+li{margin-top:4px}',
  '.pbb-helpText{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
  '.pbb-helpCode{display:block;margin:2px 0 0;padding:10px;overflow:auto;white-space:pre-wrap;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}',
  '.pbb-helpLink{color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px}',
].join('\n')

function injectCss(): void {
  if (typeof document === 'undefined') return
  const id = 'dsh-deeppilot/page.css'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-deeppilot'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

async function writeClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    return
  } catch {
    // Some embedded browsers expire user activation while revealToken is in
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
  if (!copied) throw new Error('浏览器拒绝了剪贴板写入')
}

/** Controller state surfaced to the page through the snapshot store. */
export interface PageState {
  status: 'loading' | 'ready' | 'error'
  report: DeepPilotReport | null
  /** Visible diagnostic message for the error state. */
  message: string
}

/** Master-switch state surfaced to the page through its own snapshot store. */
export interface EnabledState {
  status: 'loading' | 'ready' | 'unavailable'
  enabled: boolean
}

export interface RemoteEnabledState {
  status: 'loading' | 'ready' | 'unavailable'
  enabled: boolean
}

/** Polls the report remote and owns the page state transitions. */
class ReportController {
  private listeners = new Set<() => void>()
  private snap: PageState = { status: 'loading', report: null, message: '' }

  constructor(private readonly fetchReport: () => Promise<DeepPilotReport | null>) {}

  state(): PageState {
    return this.snap
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.listeners.clear()
  }

  async refresh(): Promise<void> {
    try {
      const report = await this.fetchReport()
      this.snap = report !== null
        ? { status: 'ready', report, message: '' }
        : { status: 'error', report: null, message: '报告远程未挂载（remote mount 失败）— 请确认宿主包含 typert 组合' }
    } catch (error) {
      this.snap = { status: 'error', report: null, message: error instanceof Error ? error.message : String(error) }
    }
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* listener errors stay isolated */ }
    }
  }
}

export const inject: readonly string[] = ['slots', 'locale', 'remote', 'settingsScope']

export function apply(ctx: Context): void {
  if (typeof document !== 'undefined') injectCss()
  const anyCtx = ctx as AnyCtx

  anyCtx.locale?.register('settings.deeppilot', {
    zh: { nav: 'DeepPilot' },
    en: { nav: 'DeepPilot' },
  })

  let namespace: ReportRemote | undefined
  let mountError: string | undefined

  const fetchReport = async (): Promise<DeepPilotReport | null> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined ? 'remote mount 失败: ' + mountError : 'report remote 未挂载')
    }
    const result = await namespace.report()
    if (!result.ok) throw new Error(result.error.message ?? 'report remote 调用失败')
    return result.value
  }

  const controller = new ReportController(fetchReport)
  ctx.effect(() => () => controller.dispose(), 'dsh-deeppilot: report controller')
  const store = createSnapshotStore<PageState>(controller.state())
  controller.subscribe(() => store.set(controller.state()))

  ctx.effect(() => {
    let cancelled = false
    let unmount: (() => Promise<void>) | undefined
    if (anyCtx.remote === undefined) {
      mountError = 'remote 服务不可用'
      void controller.refresh()
      return () => {}
    }
    void mountReportRemote(
      anyCtx.remote,
      () => ctx.get('remote.deeppilot') as ReportRemote | undefined,
    )
      .then((mounted) => {
        if (cancelled) { void mounted.dispose(); return }
        namespace = mounted.namespace
        unmount = mounted.dispose
        mountError = undefined
        void controller.refresh()
      }, (error: unknown) => {
        mountError = error instanceof Error ? error.message : String(error)
        void controller.refresh()
      })
    return () => {
      cancelled = true
      namespace = undefined
      if (unmount !== undefined) void unmount()
    }
  }, 'dsh-deeppilot: report remote mount')

  const revealPairingToken = async (): Promise<string> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined ? 'remote mount 失败: ' + mountError : 'report remote 未挂载')
    }
    const result = await namespace.revealToken()
    if (!result.ok) throw new Error(result.error.message ?? 'Token 读取失败')
    return result.value
  }

  const sendTestPush = async (): Promise<PushTestResult> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined ? 'remote mount 失败: ' + mountError : 'report remote 未挂载')
    }
    if (typeof namespace.testPush !== 'function') {
      throw new Error('宿主插件版本较旧，不支持推送测试 — 请更新 dsh-deeppilot')
    }
    const result = await namespace.testPush()
    if (!result.ok) throw new Error(result.error.message ?? '推送测试失败')
    return result.value
  }

  const testRelayConnection = async (): Promise<RelayTestResult> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined ? 'remote mount 失败: ' + mountError : 'report remote 未挂载')
    }
    if (typeof namespace.testRelay !== 'function') {
      throw new Error('宿主插件版本较旧，不支持中继测试 — 请更新 dsh-deeppilot')
    }
    const result = await namespace.testRelay()
    if (!result.ok) throw new Error(result.error.message ?? '中继测试失败')
    return result.value
  }

  // Rotation is a destructive, explicit action: the old token stops working
  // immediately and every paired device must re-pair with the fresh secret.
  const rotatePairingToken = async (): Promise<string> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined ? 'remote mount 失败: ' + mountError : 'report remote 未挂载')
    }
    const result = await namespace.rotateToken()
    if (!result.ok) throw new Error(result.error.message ?? 'Token 更换失败')
    return result.value
  }

  // Master switch: mirror the durable `enabled` field of the deeppilot
  // settings namespace (Host side registered via installSettingsSection).
  const enabledStore = createSnapshotStore<EnabledState>({ status: 'loading', enabled: true })
  const scope = anyCtx.settingsScope?.bind({ namespace: 'deeppilot' })
  const adoptEnabled = (): void => {
    if (scope === undefined) return
    const snap = scope.getSnapshot()
    if (snap.status === 'ready' && snap.value !== undefined) {
      enabledStore.set({ status: 'ready', enabled: snap.value.enabled !== false })
    } else if (snap.status === 'unavailable') {
      enabledStore.set({ status: 'unavailable', enabled: true })
    }
  }
  if (scope !== undefined) {
    scope.subscribe(adoptEnabled)
    adoptEnabled()
  }

  const setDeepPilotEnabled = (value: boolean): void => {
    enabledStore.set({ status: 'ready', enabled: value })
    if (scope !== undefined) void scope.set('enabled', value)
  }

  const remoteEnabledStore = createSnapshotStore<RemoteEnabledState>({ status: 'loading', enabled: false })
  const adoptRemoteEnabled = (): void => {
    if (scope === undefined) return
    const snap = scope.getSnapshot()
    if (snap.status === 'ready') {
      remoteEnabledStore.set({ status: 'ready', enabled: snap.value?.remote?.enabled === true })
    } else if (snap.status === 'unavailable') {
      remoteEnabledStore.set({ status: 'unavailable', enabled: false })
    }
  }
  if (scope !== undefined) {
    scope.subscribe(adoptRemoteEnabled)
    adoptRemoteEnabled()
  }

  const setDeepPilotRemoteEnabled = (value: boolean): void => {
    remoteEnabledStore.set({ status: 'ready', enabled: value })
    if (scope === undefined) return
    const currentRemote = scope.getSnapshot().value?.remote ?? {}
    void scope.set('remote', { ...currentRemote, enabled: value })
  }

  anyCtx.slots?.inject('settings.section', () =>
    (anyCtx.slots as NonNullable<AnyCtx['slots']>).register({
      name: 'settings.section',
      id: 'deeppilot',
      order: 13,
      label: () => {
        const bind = anyCtx.locale?.bind('settings.deeppilot')
        return bind ? bind('nav') : 'DeepPilot'
      },
      locale: 'settings.deeppilot',
      inject: () => ({
        hooks: {
          deepPilotReport: store,
          deepPilotEnabled: enabledStore,
          deepPilotRemoteEnabled: remoteEnabledStore,
        },
        refresh: () => { void controller.refresh() },
        revealPairingToken,
        rotatePairingToken,
        testRelay: testRelayConnection,
        testPush: sendTestPush,
        setDeepPilotEnabled,
        setDeepPilotRemoteEnabled,
      }),
    }, DeepPilotSettingsPage),
  )
}

/** Visual state of the embedded Funnel: a colored dot plus its spoken label. */
const REMOTE_PHASE_META: Record<DeepPilotReport['remote']['phase'], { dot: string; label: string }> = {
  disabled: { dot: '', label: '未启用' },
  starting: { dot: ' pbb-dotWarn', label: '正在启动' },
  login_required: { dot: ' pbb-dotWarn', label: '等待 Tailscale 授权' },
  online: { dot: ' pbb-dotOk', label: '远程连接已就绪' },
  error: { dot: ' pbb-dotBad', label: '远程连接失败' },
  unavailable: { dot: ' pbb-dotBad', label: '远程 helper 不可用' },
  stopped: { dot: '', label: '已停止' },
}

/** Slot component: hooks come from the slot renderer, named use<Key>. */
export function DeepPilotSettingsPage(props: Record<string, any>): any {
  const [revealedToken, setRevealedToken] = useState<string | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenMessage, setTokenMessage] = useState('')
  const [rotateArmed, setRotateArmed] = useState(false)
  const [remoteMessage, setRemoteMessage] = useState('')
  const [qrDataURL, setQRDataURL] = useState<string | null>(null)
  const [qrBusy, setQRBusy] = useState(false)
  const [qrMessage, setQRMessage] = useState('')
  const [relayTestBusy, setRelayTestBusy] = useState(false)
  const [relayTestResult, setRelayTestResult] = useState<RelayTestResult | null>(null)
  const [relayTestError, setRelayTestError] = useState('')
  const [pushTestBusy, setPushTestBusy] = useState(false)
  const [pushTestResult, setPushTestResult] = useState<PushTestResult | null>(null)
  const [pushTestError, setPushTestError] = useState('')

  useEffect(() => {
    if (typeof props.refresh !== 'function') return
    props.refresh()
    const timer = globalThis.setInterval(() => props.refresh(), 3_000)
    return () => globalThis.clearInterval(timer)
  }, [props.refresh])

  const sendPushTest = (): void => {
    if (pushTestBusy) return
    if (typeof props.testPush !== 'function') {
      setPushTestError('宿主插件版本较旧，不支持推送测试')
      return
    }
    setPushTestBusy(true)
    setPushTestError('')
    void props.testPush().then((result: PushTestResult) => {
      setPushTestResult(result)
      setPushTestBusy(false)
    }, (error: unknown) => {
      setPushTestError(error instanceof Error ? error.message : String(error))
      setPushTestBusy(false)
    })
  }

  const runRelayTest = (): void => {
    if (relayTestBusy) return
    if (typeof props.testRelay !== 'function') {
      setRelayTestError('宿主插件版本较旧，不支持中继测试')
      return
    }
    setRelayTestBusy(true)
    setRelayTestError('')
    void props.testRelay().then((result: RelayTestResult) => {
      setRelayTestResult(result)
      setRelayTestBusy(false)
    }, (error: unknown) => {
      setRelayTestError(error instanceof Error ? error.message : String(error))
      setRelayTestBusy(false)
    })
  }

  useEffect(() => {
    if (revealedToken === null) return
    const timer = globalThis.setTimeout(() => {
      setRevealedToken(null)
      setTokenMessage('Token 已自动隐藏')
    }, 30_000)
    return () => globalThis.clearTimeout(timer)
  }, [revealedToken])

  useEffect(() => {
    if (!tokenMessage) return
    const timer = globalThis.setTimeout(() => setTokenMessage(''), 4_000)
    return () => globalThis.clearTimeout(timer)
  }, [tokenMessage])

  // The armed rotate button disarms itself so a stray click never rotates.
  useEffect(() => {
    if (!rotateArmed) return
    const timer = globalThis.setTimeout(() => setRotateArmed(false), 5_000)
    return () => globalThis.clearTimeout(timer)
  }, [rotateArmed])

  useEffect(() => {
    if (!remoteMessage) return
    const timer = globalThis.setTimeout(() => setRemoteMessage(''), 2_500)
    return () => globalThis.clearTimeout(timer)
  }, [remoteMessage])

  useEffect(() => {
    if (qrDataURL === null) return
    const timer = globalThis.setTimeout(() => {
      setQRDataURL(null)
      setQRMessage('配对二维码已自动隐藏')
    }, 60_000)
    return () => globalThis.clearTimeout(timer)
  }, [qrDataURL])

  useEffect(() => {
    if (!qrMessage) return
    const timer = globalThis.setTimeout(() => setQRMessage(''), 2_500)
    return () => globalThis.clearTimeout(timer)
  }, [qrMessage])

  const diag: string[] = []
  let report: DeepPilotReport | null = null
  let enabled: boolean = true
  let switchReady = false
  let remoteEnabled = false
  let remoteSwitchReady = false
  let failed = false

  try {
    if (typeof props.useDeepPilotReport !== 'function') {
      diag.push('useDeepPilotReport hook 缺失')
      failed = true
    } else {
      const state = props.useDeepPilotReport((s: PageState) => s)
      report = state.report
      if (state.status === 'error' && state.message) {
        diag.push(state.message)
        failed = true
      }
    }
    if (typeof props.useDeepPilotEnabled === 'function') {
      const state = props.useDeepPilotEnabled((s: EnabledState) => s)
      enabled = state.enabled
      switchReady = state.status === 'ready'
      if (state.status === 'unavailable') diag.push('设置命名空间不可用（settingsScope 未提供）')
    } else {
      diag.push('useDeepPilotEnabled hook 缺失')
    }
    if (typeof props.refresh !== 'function') diag.push('refresh 回调缺失')
    if (typeof props.revealPairingToken !== 'function') diag.push('revealPairingToken 回调缺失')
    if (typeof props.rotatePairingToken !== 'function') diag.push('rotatePairingToken 回调缺失')
    if (typeof props.testRelay !== 'function') diag.push('testRelay 回调缺失')
    if (typeof props.testPush !== 'function') diag.push('testPush 回调缺失')
    if (typeof props.setDeepPilotEnabled !== 'function') diag.push('setDeepPilotEnabled 回调缺失')
    if (typeof props.useDeepPilotRemoteEnabled === 'function') {
      const state = props.useDeepPilotRemoteEnabled((s: RemoteEnabledState) => s)
      remoteEnabled = state.enabled
      remoteSwitchReady = state.status === 'ready'
    } else {
      diag.push('useDeepPilotRemoteEnabled hook 缺失')
    }
    if (typeof props.setDeepPilotRemoteEnabled !== 'function') diag.push('setDeepPilotRemoteEnabled 回调缺失')
  } catch (error) {
    diag.push('渲染异常: ' + (error instanceof Error ? error.message : String(error)))
    failed = true
  }

  const pairingTarget = report === null
    ? null
    : selectPairingTarget(
        report.remote,
        report.lanAddresses,
        typeof window === 'undefined' ? undefined : window.location.origin,
      )

  useEffect(() => {
    setQRDataURL(null)
  }, [pairingTarget?.host])

  const toggleToken = (): void => {
    if (revealedToken !== null) {
      setRevealedToken(null)
      setTokenMessage('')
      return
    }
    if (typeof props.revealPairingToken !== 'function') return
    setTokenBusy(true)
    setTokenMessage('')
    void props.revealPairingToken().then((token: string) => {
      setRevealedToken(token)
    }, (error: unknown) => {
      setTokenMessage('Token 读取失败：' + (error instanceof Error ? error.message : String(error)))
    }).finally(() => setTokenBusy(false))
  }

  const copyToken = (): void => {
    if (typeof props.revealPairingToken !== 'function') return
    setTokenBusy(true)
    setTokenMessage('')
    const tokenPromise = revealedToken !== null
      ? Promise.resolve(revealedToken)
      : props.revealPairingToken() as Promise<string>
    void tokenPromise
      .then((value: string) => writeClipboard(value))
      .then(() => setTokenMessage('已复制到剪贴板'), (error: unknown) => {
        setTokenMessage('复制失败：' + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setTokenBusy(false))
  }

  const rotateToken = (): void => {
    if (typeof props.rotatePairingToken !== 'function') return
    if (!rotateArmed) {
      setRotateArmed(true)
      setRevealedToken(null)
      setQRDataURL(null)
      setTokenMessage('更换会使当前 Token 立即失效、断开所有手机连接；5 秒内再次点击确认。')
      return
    }
    setRotateArmed(false)
    setTokenBusy(true)
    setTokenMessage('')
    void (props.rotatePairingToken() as Promise<string>)
      .then((token: string) => {
        setRevealedToken(token)
        setTokenMessage('新 Token 已生效，旧 Token 已失效；请重新配对所有设备。')
      }, (error: unknown) => {
        setTokenMessage('更换失败：' + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setTokenBusy(false))
  }

  const copyRemoteURL = (url: string): void => {
    setRemoteMessage('')
    void writeClipboard(url).then(() => {
      setRemoteMessage('公网地址已复制')
    }, (error: unknown) => {
      setRemoteMessage('复制失败：' + (error instanceof Error ? error.message : String(error)))
    })
  }

  const showPairingQR = (): void => {
    if (typeof props.revealPairingToken !== 'function' || pairingTarget === null) return
    setQRBusy(true)
    setQRMessage('')
    setQRDataURL(null)
    void (props.revealPairingToken() as Promise<string>)
      .then((pairingToken: string) => QRCode.toString(
        encodePairingQRPayload(pairingTarget.host, pairingToken),
        { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 512 },
      ))
      .then((svg: string) => setQRDataURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)), (error: unknown) => {
        setQRMessage('二维码生成失败：' + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setQRBusy(false))
  }

  // Primary facts stay visible; technical details collapse into 高级信息.
  const primaryRows: any[] = []
  const advancedRows: any[] = []
  if (report !== null) {
    primaryRows.push(
      h('div', { className: 'pbb-field', key: 'conn' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, '当前连接'),
          h('span', { className: 'pbb-value' }, String(report.activeConnections)))),
      h('div', { className: 'pbb-field', key: 'token' },
        h('div', { className: 'pbb-row pbb-tokenRow' },
          h('span', { className: 'pbb-label' }, '配对 Token'),
          h('code', { className: 'pbb-token ' + (report.tokenReady ? 'pbb-ok' : 'pbb-bad') },
            report.tokenReady ? (revealedToken ?? '••••••••••••') : '未生成'),
          report.tokenReady
            ? h('span', { className: 'pbb-tokenActions' },
                h('button', {
                  type: 'button',
                  className: 'pbb-action',
                  disabled: tokenBusy,
                  onClick: toggleToken,
                }, tokenBusy ? '读取中…' : (revealedToken === null ? '显示' : '隐藏')),
                h('button', {
                  type: 'button',
                  className: 'pbb-action',
                  disabled: tokenBusy,
                  onClick: copyToken,
                }, '复制'),
                h('button', {
                  type: 'button',
                  className: 'pbb-action' + (rotateArmed ? ' pbb-actionDanger' : ''),
                  disabled: tokenBusy,
                  onClick: rotateToken,
                }, rotateArmed ? '确认更换？' : (tokenBusy ? '更换中…' : '更换')))
            : null),
        tokenMessage ? h('p', { className: 'pbb-diag' }, tokenMessage) : null),
    )
    advancedRows.push(
      h('div', { className: 'pbb-field', key: 'proto' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, '协议版本'),
          h('span', { className: 'pbb-value' }, 'v' + String(report.protocolVersion)))),
      h('div', { className: 'pbb-field', key: 'server' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, '服务器版本'),
          h('span', { className: 'pbb-value' }, report.serverVersion))),
      h('div', { className: 'pbb-field', key: 'path' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, 'Token 路径'),
          h('span', { className: 'pbb-value' }, report.tokenPath))),
      h('div', { className: 'pbb-field', key: 'buffer' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, '重放缓冲上限'),
          h('span', { className: 'pbb-value' }, String(report.historyBufferMax) + ' 帧'))),
    )
  }

  const deviceTable = report !== null && report.devices.length > 0
    ? h('table', { className: 'pbb-table' },
        h('thead', null, h('tr', null,
          h('th', null, '设备'), h('th', null, 'App 版本'), h('th', null, '离线推送'), h('th', null, '最近在线'))),
        h('tbody', null, report.devices.map((d) =>
          h('tr', { key: d.deviceId },
            h('td', null, d.deviceName),
            h('td', null, d.appVersion),
            h('td', null, d.apns
              ? '已注册（' + (d.apns.environment === 'production' ? '生产' : '开发') + '）'
              : '未注册'),
            h('td', null, new Date(d.lastSeenTs).toLocaleString())))))
    : h('p', { className: 'pbb-empty' }, '还没有设备配对过。在 iPhone 上的 DeepPilot App 中扫码或填入本机地址与 Token 即可配对。')

  const switchTitle = 'DeepPilot 连接'
  const switchDesc = switchReady
    ? (enabled
        ? '已开启：接受手机连接。'
        : '已关闭：不接受手机连接。')
    : '正在读取配置…'

  return h('div', { className: 'pbb-section' },
    h('div', { className: 'pbb-row' },
      h('h2', { className: 'pbb-title' }, 'DeepPilot'),
      h('button', {
        className: 'pbb-refresh',
        onClick: () => { if (typeof props.refresh === 'function') props.refresh() },
      }, '刷新'),
    ),
    h('p', { className: 'pbb-intro' }, '把 iPhone 与这台电脑上的 DeepSeek Harness（DSH）连接起来（协议 v1）。'),
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-switchRow' },
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
            if (typeof props.setDeepPilotEnabled === 'function') {
              props.setDeepPilotEnabled(!enabled)
            }
          },
        }),
      ),
      h('div', { className: 'pbb-switchRow' },
        h('div', { className: 'pbb-switchText' },
          h('span', { className: 'pbb-switchTitle pbb-dotRow' },
            h('span', {
              className: 'pbb-dot' + (report !== null ? REMOTE_PHASE_META[report.remote.phase].dot : ''),
              role: 'img',
              'aria-label': report !== null ? REMOTE_PHASE_META[report.remote.phase].label : '状态未知',
              title: report !== null ? REMOTE_PHASE_META[report.remote.phase].label : undefined,
            }),
            '远程连接（Tailscale Funnel）'),
          h('span', { className: 'pbb-switchDesc' }, remoteSwitchReady
            ? (remoteEnabled ? '已配置：内嵌 Funnel 会自动启动并同步状态。' : '关闭：仅保留局域网连接。')
            : '正在读取配置…'),
          report !== null && report.remote.phase === 'login_required'
            && typeof report.remote.authURL === 'string' && report.remote.authURL.startsWith('https://')
            ? h('div', { className: 'pbb-rowAction' },
                h('a', { className: 'pbb-action', href: report.remote.authURL, target: '_blank', rel: 'noreferrer' }, '打开授权页面'))
            : null,
          report !== null && report.remote.message && (report.remote.phase === 'error' || report.remote.phase === 'unavailable')
            ? h('p', { className: 'pbb-diag pbb-diagBad' }, report.remote.message)
            : null,
          remoteMessage ? h('p', { className: 'pbb-diag' }, remoteMessage) : null,
        ),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': remoteEnabled,
          'aria-label': '远程连接',
          disabled: !remoteSwitchReady,
          className: 'pbb-switch' + (remoteEnabled ? ' pbb-switchOn' : ''),
          onClick: () => {
            if (typeof props.setDeepPilotRemoteEnabled === 'function') {
              props.setDeepPilotRemoteEnabled(!remoteEnabled)
            }
          },
        }),
      ),
      h('details', { className: 'pbb-help' },
        h('summary', null, '远程连接帮助'),
        h('div', { className: 'pbb-helpBody' },
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, '推荐设置流程'),
            h('ol', { className: 'pbb-helpList' },
              h('li', null, '先打开“DeepPilot 连接”，再打开“远程连接（Tailscale Funnel）”。'),
              h('li', null, '状态变为“等待 Tailscale 授权”后，点击“打开授权页面”。'),
              h('li', null, '使用有权管理此 Tailnet 的账号登录，并按授权页提示启用 Funnel。通常需要 Owner、Admin 或 Network admin 权限。'),
              h('li', null, '返回此页面并点击“刷新”。远程连接标题旁出现绿点后，即可扫描下方二维码添加手机。'),
            ),
            h('p', { className: 'pbb-helpText' }, '插件已内嵌 Tailscale 网络组件，这台电脑和手机都不需要另外安装 Tailscale App；但首次启用仍需由 Tailnet 管理员授权。'),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, '授权页未自动完成时：开启 HTTPS'),
            h('ol', { className: 'pbb-helpList' },
              h('li', null, '打开 Tailscale 管理后台的 Network → DNS。'),
              h('li', null, '确认 MagicDNS 已开启。'),
              h('li', null, '在 HTTPS Certificates 中点击 Enable HTTPS。'),
            ),
            h('p', { className: 'pbb-helpText' }, '启用 HTTPS 后，设备的完整域名会写入公开的证书透明度日志。如果设备名包含敏感信息，请先在 Tailscale 中重命名设备。'),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, '授权页未自动完成时：允许 Funnel'),
            h('p', { className: 'pbb-helpText' }, '打开 Access controls → Definitions，选择 Node attributes。在现有 nodeAttrs 数组中追加下面这一项；不要覆盖已有访问规则，也不要创建第二个 nodeAttrs 顶层字段。'),
            h('code', { className: 'pbb-helpCode' }, '"nodeAttrs": [\n  {\n    "target": ["autogroup:member"],\n    "attr": ["funnel"],\n  },\n],'),
            h('p', { className: 'pbb-helpText' }, '保存策略后回到本页刷新。公共 DNS 和权限变更可能需要几分钟生效。'),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, '常见问题'),
            h('ul', { className: 'pbb-helpList' },
              h('li', null, '提示“HTTPS must be enabled”：完成上面的 HTTPS Certificates 设置。'),
              h('li', null, '提示“Funnel not available”：确认 nodeAttrs 已保存，并且当前节点属于规则的 target。'),
              h('li', null, '已有公网地址但手机超时：等待几分钟后重试，同时确认这台电脑未休眠、DSH 正在运行，再重新扫描最新二维码。'),
              h('li', null, '没有公网地址：检查 Tailscale 授权是否完成，然后点击“刷新”或重启 DSH。'),
            ),
          ),
          h('div', { className: 'pbb-helpSection' },
            h('div', { className: 'pbb-helpHeading' }, '安全说明'),
            h('ul', { className: 'pbb-helpList' },
              h('li', null, 'Funnel 公网地址可从互联网访问，但手机接口仍需要配对 Token。不要分享二维码、Token 或包含它们的截图。'),
              h('li', null, '怀疑 Token 泄露时，点击上方“更换”生成新 Token：旧 Token 立即失效，所有已连接设备会被断开并需要重新配对。'),
              h('li', null, '插件只通过 Funnel 转发 /phone 和 /phone/health，不会新增 3098 端口。'),
              h('li', null, '局域网连接沿用 DSH 的 3080 端口；仅在可信网络中使用，不建议直接把 3080 暴露到公网。'),
              h('li', null, '关闭远程连接开关会停止 Funnel，但不会影响可用的局域网连接。'),
            ),
            h('p', { className: 'pbb-helpText' },
              '更多信息：',
              h('a', { className: 'pbb-helpLink', href: 'https://tailscale.com/docs/features/tailscale-funnel', target: '_blank', rel: 'noreferrer' }, 'Tailscale Funnel 官方文档')),
          ),
        ),
      ),
    ),
    report === null ? null : h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-field' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, '扫码添加当前手机'),
          pairingTarget === null
            ? h('span', { className: 'pbb-value pbb-bad' }, '没有可用地址')
            : h('span', { className: 'pbb-tokenActions' },
                h('span', { className: 'pbb-badge' }, pairingTarget.kind === 'public' ? '公网' : '内网'),
                h('button', {
                  type: 'button',
                  className: 'pbb-action',
                  disabled: qrBusy || !report.tokenReady,
                  onClick: () => {
                    if (qrDataURL === null) showPairingQR()
                    else setQRDataURL(null)
                  },
                }, qrBusy ? '生成中…' : (qrDataURL === null ? '显示二维码' : '隐藏二维码')))),
        pairingTarget === null
          ? h('p', { className: 'pbb-diag pbb-diagBad' }, '未发现可供手机访问的局域网地址，请确认这台电脑已连接局域网。')
          : null,
        qrMessage ? h('p', { className: 'pbb-diag' }, qrMessage) : null,
        pairingTarget === null || qrDataURL === null ? null : h('div', { className: 'pbb-qrPanel' },
          h('img', {
            className: 'pbb-qrImage',
            src: qrDataURL,
            alt: 'DeepPilot 配对二维码',
          }),
          h('div', { className: 'pbb-row' },
            h('code', { className: 'pbb-token' }, pairingTarget.host),
            h('button', {
              type: 'button',
              className: 'pbb-action',
              onClick: () => copyRemoteURL(pairingTarget.host),
            }, '复制')),
          h('p', { className: 'pbb-qrHint' },
            `二维码包含${pairingTarget.kind === 'public' ? '公网' : '内网'}地址和配对 Token，将在 60 秒后自动隐藏。`),
        ),
      ),
    ),
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-field' },
        primaryRows,
        advancedRows.length > 0 ? h('details', { className: 'pbb-help' },
          h('summary', null, '高级信息'),
          h('div', { className: 'pbb-helpBody' }, advancedRows),
        ) : null,
      ),
    ),
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-field' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, '离线推送中继'),
          h('span', { className: 'pbb-tokenActions' },
            h('button', {
              type: 'button',
              className: 'pbb-action',
              disabled: relayTestBusy,
              onClick: runRelayTest,
            }, relayTestBusy ? '测试中…' : '测试访问与注册'),
            h('button', {
              type: 'button',
              className: 'pbb-action',
              disabled: pushTestBusy,
              onClick: sendPushTest,
            }, pushTestBusy ? '发送中…' : '发送测试通知')),
        ),
        relayTestError ? h('p', { className: 'pbb-diag pbb-diagBad' }, relayTestError) : null,
        relayTestResult === null
          ? h('p', { className: 'pbb-diag' }, '验证 Mac 到推送中继的连通性与自动注册是否正常。')
          : h('div', { className: 'pbb-helpBody' },
              h('div', { className: 'pbb-row' },
                h('span', { className: 'pbb-label' }, relayTestResult.url || '（未启用）'),
                h('code', { className: 'pbb-token ' + (relayTestResult.overall === 'ok' ? 'pbb-ok' : 'pbb-bad') },
                  relayTestResult.overall === 'ok' ? '通过' : '存在问题'),
              ),
              relayTestResult.steps.map((step: any, index: number) =>
                h('p', { className: 'pbb-diag', key: String(index) },
                  (step.ok ? '✓ ' : '✗ ') + (step.id === 'health' ? '服务可达' : '自动注册')
                    + (step.latencyMs !== undefined ? ` (${String(step.latencyMs)}ms)` : '')
                    + ' — ' + step.message),
              ),
            ),
        pushTestError ? h('p', { className: 'pbb-diag pbb-diagBad' }, pushTestError) : null,
        pushTestResult === null
          ? h('p', { className: 'pbb-diag' }, '向所有已注册设备强制发送一条真实推送（不受在线状态与分类开关影响）。')
          : h('div', { className: 'pbb-helpBody' },
              h('div', { className: 'pbb-row' },
                h('code', { className: 'pbb-token ' + (pushTestResult.overall === 'sent' ? 'pbb-ok' : pushTestResult.overall === 'failed' ? 'pbb-bad' : '') },
                  pushTestResult.overall === 'sent' ? '已送达'
                    : pushTestResult.overall === 'failed' ? '发送失败'
                      : pushTestResult.overall === 'no-targets' ? '无已注册设备' : '推送未启用')),
              pushTestResult.message ? h('p', { className: 'pbb-diag' }, pushTestResult.message) : null,
              pushTestResult.results.map((r: any, index: number) =>
                h('p', { className: 'pbb-diag', key: String(index) },
                  (r.outcome === 'sent' ? '✓ ' : '✗ ') + r.name + ' [' + r.environment + '] — '
                    + r.outcome + (r.reason ? '（' + r.reason + '）' : '')
                    + (r.tokenFingerprint ? '　token:' + r.tokenFingerprint + '…' : ''))),
            ),
      ),
    ),
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-field' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, '已配对设备'),
          h('span', { className: 'pbb-badge' }, String(report !== null ? report.devices.length : 0)),
        ),
        deviceTable,
      ),
    ),
    diag.length > 0 ? h('p', { className: 'pbb-diag' + (failed ? ' pbb-diagBad' : '') },
      'diag: ' + diag.join(' | ')) : null,
  )
}
