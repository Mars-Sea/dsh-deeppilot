import { createElement as h, useEffect, useState } from 'react'
import * as QRCode from 'qrcode/lib/browser.js'
import type { DeepPilotReport, PairingGrantSnapshot, PushTestResult, RelayTestResult } from '../report-wire.ts'
import { encodePairingQRPayload, selectPairingTarget } from '../pairing-qr.ts'
import { translateWith as t } from './i18n.ts'
import type { EnabledState, PageState, RemoteConnectionLimitState, RemoteEnabledState } from './index.ts'
import { DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE, MAX_FUNNEL_CONNECTIONS_PER_SOURCE } from '../funnel-policy.ts'

type T = (key: string, vars?: Readonly<Record<string, unknown>>) => string

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
  const [addressMessage, setAddressMessage] = useState('')
  const [remoteLimitDraft, setRemoteLimitDraft] = useState(String(DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE))
  const [remoteLimitMessage, setRemoteLimitMessage] = useState('')
  const [qrDataURL, setQRDataURL] = useState<string | null>(null)
  const [pairingGrant, setPairingGrant] = useState<PairingGrantSnapshot | null>(null)
  const [qrBusy, setQRBusy] = useState(false)
  const [qrMessage, setQRMessage] = useState('')
  const [relayTestBusy, setRelayTestBusy] = useState(false)
  const [relayTestResult, setRelayTestResult] = useState<RelayTestResult | null>(null)
  const [relayTestError, setRelayTestError] = useState('')
  const [pushTestBusy, setPushTestBusy] = useState(false)
  const [pushTestResult, setPushTestResult] = useState<PushTestResult | null>(null)
  const [pushTestError, setPushTestError] = useState('')
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null)
  const [deviceMessage, setDeviceMessage] = useState('')

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
    if (!addressMessage) return
    const timer = globalThis.setTimeout(() => setAddressMessage(''), 2_500)
    return () => globalThis.clearTimeout(timer)
  }, [addressMessage])

  useEffect(() => {
    if (!remoteLimitMessage) return
    const timer = globalThis.setTimeout(() => setRemoteLimitMessage(''), 4_000)
    return () => globalThis.clearTimeout(timer)
  }, [remoteLimitMessage])

  useEffect(() => {
    if (qrDataURL === null) return
    const timer = globalThis.setTimeout(() => {
      setQRDataURL(null)
      setPairingGrant(null)
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
  let remoteConnectionLimit = DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE
  let remoteConnectionLimitReady = false
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
    if (typeof props.beginPairing !== 'function') diag.push(t(props.t, 'diag.missingReveal'))
    if (typeof props.revokeDevice !== 'function') diag.push(t(props.t, 'diag.missingRotate'))
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
    if (typeof props.useDeepPilotRemoteConnectionLimit === 'function') {
      const state = props.useDeepPilotRemoteConnectionLimit((s: RemoteConnectionLimitState) => s)
      remoteConnectionLimit = state.value
      remoteConnectionLimitReady = state.status === 'ready'
    } else {
      diag.push(t(props.t, 'diag.missingRemoteLimitHook'))
    }
    if (typeof props.setDeepPilotRemoteConnectionLimit !== 'function') diag.push(t(props.t, 'diag.missingSetRemoteLimit'))
  } catch (error) {
    diag.push(t(props.t, 'diag.renderError') + (error instanceof Error ? error.message : String(error)))
    failed = true
  }

  useEffect(() => {
    setRemoteLimitDraft(String(remoteConnectionLimit))
  }, [remoteConnectionLimit])

  const parsedRemoteLimit = Number(remoteLimitDraft)
  const remoteLimitValid = Number.isInteger(parsedRemoteLimit) && parsedRemoteLimit >= 1 && parsedRemoteLimit <= MAX_FUNNEL_CONNECTIONS_PER_SOURCE
  const applyRemoteLimit = (): void => {
    if (!remoteLimitValid || typeof props.setDeepPilotRemoteConnectionLimit !== 'function') {
      setRemoteLimitMessage(t(props.t, 'remote.limitInvalid'))
      return
    }
    setRemoteLimitMessage('')
    void props.setDeepPilotRemoteConnectionLimit(parsedRemoteLimit).then(() => {
      setRemoteLimitMessage(t(props.t, 'remote.limitApplied'))
    }, (error: unknown) => {
      setRemoteLimitMessage(t(props.t, 'remote.limitFailed') + (error instanceof Error ? error.message : String(error)))
    })
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
    setPairingGrant(null)
  }, [pairingTarget?.host])

  const copyRemoteURL = (url: string): void => {
    setAddressMessage('')
    void writeClipboard(props.t as T, url).then(() => {
      setAddressMessage(t(props.t, 'pair.publicCopyDone'))
    }, (error: unknown) => {
      setAddressMessage(t(props.t, 'pair.publicCopyFailed') + (error instanceof Error ? error.message : String(error)))
    })
  }

  const showPairingQR = (): void => {
    if (typeof props.beginPairing !== 'function' || pairingTarget === null) return
    setQRBusy(true)
    setQRMessage('')
    setQRDataURL(null)
    setPairingGrant(null)
    void (props.beginPairing() as Promise<PairingGrantSnapshot>)
      .then(async (grant: PairingGrantSnapshot) => ({
        grant,
        svg: await QRCode.toString(
          encodePairingQRPayload(pairingTarget.host, grant),
          { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 512 },
        ),
      }))
      .then(({ grant, svg }) => {
        setPairingGrant(grant)
        setQRDataURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))
      }, (error: unknown) => {
        setQRMessage(t(props.t, 'pair.qrFailed') + (error instanceof Error ? error.message : String(error)))
      })
      .finally(() => setQRBusy(false))
  }

  const hidePairingQR = (): void => {
    setQRDataURL(null)
    setPairingGrant(null)
  }

  const copyPairingCode = (): void => {
    if (pairingGrant === null) return
    setQRMessage('')
    void writeClipboard(props.t as T, pairingGrant.code).then(() => {
      setQRMessage(t(props.t, 'pair.codeCopyDone'))
    }, (error: unknown) => {
      setQRMessage(t(props.t, 'pair.codeCopyFailed') + (error instanceof Error ? error.message : String(error)))
    })
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
      h('div', { className: 'pbb-field', key: 'identity' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'panel.identity')),
          h('code', { className: 'pbb-token ' + (report.pairingReady ? 'pbb-ok' : 'pbb-bad') },
            report.pairingReady ? t(props.t, 'panel.identityReady') : t(props.t, 'panel.identityNotReady')))),
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
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.identityPath')),
          h('span', { className: 'pbb-value' }, report.identityPath))),
      h('div', { className: 'pbb-field', key: 'buffer' },
        h('div', { className: 'pbb-row' },
          h('span', { className: 'pbb-label' }, t(props.t, 'advanced.bufferMax')),
          h('span', { className: 'pbb-value' }, String(report.historyBufferMax) + t(props.t, 'advanced.frames')))),
    )
  }

  const revokeDevice = (deviceId: string, name: string): void => {
    if (typeof props.revokeDevice !== 'function') return
    if (typeof window !== 'undefined' && !window.confirm(t(props.t, 'devices.revokeConfirm', { name }))) return
    setDeviceBusy(deviceId)
    setDeviceMessage('')
    void props.revokeDevice(deviceId).then(() => {
      setDeviceMessage(t(props.t, 'devices.revoked'))
    }, (error: unknown) => {
      setDeviceMessage(t(props.t, 'devices.revokeFailed') + (error instanceof Error ? error.message : String(error)))
    }).finally(() => setDeviceBusy(null))
  }

  const visibleDevices = report?.devices.filter((device) => device.revokedAt === undefined) ?? []
  const deviceTable = visibleDevices.length > 0
    ? h('table', { className: 'pbb-table' },
        h('thead', null, h('tr', null,
          h('th', null, t(props.t, 'devices.col.name')), h('th', null, t(props.t, 'devices.col.fingerprint')), h('th', null, t(props.t, 'devices.col.lastSeen')), h('th', null, t(props.t, 'devices.col.actions')))),
        h('tbody', null, visibleDevices.map((d) =>
          h('tr', { key: d.deviceId },
            h('td', null, d.deviceName, h('div', { className: 'pbb-diag' }, d.appVersion)),
            h('td', null, h('code', { className: 'pbb-token' }, d.fingerprint.slice(0, 12))),
            h('td', null, new Date(d.lastSeenTs).toLocaleString()),
            h('td', null, h('button', {
              type: 'button', className: 'pbb-action pbb-actionDanger', disabled: deviceBusy === d.deviceId,
              onClick: () => revokeDevice(d.deviceId, d.deviceName),
            }, t(props.t, 'devices.revoke')))))))
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
        h('summary', null, t(props.t, 'remote.advancedSettings')),
        h('div', { className: 'pbb-helpBody' },
          h('div', { className: 'pbb-limitRow pbb-limitNested' },
            h('div', { className: 'pbb-switchText' },
              h('label', { className: 'pbb-switchTitle', htmlFor: 'deeppilot-funnel-source-limit' }, t(props.t, 'remote.limitTitle')),
              h('span', { className: 'pbb-switchDesc' }, t(props.t, 'remote.limitDescription')),
              !remoteLimitValid
                ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'remote.limitInvalid'))
                : remoteLimitMessage
                  ? h('p', { className: 'pbb-diag' + (remoteLimitMessage.startsWith(t(props.t, 'remote.limitFailed')) ? ' pbb-diagBad' : '') }, remoteLimitMessage)
                  : null,
            ),
            h('div', { className: 'pbb-limitControl' },
              h('input', {
                id: 'deeppilot-funnel-source-limit',
                className: 'pbb-numberInput',
                type: 'number',
                min: 1,
                max: MAX_FUNNEL_CONNECTIONS_PER_SOURCE,
                step: 1,
                inputMode: 'numeric',
                value: remoteLimitDraft,
                disabled: !remoteConnectionLimitReady,
                'aria-label': t(props.t, 'remote.limitTitle'),
                onChange: (event: { currentTarget: { value: string } }) => setRemoteLimitDraft(event.currentTarget.value),
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
                disabled: !remoteConnectionLimitReady || !remoteLimitValid || parsedRemoteLimit === remoteConnectionLimit,
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
                  disabled: qrBusy || !report.pairingReady,
                  onClick: () => {
                    if (qrDataURL === null) showPairingQR()
                    else hidePairingQR()
                  },
                }, qrBusy ? t(props.t, 'pair.qrGenerating') : (qrDataURL === null ? t(props.t, 'pair.qrShow') : t(props.t, 'pair.qrHide'))))),
        pairingTarget === null
          ? h('p', { className: 'pbb-diag pbb-diagBad' }, t(props.t, 'pair.noAddressHelp'))
          : null,
        qrMessage ? h('p', { className: 'pbb-diag' }, qrMessage) : null,
        pairingTarget === null || qrDataURL === null || pairingGrant === null ? null : h('div', { className: 'pbb-qrPanel' },
          h('img', {
            className: 'pbb-qrImage',
            src: qrDataURL,
            alt: t(props.t, 'pair.qrAlt'),
          }),
          h('div', { className: 'pbb-pairCodeBlock' },
            h('span', { className: 'pbb-pairCodeLabel' }, t(props.t, 'pair.codeLabel')),
            h('div', { className: 'pbb-pairCodeRow' },
              h('code', { className: 'pbb-pairCode' }, pairingGrant.code),
              h('button', {
                type: 'button',
                className: 'pbb-action',
                onClick: copyPairingCode,
              }, t(props.t, 'panel.tokenAction.copy')))),
          h('div', { className: 'pbb-row' },
            h('code', { className: 'pbb-token' }, pairingTarget.host),
            h('button', {
              type: 'button',
              className: 'pbb-action',
              onClick: () => copyRemoteURL(pairingTarget.host),
            }, t(props.t, 'panel.tokenAction.copy'))),
          addressMessage ? h('p', { className: 'pbb-diag' }, addressMessage) : null,
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
          h('span', { className: 'pbb-badge' }, String(visibleDevices.length)),
        ),
        deviceMessage ? h('p', { className: 'pbb-diag' }, deviceMessage) : null,
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
