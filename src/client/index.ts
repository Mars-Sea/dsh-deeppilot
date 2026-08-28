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
import { registerLocale as registerDeepPilotLocale, t } from './i18n.ts'
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
  // version footer line
  '.pbb-versionFooter{display:flex;justify-content:center;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:8px 0 4px;line-height:1.4}',
  '.pbb-versionFooter a{color:var(--dsw-alias-state-success-primary,#22a06b);text-decoration:none}',
  '.pbb-versionFooter a:hover{text-decoration:underline;text-underline-offset:2px}',
].join('\n')

function injectCss(): void {
  if (typeof document === 'undefined') return
  const id = 'dsh-deeppilot/page.css'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', id)
  tag.textContent = CSS
  document.head.appendChild(tag)
}

async function writeClipboard(t: T, value: string): Promise<void> {
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
  if (!copied) throw new Error(t('clipboard.rejected'))
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

/** Bound translation function shape used everywhere in this file. The
 *  t() helper from i18n.ts has the same signature; we name it T here so
 *  consumers in the page can pass it through props without depending on
 *  the i18n module directly. */
type T = (key: string, vars?: Readonly<Record<string, unknown>>) => string

/** Polls the report remote and owns the page state transitions. */
class ReportController {
  private listeners = new Set<() => void>()
  private snap: PageState = { status: 'loading', report: null, message: '' }

  constructor(
    private readonly fetchReport: () => Promise<DeepPilotReport | null>,
    private readonly t: T,
  ) {}

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
        : { status: 'error', report: null, message: this.t('diag.mountFailed') }
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

  // Hand the locale face our full zh/en dictionary. The page is reachable
  // without a locale face: t() falls back to a built-in copy of the same
  // table so missing host injection never blanks the UI.
  registerDeepPilotLocale(ctx)

  let namespace: ReportRemote | undefined
  let mountError: string | undefined

  const fetchReport = async (): Promise<DeepPilotReport | null> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined
        ? t(ctx, 'diag.mountFailedShort') + mountError
        : t(ctx, 'diag.remoteUnmounted'))
    }
    const result = await namespace.report()
    if (!result.ok) throw new Error(result.error.message ?? t(ctx, 'diag.callFailed'))
    return result.value
  }

  const tPage: T = (key, vars) => t(ctx, key, vars)
  const controller = new ReportController(fetchReport, tPage)
  ctx.effect(() => () => controller.dispose(), 'dsh-deeppilot: report controller')
  const store = createSnapshotStore<PageState>(controller.state())
  controller.subscribe(() => store.set(controller.state()))

  ctx.effect(() => {
    let cancelled = false
    let unmount: (() => Promise<void>) | undefined
    if (anyCtx.remote === undefined) {
      mountError = t(ctx, 'diag.remoteUnavailable')
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
      throw new Error(mountError !== undefined
        ? t(ctx, 'diag.mountFailedShort') + mountError
        : t(ctx, 'diag.remoteUnmounted'))
    }
    const result = await namespace.revealToken()
    if (!result.ok) throw new Error(result.error.message ?? t(ctx, 'panel.tokenRevealFailed'))
    return result.value
  }

  const sendTestPush = async (): Promise<PushTestResult> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined
        ? t(ctx, 'diag.mountFailedShort') + mountError
        : t(ctx, 'diag.remoteUnmounted'))
    }
    if (typeof namespace.testPush !== 'function') {
      throw new Error(t(ctx, 'push.staleHostPush'))
    }
    const result = await namespace.testPush()
    if (!result.ok) throw new Error(result.error.message ?? t(ctx, 'push.pushFailed'))
    return result.value
  }

  const testRelayConnection = async (): Promise<RelayTestResult> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined
        ? t(ctx, 'diag.mountFailedShort') + mountError
        : t(ctx, 'diag.remoteUnmounted'))
    }
    if (typeof namespace.testRelay !== 'function') {
      throw new Error(t(ctx, 'push.staleHostPushRelay'))
    }
    const result = await namespace.testRelay()
    if (!result.ok) throw new Error(result.error.message ?? t(ctx, 'push.relayBad'))
    return result.value
  }

  // Rotation is a destructive, explicit action: the old token stops working
  // immediately and every paired device must re-pair with the fresh secret.
  const rotatePairingToken = async (): Promise<string> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined
        ? t(ctx, 'diag.mountFailedShort') + mountError
        : t(ctx, 'diag.remoteUnmounted'))
    }
    const result = await namespace.rotateToken()
    if (!result.ok) throw new Error(result.error.message ?? t(ctx, 'panel.tokenRotateFailed'))
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

  // Track the last scope-confirmed value so a rejected write can roll the
  // optimistic store back instead of leaving the UI in a state the Host never
  // accepted. Seed from adoptEnabled's result by reading the store.
  const lastConfirmedEnabled = (): boolean => {
    const snap = scope?.getSnapshot()
    if (snap?.status === 'ready' && snap.value !== undefined) return snap.value.enabled !== false
    // Pre-adopt fallback so the first flip still has a sane rollback target.
    return enabledStore.getSnapshot().enabled
  }
  const lastConfirmedRemoteEnabled = (): boolean => {
    const snap = scope?.getSnapshot()
    if (snap?.status === 'ready') return snap.value?.remote?.enabled === true
    return remoteEnabledStore.getSnapshot().enabled
  }

  const setDeepPilotEnabled = (value: boolean): void => {
    const previous = lastConfirmedEnabled()
    enabledStore.set({ status: 'ready', enabled: value })
    if (scope === undefined) return
    void scope.set('enabled', value).then(() => { /* next adoptEnabled will refresh */ }, (error: unknown) => {
      // Roll the store back so the switch reflects the durable truth, and
      // surface the failure: silent rejections used to leave a "turned off"
      // UI live with a still-on Host until the next unrelated change.
      enabledStore.set({ status: 'ready', enabled: previous })
      const message = error instanceof Error ? error.message : String(error)
      console.error('[deeppilot] failed to persist enabled=' + String(value) + ': ' + message)
    })
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
    const previous = lastConfirmedRemoteEnabled()
    remoteEnabledStore.set({ status: 'ready', enabled: value })
    if (scope === undefined) return
    const currentRemote = scope.getSnapshot().value?.remote ?? {}
    void scope.set('remote', { ...currentRemote, enabled: value }).then(() => { /* next adopt refreshes */ }, (error: unknown) => {
      remoteEnabledStore.set({ status: 'ready', enabled: previous })
      const message = error instanceof Error ? error.message : String(error)
      console.error('[deeppilot] failed to persist remote.enabled=' + String(value) + ': ' + message)
    })
  }

  if (anyCtx.slots === undefined) {
    // locale/settingsScope/remote all have visible degradations when missing;
    // slots is the registration seam itself — a missing slot service means
    // the whole page is silently blank. Surface it loudly so the cause shows
    // up next to the other diagnostic lines.
    console.error('[deeppilot] settings slots service unavailable; the DeepPilot section will not appear')
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
        // Bound translation function for the page. The page never imports
        // t() directly so it can be re-supplied if the host swaps the
        // locale face at runtime (a feature today; exercised in tests).
        t: (key: string, vars?: Readonly<Record<string, unknown>>) => t(ctx, key, vars),
      }),
    }, DeepPilotSettingsPage),
  )
}

