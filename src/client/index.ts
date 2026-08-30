/**
 * Browser half of the dsh-deeppilot bundle.
 *
 * Registers a "DeepPilot" settings page following the exact structure of the
 * working settings pages in the harness: a controller + local snapshot store
 * surfaced to the slot component as a `use` hook, with
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
import type { DeepPilotReport, PairingGrantSnapshot } from '../report-wire.ts'
import { createSnapshotStore } from './snapshot-store.ts'
import { mountReportRemote } from './report-mount.ts'
import type { ClientRemoteLike, ReportRemote } from './report-mount.ts'
import { registerLocale as registerDeepPilotLocale, t } from './i18n.ts'
import type { PushTestResult, RelayTestResult } from '../report-wire.ts'
import { injectCss } from './styles.ts'
import { DeepPilotSettingsPage } from './settings-page.ts'
import { DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE, normalizeFunnelConnectionLimit } from '../funnel-policy.ts'

export { DeepPilotSettingsPage } from './settings-page.ts'

type AnyCtx = Context & {
  locale?: {
    register: (key: string, table: unknown) => () => void
    bind: (key: string) => (k: string, vars?: Readonly<Record<string, unknown>>) => string
    getSnapshot?: () => { active: string; revision: number }
  }
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
    value?: { enabled?: boolean; remote?: { enabled?: boolean; maxConnectionsPerSource?: number; [key: string]: unknown } }
    writable?: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
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

export interface RemoteConnectionLimitState {
  status: 'loading' | 'ready' | 'unavailable'
  value: number
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
  ctx.effect(
    () => registerDeepPilotLocale(ctx),
    'dsh-deeppilot: locale dictionaries',
  )

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

  const beginPairing = async (): Promise<PairingGrantSnapshot> => {
    if (namespace === undefined) {
      throw new Error(mountError !== undefined
        ? t(ctx, 'diag.mountFailedShort') + mountError
        : t(ctx, 'diag.remoteUnmounted'))
    }
    const result = await namespace.beginPairing()
    if (!result.ok) throw new Error(result.error.message ?? t(ctx, 'pair.qrFailed'))
    return result.value
  }

  const revokeDevice = async (deviceId: string): Promise<void> => {
    if (namespace === undefined) throw new Error(t(ctx, 'diag.remoteUnmounted'))
    const result = await namespace.revokeDevice(deviceId)
    if (!result.ok || result.value !== true) throw new Error(result.ok ? t(ctx, 'devices.revokeFailed') : (result.error.message ?? t(ctx, 'devices.revokeFailed')))
    await controller.refresh()
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
  const lastConfirmedRemoteConnectionLimit = (): number => {
    const snap = scope?.getSnapshot()
    if (snap?.status === 'ready') return normalizeFunnelConnectionLimit(snap.value?.remote?.maxConnectionsPerSource)
    return remoteConnectionLimitStore.getSnapshot().value
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
  const remoteConnectionLimitStore = createSnapshotStore<RemoteConnectionLimitState>({
    status: 'loading',
    value: DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE,
  })
  const adoptRemoteEnabled = (): void => {
    if (scope === undefined) return
    const snap = scope.getSnapshot()
    if (snap.status === 'ready') {
      remoteEnabledStore.set({ status: 'ready', enabled: snap.value?.remote?.enabled === true })
      remoteConnectionLimitStore.set({
        status: 'ready',
        value: normalizeFunnelConnectionLimit(snap.value?.remote?.maxConnectionsPerSource),
      })
    } else if (snap.status === 'unavailable') {
      remoteEnabledStore.set({ status: 'unavailable', enabled: false })
      remoteConnectionLimitStore.set({ status: 'unavailable', value: DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE })
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

  const setDeepPilotRemoteConnectionLimit = async (value: number): Promise<void> => {
    const next = normalizeFunnelConnectionLimit(value)
    if (next !== value) throw new RangeError('maxConnectionsPerSource must be an integer between 1 and 16')
    if (scope === undefined) throw new Error('settings scope unavailable')
    const previous = lastConfirmedRemoteConnectionLimit()
    remoteConnectionLimitStore.set({ status: 'ready', value: next })
    const currentRemote = scope.getSnapshot().value?.remote ?? {}
    try {
      await scope.set('remote', { ...currentRemote, maxConnectionsPerSource: next })
    } catch (error) {
      remoteConnectionLimitStore.set({ status: 'ready', value: previous })
      const message = error instanceof Error ? error.message : String(error)
      console.error('[deeppilot] failed to persist remote.maxConnectionsPerSource=' + String(next) + ': ' + message)
      throw error
    }
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
          deepPilotRemoteConnectionLimit: remoteConnectionLimitStore,
        },
        refresh: () => { void controller.refresh() },
        beginPairing,
        revokeDevice,
        testRelay: testRelayConnection,
        testPush: sendTestPush,
        setDeepPilotEnabled,
        setDeepPilotRemoteEnabled,
        setDeepPilotRemoteConnectionLimit,
        // Bound translation function for the page. The page never imports
        // t() directly so it can be re-supplied if the host swaps the
        // locale face at runtime (a feature today; exercised in tests).
        t: (key: string, vars?: Readonly<Record<string, unknown>>) => t(ctx, key, vars),
      }),
    }, DeepPilotSettingsPage),
  )
}
