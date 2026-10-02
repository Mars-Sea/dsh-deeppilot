/**
 * settings-props 的归一化 seam。
 *
 * 钉住三件事：缺省面（哪些 prop 缺失时产生哪些诊断）、hook fallback 的行为与
 * 引用稳定性、能力集合与页面行为分支的对应关系。诊断顺序是契约——宿主过期时
 * 用户看到的技术诊断必须和迁移前一字不差。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSettingsPageProps,
  MISSING_ENABLED_HOOK,
  MISSING_LOCAL_PORT_HOOK,
  MISSING_REMOTE_LIMIT_HOOK,
  type SettingsPageProps,
} from '../src/client/settings-props.ts'

const t = (key: string): string => key

/** 一份「宿主给全」的 props：只有 hook 与 t 是页面必需的，其余按需。 */
function fullProps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    useDeepPilotReport: () => ({ status: 'ready', report: null, message: '' }),
    useDeepPilotEnabled: () => ({ status: 'ready', enabled: true }),
    useDeepPilotLocalEnabled: () => ({ status: 'ready', enabled: true }),
    useDeepPilotLocalPort: () => ({ status: 'ready', value: 3098 }),
    useDeepPilotRemoteEnabled: () => ({ status: 'ready', enabled: false }),
    useDeepPilotRemoteConnectionLimit: () => ({ status: 'ready', value: 8 }),
    useDeepPilotDebug: () => ({ status: 'ready', enabled: false }),
    refresh: () => {},
    beginPairing: async () => ({ code: 'c', expiresAt: 0, audience: 'a' }),
    revokeDevice: async () => true,
    setDeviceName: async () => null,
    testRelay: async () => ({ url: '', overall: 'failed', tokenIssued: false, steps: [] }),
    testPush: async () => ({ transport: 'none', overall: 'not-configured', message: '', results: [] }),
    setDeepPilotEnabled: () => {},
    setDeepPilotLocalEnabled: () => {},
    setDeepPilotLocalPort: async () => {},
    setDeepPilotRemoteEnabled: () => {},
    setDeepPilotRemoteConnectionLimit: async () => {},
    setDeepPilotDebug: () => {},
    t,
    ...overrides,
  }
}

test('宿主给全时没有诊断，十二个能力全部在位', () => {
  const surface = normalizeSettingsPageProps(fullProps())
  assert.deepEqual(surface.diagnostics, [])
  assert.equal(surface.reportHookMissing, false)
  assert.deepEqual([...surface.can].sort(), [
    'beginPairing', 'refresh', 'revokeDevice', 'setDebug', 'setDeviceName',
    'setEnabled', 'setLocalEnabled', 'setLocalPort', 'setRemoteEnabled',
    'setRemoteLimit', 'testPush', 'testRelay',
  ].sort())
})

test('一个 prop 都不给时，诊断逐条对上且顺序与迁移前一致', () => {
  const surface = normalizeSettingsPageProps({ t })
  assert.deepEqual(surface.diagnostics, [
    'diag.missingReportHook',
    'diag.missingEnabledHook',
    'diag.missingRefresh',
    'diag.missingReveal',
    'diag.missingRotate',
    'diag.missingRename',
    'diag.missingTestRelay',
    'diag.missingTestPush',
    'diag.missingSetEnabled',
    'diag.missingLocalEnabledHook',
    'diag.missingLocalPortHook',
    'diag.missingSetLocal',
    'diag.missingSetLocalPort',
    'diag.missingRemoteEnabledHook',
    'diag.missingSetRemote',
    'diag.missingRemoteLimitHook',
    'diag.missingSetRemoteLimit',
    'diag.missingDebugHook',
    'diag.missingSetDebug',
  ])
  assert.equal(surface.reportHookMissing, true, '报告 hook 缺失时统计/配对/系统区块整段跳过')
  assert.equal(surface.can.size, 0)
})

test('诊断顺序不随缺失组合改变', () => {
  // 只缺中间几项：前后顺序必须保持。
  const raw = fullProps()
  delete raw.setDeviceName
  delete raw.useDeepPilotRemoteEnabled
  delete raw.setDeepPilotDebug
  const surface = normalizeSettingsPageProps(raw)
  assert.deepEqual(surface.diagnostics, [
    'diag.missingRename',
    'diag.missingRemoteEnabledHook',
    'diag.missingSetDebug',
  ])
})

test('hook 缺失时换成引用恒定的 fallback，缺省态与迁移前逐项对齐', () => {
  const first = normalizeSettingsPageProps({ t })
  const second = normalizeSettingsPageProps({ t })
  assert.equal(first.props.useDeepPilotEnabled, second.props.useDeepPilotEnabled,
    'fallback 必须是模块级常量，否则 React 会把它当作 hook 顺序变化')
  assert.equal(first.props.useDeepPilotEnabled, MISSING_ENABLED_HOOK)

  // 缺省态：总开关默认开但未就绪；本地默认开；本地端口回落默认值；远程默认关。
  assert.deepEqual(first.props.useDeepPilotEnabled((s) => s), { status: 'unavailable', enabled: true })
  assert.deepEqual(first.props.useDeepPilotLocalEnabled((s) => s), { status: 'unavailable', enabled: true })
  assert.deepEqual(first.props.useDeepPilotLocalPort((s) => s), MISSING_LOCAL_PORT_HOOK((s) => s))
  assert.deepEqual(first.props.useDeepPilotRemoteConnectionLimit((s) => s), MISSING_REMOTE_LIMIT_HOOK((s) => s))
  assert.deepEqual(first.props.useDeepPilotReport((s) => s), { status: 'loading', report: null, message: '' },
    '报告 hook 缺失时 report 保持 null，且不能伪装成 error（那会多推一条 hook 错误）')
})

test('可选函数在位时才进 props 与 can', () => {
  const raw = fullProps()
  delete raw.setDeviceName
  const surface = normalizeSettingsPageProps(raw)
  assert.equal(surface.props.setDeviceName, undefined)
  assert.equal(surface.can.has('setDeviceName'), false)
  assert.equal(surface.props.refresh, raw.refresh, '在位时原样透传，不包一层')
})

test('props 不是对象时不会炸', () => {
  for (const raw of [undefined, null, 42, 'nope']) {
    const surface = normalizeSettingsPageProps(raw)
    assert.equal(surface.diagnostics.length, 19)
    assert.equal(typeof surface.props.useDeepPilotReport, 'function')
  }
})

test('t 缺失时退化为回显 key，页面仍能渲染', () => {
  const surface = normalizeSettingsPageProps(fullProps({ t: undefined }))
  assert.equal(surface.props.t('any.key'), 'any.key')
})

test('SettingsPageProps 的 hook 数量与注入面一致', () => {
  // 注入面给 7 个 hook；这里防止将来加了 hook 却忘了进归一化。
  const hooks = Object.keys(fullProps()).filter((key) => key.startsWith('useDeepPilot'))
  assert.equal(hooks.length, 7)
  const surface = normalizeSettingsPageProps(fullProps())
  for (const hook of hooks) {
    assert.equal(typeof (surface.props as unknown as Record<string, unknown>)[hook], 'function', hook)
  }
})