/** Visual state of the embedded Funnel: a colored dot plus its spoken label.
 *  The label is a function because the surrounding constant lives at module
 *  scope where the locale-bound t() is not in scope; the page resolves the
 *  label at render time via t(props.t, ...). */
const REMOTE_PHASE_META: Record<DeepPilotReport['remote']['phase'], { dot: string; labelKey: string }> = {
  disabled: { dot: '', labelKey: 'phase.disabled' },
  starting: { dot: ' pbb-dotWarn', labelKey: 'phase.starting' },
  login_required: { dot: ' pbb-dotWarn', labelKey: 'phase.login_required' },
  online: { dot: ' pbb-dotOk', labelKey: 'phase.online' },
  error: { dot: ' pbb-dotBad', labelKey: 'phase.error' },
  unavailable: { dot: ' pbb-dotBad', labelKey: 'phase.unavailable' },
  stopped: { dot: '', labelKey: 'phase.stopped' },
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
      setPushTestError(t(props.t, 'push.staleHost'))
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
      setRelayTestError(t(props.t, 'push.staleHostRelay'))
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
      setTokenMessage(t(props.t, 'panel.tokenAutoHidden'))
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
      setQRMessage(t(props.t, 'pair.qrAutoHidden'))
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
      diag.push(t(props.t, 'diag.missingReportHook'))
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
      if (state.status === 'unavailable') diag.push(t(props.t, 'diag.settingsUnavailable'))
    } else {
      diag.push(t(props.t, 'diag.missingEnabledHook'))
    }
    if (typeof props.refresh !== 'function') diag.push(t(props.t, 'diag.missingRefresh'))
    if (typeof props.revealPairingToken !== 'function') diag.push(t(props.t, 'diag.missingReveal'))
    if (typeof props.rotatePairingToken !== 'function') diag.push(t(props.t, 'diag.missingRotate'))
    if (typeof props.testRelay !== 'function') diag.push(t(props.t, 'diag.missingTestRelay'))
    if (typeof props.testPush !== 'function') diag.push(t(props.t, 'diag.missingTestPush'))
    if (typeof props.setDeepPilotEnabled !== 'function') diag.push(t(props.t, 'diag.missingSetEnabled'))
    if (typeof props.useDeepPilotRemoteEnabled === 'function') {
      const state = props.useDeepPilotRemoteEnabled((s: RemoteEnabledState) => s)
      remoteEnabled = state.enabled
      remoteSwitchReady = state.status === 'ready'
    } else {
      diag.push(t(props.t, 'diag.missingRemoteEnabledHook'))
    }
    if (typeof props.setDeepPilotRemoteEnabled !== 'function') diag.push(t(props.t, 'diag.missingSetRemote'))
  } catch (error) {
    diag.push(t(props.t, 'diag.renderError') + (error instanceof Error ? error.message : String(error)))
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
      setTokenMessage(t(props.t, 'panel.tokenRevealFailed') + (error instanceof Error ? error.message : String(error)))
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
      .then((value: string) => writeClipboard(props.t as T, value))
      .then(() => setTokenMessage(t(props.t, 'panel.tokenCopied')), (error: unknown) => {
        setTokenMessage(t(props.t, 'pair.publicCopyFailed') + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setTokenBusy(false))
  }

  const rotateToken = (): void => {
    if (typeof props.rotatePairingToken !== 'function') return
    if (!rotateArmed) {
      setRotateArmed(true)
      setRevealedToken(null)
      setQRDataURL(null)
      setTokenMessage(t(props.t, 'panel.tokenRotateWarning'))
      return
    }
    setRotateArmed(false)
    setTokenBusy(true)
    setTokenMessage('')
    void (props.rotatePairingToken() as Promise<string>)
      .then((token: string) => {
        setRevealedToken(token)
        setTokenMessage(t(props.t, 'panel.tokenRotated'))
      }, (error: unknown) => {
        setTokenMessage(t(props.t, 'panel.tokenRotateFailed') + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setTokenBusy(false))
  }

  const copyRemoteURL = (url: string): void => {
    setRemoteMessage('')
    void writeClipboard(props.t as T, url).then(() => {
      setRemoteMessage(t(props.t, 'pair.publicCopyDone'))
    }, (error: unknown) => {
      setRemoteMessage(t(props.t, 'pair.publicCopyFailed') + (error instanceof Error ? error.message : String(error)))
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
        setQRMessage(t(props.t, 'pair.qrFailed') + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setQRBusy(false))
  }

  // Primary facts stay visible; technical details collapse into t(props.t, 'advanced.summary').
  const primaryRows: any[] = []
  const advancedRows: any[] = []
  if (report !== null) {
    primaryRows.push(
      h('div', { className: 'pbb-field', key: 'conn' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'panel.activeConnections')),
          h('span', { className: 'pbb-value' }, String(report.activeConnections)))),
      h('div', { className: 'pbb-field', key: 'token' },
        h('div', { className: 'pbb-row pbb-tokenRow' },
          h('span', { className: 'pbb-label' }, t(props.t, 'panel.token')),
          h('code', { className: 'pbb-token ' + (report.tokenReady ? 'pbb-ok' : 'pbb-bad') },
            report.tokenReady ? (revealedToken ?? '••••••••••••') : t(props.t, 'panel.tokenNotReady')),
          report.tokenReady
            ? h('span', { className: 'pbb-tokenActions' },
                h('button', {
                  type: 'button',
                  className: 'pbb-action',
                  disabled: tokenBusy,
                  onClick: toggleToken,
                }, tokenBusy ? t(props.t, 'panel.tokenAction.showing') : (revealedToken === null ? t(props.t, 'panel.tokenAction.show') : t(props.t, 'panel.tokenAction.hide'))),
                h('button', {
                  type: 'button',
                  className: 'pbb-action',
                  disabled: tokenBusy,
                  onClick: copyToken,
                }, t(props.t, 'panel.tokenAction.copy')),
                h('button', {
                  type: 'button',
                  className: 'pbb-action' + (rotateArmed ? ' pbb-actionDanger' : ''),
                  disabled: tokenBusy,
                  onClick: rotateToken,
                }, rotateArmed ? t(props.t, 'panel.tokenAction.rotateConfirm') : (tokenBusy ? t(props.t, 'panel.tokenAction.rotating') : t(props.t, 'panel.tokenAction.rotate'))))
            : null),
        tokenMessage ? h('p', { className: 'pbb-diag' }, tokenMessage) : null),
    )
    advancedRows.push(
      h('div', { className: 'pbb-field', key: 'proto' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.protocolVersion')),
          h('span', { className: 'pbb-value' }, 'v' + String(report.protocolVersion)))),
      h('div', { className: 'pbb-field', key: 'server' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.serverVersion')),
          h('span', { className: 'pbb-value' }, report.serverVersion))),
      h('div', { className: 'pbb-field', key: 'path' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.tokenPath')),
          h('span', { className: 'pbb-value' }, report.tokenPath))),
      h('div', { className: 'pbb-field', key: 'buffer' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.bufferMax')),
          h('span', { className: 'pbb-value' }, String(report.historyBufferMax) + t(props.t, 'advanced.frames')))),
    )
  }

  const deviceTable = report !== null && report.devices.length > 0
    ? h('table', { className: 'pbb-table' },
        h('thead', null, h('tr', null,
          h('th', null, t(props.t, 'devices.col.name')), h('th', null, t(props.t, 'devices.col.appVersion')), h('th', null, t(props.t, 'devices.col.push')), h('th', null, t(props.t, 'devices.col.lastSeen')))),
        h('tbody', null, report.devices.map((d) =>
          h('tr', { key: d.deviceId },
            h('td', null, d.deviceName),
            h('td', null, d.appVersion),
            h('td', null, d.apns
              ? t(props.t, 'devices.pushRegistered') + (d.apns.environment === 'production' ? t(props.t, 'devices.pushEnvProduction') : t(props.t, 'devices.pushEnvDevelopment')) + '）'
              : t(props.t, 'devices.pushNotRegistered')),
            h('td', null, new Date(d.lastSeenTs).toLocaleString())))))
    : h('p', { className: 'pbb-empty' }, t(props.t, 'devices.empty'))

  const switchTitle = t(props.t, 'master.title')
  const switchDesc = switchReady
    ? (enabled
        ? t(props.t, 'master.on')
        : t(props.t, 'master.off'))
    : t(props.t, 'master.loading')

  return h('div', { className: 'pbb-section' },
    h('div', { className: 'pbb-row' },
      h('h2', { className: 'pbb-title' }, 'DeepPilot'),
      h('div', { style: { flex: '1' } }),
      h('button', {
        className: 'pbb-refresh',
        onClick: () => { if (typeof props.refresh === 'function') props.refresh() },
      }, t(props.t, 'meta.refresh')),
    ),
    h('p', { className: 'pbb-intro' }, t(props.t, 'meta.intro')),
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
              'aria-label': report !== null ? t(props.t, REMOTE_PHASE_META[report.remote.phase].labelKey) : t(props.t, 'phase.unknown'),
              title: report !== null ? t(props.t, REMOTE_PHASE_META[report.remote.phase].labelKey) : undefined,
            }),
            t(props.t, 'remote.title')),
          h('span', { className: 'pbb-switchDesc' }, remoteSwitchReady
            ? (remoteEnabled ? t(props.t, 'remote.on') : t(props.t, 'remote.off'))
            : t(props.t, 'master.loading')),
          report !== null && report.remote.phase === 'login_required'
            && typeof report.remote.authURL === 'string' && report.remote.authURL.startsWith('https://')
            ? h('div', { className: 'pbb-rowAction' },
                h('a', { className: 'pbb-action', href: report.remote.authURL, target: '_blank', rel: 'noreferrer' }, t(props.t, 'remote.openAuth')))
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
          'aria-label': t(props.t, 'remote.title'),
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
      h('div', { className: 'pbb-field' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'pair.qrPanelTitle')),
          pairingTarget === null
            ? h('span', { className: 'pbb-value pbb-bad' }, t(props.t, 'pair.noAddress'))
            : h('span', { className: 'pbb-tokenActions' },
                h('span', { className: 'pbb-badge' }, pairingTarget.kind === 'public' ? t(props.t, 'pair.kind.public') : t(props.t, 'pair.kind.lan')),
                h('button', {
                  type: 'button',
                  className: 'pbb-action',
                  disabled: qrBusy || !report.tokenReady,
                  onClick: () => {
                    if (qrDataURL === null) showPairingQR()
                    else setQRDataURL(null)
                  },
                }, qrBusy ? t(props.t, 'pair.qrGenerating') : (qrDataURL === null ? t(props.t, 'pair.qrShow') : t(props.t, 'pair.qrHide'))))),
        pairingTarget === null
          ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'pair.noAddressHelp'))
          : null,
        qrMessage ? h('p', { className: 'pbb-diag' }, qrMessage) : null,
        pairingTarget === null || qrDataURL === null ? null : h('div', { className: 'pbb-qrPanel' },
          h('img', {
            className: 'pbb-qrImage',
            src: qrDataURL,
            alt: t(props.t, 'pair.qrAlt'),
          }),
          h('div', { className: 'pbb-row' },
            h('code', { className: 'pbb-token' }, pairingTarget.host),
            h('button', {
              type: 'button',
              className: 'pbb-action',
              onClick: () => copyRemoteURL(pairingTarget.host),
            }, t(props.t, 'panel.tokenAction.copy'))),
          h('p', { className: 'pbb-qrHint' },
            t(props.t, 'pair.qrHint', {
              kind: pairingTarget.kind === 'public' ? t(props.t, 'pair.kind.public') : t(props.t, 'pair.kind.lan'),
            }),
          ),
        ),
      ),
    ),
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-field' },
        primaryRows,
        advancedRows.length > 0 ? h('details', { className: 'pbb-help' },
          h('summary', null, t(props.t, 'advanced.summary')),
          h('div', { className: 'pbb-helpBody' }, advancedRows),
        ) : null,
      ),
    ),
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-field' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'push.relayTitle')),
          h('span', { className: 'pbb-tokenActions' },
            h('button', {
              type: 'button',
              className: 'pbb-action',
              disabled: relayTestBusy,
              onClick: runRelayTest,
            }, relayTestBusy ? t(props.t, 'push.relayTesting') : t(props.t, 'push.testRelay')),
            h('button', {
              type: 'button',
              className: 'pbb-action',
              disabled: pushTestBusy,
              onClick: sendPushTest,
            }, pushTestBusy ? t(props.t, 'push.pushSending') : t(props.t, 'push.testPush'))),
        ),
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
    h('div', { className: 'pbb-card' },
      h('div', { className: 'pbb-field' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'devices.title')),
          h('span', { className: 'pbb-badge' }, String(report !== null ? report.devices.length : 0)),
        ),
        deviceTable,
      ),
    ),
    report === null ? null : h('div', { className: 'pbb-versionFooter' },
      h('span', null, 'DeepPilot v' + report.pluginVersion),
      report.updateAvailable === true
        ? h('a', {
          href: typeof report.releaseUrl === 'string' && /^https:\/\//.test(report.releaseUrl)
            ? report.releaseUrl
            : 'https://github.com/Mars-Sea/dsh-deeppilot/releases',
          target: '_blank',
          rel: 'noreferrer',
        }, t(props.t, 'update.badge'))
        : null,
    ),
    diag.length > 0 ? h('p', { className: 'pbb-diag' + (failed ? ' pbb-diagBad' : '') },
      t(props.t, 'diag.prefix') + diag.join(' | ')) : null,
  )
}
