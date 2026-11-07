import { createElement as h, useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { settingsIcon } from '../../src/client/settings-icons.ts'
import { DeepPilotSettingsPage } from '../../src/client/settings-page.ts'
import { injectCss } from '../../src/client/styles.ts'
import { interpolate, translateOrThrow, type SupportedLocale } from '../../src/client/i18n.ts'
import type { DeepPilotReport, PairingGrantSnapshot } from '../../src/report-wire.ts'
import type { SettingsPageProps } from '../../src/client/settings-props.ts'
import packageJson from '../../package.json' with { type: 'json' }

const query = new URLSearchParams(location.search)
const scenario = query.get('scenario') ?? 'default'
const locale: SupportedLocale = query.get('locale') === 'en' ? 'en' : 'zh'
document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light'
document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
const pin = 'sha256:' + 'A'.repeat(43)

/** 所有状态都从正式报告契约构造，测试只替换远端边界。 */
function initialReport(): DeepPilotReport {
  const now = Date.now()
  const names = ['iPhone 17 Pro', 'iPhone 18 Pro', 'sdk_gphone16k_arm64', 'iPhone Duo']
  const report: DeepPilotReport = {
    protocolVersion: 2, pluginVersion: packageJson.version, serverVersion: packageJson.version,
    enabled: true, pairingReady: true, identityPath: '/fixture/devices-v2.json',
    activeConnections: 0, historyBufferMax: 2000, lanAddresses: ['192.168.1.20'],
    local: { phase: scenario === 'dual' ? 'online' : 'disabled', port: 3098,
      endpoints: ['https://192.168.1.20:3098'], tlsFingerprint: pin, updatedAt: now },
    remote: { provider: 'tailscale-funnel', phase: 'online',
      publicURL: 'https://fixture.example.test', tailscaleVersion: 'v1.104.4', updatedAt: now },
    devices: names.map((name, i) => ({
      deviceId: `fixture-${i}`, deviceName: name, customName: i === 0 ? name : undefined,
      appVersion: i === 2 ? '0.1.0' : '0.2.3', firstSeenTs: now - 86400000,
      lastSeenTs: now - i * 60000, fingerprint: String(i + 1).repeat(64), scopes: ['sessions.read'],
    })),
    diagnostics: { startedAt: now, recentFailures: Array.from({ length: 3 }, (_, i) => ({
      ts: now - (i + 1) * 60000, kind: 'connection-closed', reason: 'abnormal-close', closeCode: 1006,
    })) },
  }
  if (scenario === 'empty') report.devices = []
  if (scenario === 'long') report.devices[0]!.deviceName = report.devices[0]!.customName = '工作手机用于跨设备测试的超长名称'.repeat(8)
  if (scenario === 'unavailable') { report.enabled = false; report.local.phase = 'disabled'; report.remote.phase = 'disabled' }
  if (scenario === 'login') { report.remote.phase = 'login_required'; report.remote.authURL = 'https://login.example.test/authorize' }
  if (scenario === 'error') {
    report.local.phase = 'error'; report.local.message = 'EADDRINUSE'
    report.remote.phase = 'error'; report.remote.message = 'ECONNREFUSED'
  }
  return report
}

function Fixture(): any {
  const [report, setReport] = useState(initialReport)
  const [localPort, setLocalPort] = useState(3098)
  const [limit, setLimit] = useState(8)
  const [debug, setDebug] = useState(false)
  const [preview, setPreview] = useState(true)
  const operations = useRef({ grants: 0, renames: 0, revokes: 0, ports: 0, limits: 0, pushes: 0, enabled: 0, remote: 0, debug: 0, preview: 0 })
  const [revision, setRevision] = useState(0)
  const record = (key: keyof typeof operations.current): void => {
    operations.current[key] += 1
    setRevision((n) => n + 1)
  }
  const refresh = useCallback(() => {}, [])
  const props: SettingsPageProps = {
    t: (key, vars) => interpolate(translateOrThrow(locale, key), vars), refresh,
    useDeepPilotReport: (select) => select({ status: 'ready', report, message: '' }),
    useDeepPilotEnabled: (select) => select({ status: 'ready', enabled: report.enabled }),
    useDeepPilotRemoteEnabled: (select) => select({ status: 'ready', enabled: report.remote.phase !== 'disabled' }),
    useDeepPilotLocalPort: (select) => select({ status: 'ready', value: localPort }),
    useDeepPilotRemoteConnectionLimit: (select) => select({ status: 'ready', value: limit }),
    useDeepPilotDebug: (select) => select({ status: 'ready', enabled: debug }),
    useDeepPilotPreview: (select) => select({ status: 'ready', enabled: preview }),
    setDeepPilotEnabled: (enabled) => { record('enabled'); setReport((r) => ({ ...r, enabled })) },
    setDeepPilotRemoteEnabled: (enabled) => { record('remote'); setReport((r) => ({ ...r, remote: { ...r.remote, phase: enabled ? 'online' : 'disabled' } })) },
    setDeepPilotDebug: (enabled) => { record('debug'); setDebug(enabled) },
    setDeepPilotPreview: (enabled) => { record('preview'); setPreview(enabled) },
    setDeepPilotLocalPort: (value) => { record('ports'); setLocalPort(value) },
    setDeepPilotRemoteConnectionLimit: (value) => { record('limits'); setLimit(value) },
    beginPairing: async (): Promise<PairingGrantSnapshot> => {
      record('grants')
      if (scenario === 'pair-error' && operations.current.grants === 1) throw new Error('E_FIXTURE_PAIR')
      return { code: String(operations.current.grants).repeat(43),
        audience: 'deeppilot:abcdefghijklmnopqrstuv', expiresAt: Date.now() + 300000 }
    },
    setDeviceName: async (id, name) => {
      if (scenario === 'rename-error') throw new Error('E_FIXTURE_RENAME')
      record('renames')
      setReport((r) => ({ ...r, devices: r.devices.map((d) => d.deviceId === id ? { ...d, customName: name ?? undefined } : d) }))
    },
    revokeDevice: async (id) => {
      record('revokes')
      setReport((r) => ({ ...r, devices: r.devices.filter((d) => d.deviceId !== id) }))
    },
    testRelay: async () => ({ url: 'https://relay.example.test', overall: 'ok', tokenIssued: true,
      steps: [{ id: 'health', ok: true, message: '连接正常', latencyMs: 12 }] }),
    testPush: async () => { record('pushes'); return { transport: 'relay', overall: 'sent', results: [] } },
  }
  if (scenario === 'loading') props.useDeepPilotReport = (select) => select({ status: 'loading', report: null, message: '' })
  if (scenario === 'report-error') props.useDeepPilotReport = (select) => select({ status: 'error', report: null, message: 'E_FIXTURE_REPORT' })
  if (scenario === 'config-unavailable') {
    props.useDeepPilotEnabled = (select) => select({ status: 'unavailable', enabled: report.enabled })
    props.useDeepPilotRemoteEnabled = (select) => select({ status: 'unavailable', enabled: true })
    props.useDeepPilotDebug = (select) => select({ status: 'unavailable', enabled: false })
    props.useDeepPilotPreview = (select) => select({ status: 'unavailable', enabled: true })
  }
  return h('div', null,
    h(DeepPilotSettingsPage, props),
    // 保留渲染以读取滑块 transform；display:none 的后代没有可比较的变换矩阵。
    h('div', { 'aria-hidden': true, inert: true, style: { position: 'fixed', left: '-10000px', top: 0 }, 'data-testid': 'host-switch-reference' },
      h(Switch, { checked: true, label: '宿主参考开关：开启', onChange: () => {} }),
      h(Switch, { checked: false, label: '宿主参考开关：关闭', onChange: () => {} }),
      h('div', { 'data-testid': 'host-button-reference' },
        h(Button, { variant: 'outline', size: 'sm', icon: settingsIcon('plus', 16) }, '添加手机'))),
    h('output', { hidden: true, 'data-testid': 'fixture-operations', 'data-revision': revision }, JSON.stringify(operations.current)))
}

injectCss()
createRoot(document.getElementById('app')!).render(h(Fixture))
