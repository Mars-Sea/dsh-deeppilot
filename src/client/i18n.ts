/**
 * Internationalization for the DeepPilot settings page.
 *
 * Architecture:
 *  - The DSH host shell (via dsh-client-locale) owns language switching and
 *    owns the locale face every client module can register against. When
 *    that face is present we forward our strings to it and look them up via
 *    `ctx.locale.bind(namespace)(key)`, which is the runtime's contract.
 *  - When the locale face is absent (offline build, headless test, a
 *    profile that doesn't include dsh-client-locale) we still need to
 *    render the page in the user's language, so the same module ships a
 *    built-in fallback table keyed identically and resolves keys locally.
 *  - The `t(ctx, key, vars?)` helper hides which path is in use; callers
 *    always go through it. The optional second argument performs
 *    `{name}`-style substitution that the host bind() does not do.
 *
 * The tables below are the source of truth; the section header comment
 * here is the place to look when adding a key. A test in
 * `tests/i18n.test.ts` walks the table to guarantee every key in zh has a
 * matching en entry and vice versa, so a partial translation trips CI.
 */

import type { Context } from '@deepseek-ai/cordis'

/** DSH runtime locale face — structural, not imported (the package is not
 *  on this plugin's dependency surface). */
interface LocaleFace {
  register: (namespace: string, table: unknown) => () => void
  bind: (namespace: string) => (key: string, vars?: Readonly<Record<string, unknown>>) => string
  getSnapshot?: () => { active: string; revision: number }
}

interface AnyCtx extends Context {
  locale?: LocaleFace
}

/** Single namespace shared with the host's locale registry, so other
 *  host-side modules (if any) can translate the same keys. */
export const DEEPPILOT_LOCALE_NS = 'settings.deeppilot'

/** Locale codes this module currently ships. Keep in sync with the
 *  language switches the host exposes; the fallback picks `en` if a user
 *  ever requests a locale we don't translate. */
export type SupportedLocale = 'zh' | 'en'

/** Translation function injected by a locale-aware slot. */
export type Translate = (key: string, vars?: Readonly<Record<string, unknown>>) => string

interface LocaleTables {
  zh: Record<string, string>
  en: Record<string, string>
}

/**
 * Single source of truth. Every key here MUST have a translation in every
 * supported locale; the i18n.test.ts "table parity" check enforces that.
 *
 * Shape: `{ locale: { key: value } }` — the same shape `dsh-client-locale`'s
 * `register(namespace, table)` accepts (and the same shape we already used
 * at the bottom of client/index.ts before this module existed).
 *
 * Naming convention: `<section>.<field>` (two dotted segments, lowercase,
 * ASCII-only). Names longer than two segments are reserved for future
 * sub-section splits and intentionally absent today.
 */
const TABLES: LocaleTables = {
  zh: {
    // ---- meta / nav ----
    'nav': 'DeepPilot',
    'meta.title': 'DeepPilot',
    'meta.intro': '把 iPhone 与这台电脑上的 DeepSeek Harness（DSH）连接起来（协议 v1）。',
    'meta.refresh': '刷新',

    // ---- master switch ----
    'master.title': 'DeepPilot 连接',
    'master.loading': '正在读取配置…',
    'master.on': '已开启：接受手机连接。',
    'master.off': '已关闭：不接受手机连接。',

    // ---- remote switch (Tailscale Funnel) ----
    'remote.title': '远程连接（Tailscale Funnel）',
    'remote.on': '已配置：内嵌 Funnel 会自动启动并同步状态。',
    'remote.off': '关闭：仅保留局域网连接。',
    'remote.openAuth': '打开授权页面',

    // ---- remote phases ----
    'phase.disabled': '未启用',
    'phase.starting': '正在启动',
    'phase.login_required': '等待 Tailscale 授权',
    'phase.online': '远程连接已就绪',
    'phase.error': '远程连接失败',
    'phase.unavailable': '远程 helper 不可用',
    'phase.stopped': '已停止',
    'phase.unknown': '状态未知',

    // ---- connection panel ----
    'panel.activeConnections': '当前连接',
    'panel.token': '配对 Token',
    'panel.tokenReady': '已就绪',
    'panel.tokenNotReady': '未生成',
    'panel.tokenMasked': '••••••••••••',
    'panel.tokenAction.show': '显示',
    'panel.tokenAction.hide': '隐藏',
    'panel.tokenAction.copy': '复制',
    'panel.tokenAction.rotate': '更换',
    'panel.tokenAction.rotateConfirm': '确认更换？',
    'panel.tokenAction.showing': '读取中…',
    'panel.tokenAction.rotating': '更换中…',
    'panel.tokenAutoHidden': 'Token 已自动隐藏',
    'panel.tokenCopied': '已复制到剪贴板',
    'panel.tokenCopyFailed': '复制失败：',
    'panel.tokenRevealFailed': 'Token 读取失败：',
    'panel.tokenRotateWarning': '更换会使当前 Token 立即失效、断开所有手机连接；5 秒内再次点击确认。',
    'panel.tokenRotated': '新 Token 已生效，旧 Token 已失效；请重新配对所有设备。',
    'panel.tokenRotateFailed': '更换失败：',

    // ---- pairing QR ----
    'pair.qrPanelTitle': '扫码添加当前手机',
    'pair.kind.public': '公网',
    'pair.kind.lan': '内网',
    'pair.noAddress': '没有可用地址',
    'pair.noAddressHelp': '未发现可供手机访问的局域网地址，请确认这台电脑已连接局域网。',
    'pair.qrAlt': 'DeepPilot 配对二维码',
    'pair.qrShow': '显示二维码',
    'pair.qrHide': '隐藏二维码',
    'pair.qrGenerating': '生成中…',
    'pair.qrAutoHidden': '配对二维码已自动隐藏',
    'pair.qrFailed': '二维码生成失败：',
    'pair.publicCopyDone': '公网地址已复制',
    'pair.publicCopyFailed': '复制失败：',
    // `{kind}`: public | lan
    'pair.qrHint': '二维码包含{kind}地址和配对 Token，将在 60 秒后自动隐藏。',

    // ---- advanced info ----
    'advanced.summary': '高级信息',
    'advanced.protocolVersion': '协议版本',
    'advanced.serverVersion': '服务器版本',
    'advanced.tokenPath': 'Token 路径',
    'advanced.bufferMax': '重放缓冲上限',
    'advanced.frames': ' 帧',

    // ---- push tests ----
    'push.relayTitle': '离线推送中继',
    'push.testRelay': '测试访问与注册',
    'push.testPush': '发送测试通知',
    'push.relayTesting': '测试中…',
    'push.pushSending': '发送中…',
    'push.relayDefault': '验证 Mac 到推送中继的连通性与自动注册是否正常。',
    'push.pushDefault': '向所有已注册设备强制发送一条真实推送（不受在线状态与分类开关影响）。',
    'push.relayOk': '通过',
    'push.relayBad': '存在问题',
    'push.relayUrlEmpty': '（未启用）',
    'push.pushSent': '已送达',
    'push.pushFailed': '发送失败',
    'push.pushNoTargets': '无已注册设备',
    'push.pushNotEnabled': '推送未启用',
    'push.relayStep.health': '服务可达',
    'push.relayStep.enroll': '自动注册',
    'push.prefix.ok': '✓ ',
    'push.prefix.fail': '✗ ',

    // ---- devices table ----
    'devices.title': '已配对设备',
    'devices.col.name': '设备',
    'devices.col.appVersion': 'App 版本',
    'devices.col.push': '离线推送',
    'devices.col.lastSeen': '最近在线',
    'devices.pushRegistered': '已注册（',
    'devices.pushNotRegistered': '未注册',
    'devices.pushEnvProduction': '生产',
    'devices.pushEnvDevelopment': '开发',
    'devices.empty': '还没有设备配对过。在 iPhone 上的 DeepPilot App 中扫码或填入本机地址与 Token 即可配对。',

    // ---- remote help ----
    'help.remoteTitle': '远程连接帮助',
    'help.recommended': '推荐设置流程',
    'help.step1': '先打开"DeepPilot 连接"，再打开"远程连接（Tailscale Funnel）"。',
    'help.step2': '状态变为"等待 Tailscale 授权"后，点击"打开授权页面"。',
    'help.step3': '使用有权管理此 Tailnet 的账号登录，并按授权页提示启用 Funnel。通常需要 Owner、Admin 或 Network admin 权限。',
    'help.step4': '返回此页面并点击"刷新"。远程连接标题旁出现绿点后，即可扫描下方二维码添加手机。',
    'help.funnelHint': '插件已内嵌 Tailscale 网络组件，这台电脑和手机都不需要另外安装 Tailscale App；但首次启用仍需由 Tailnet 管理员授权。',
    'help.httpsTitle': '授权页未自动完成时：开启 HTTPS',
    'help.httpsStep1': '打开 Tailscale 管理后台的 Network → DNS。',
    'help.httpsStep2': '确认 MagicDNS 已开启。',
    'help.httpsStep3': '在 HTTPS Certificates 中点击 Enable HTTPS。',
    'help.httpsHint': '启用 HTTPS 后，设备的完整域名会写入公开的证书透明度日志。如果设备名包含敏感信息，请先在 Tailscale 中重命名设备。',
    'help.allowTitle': '授权页未自动完成时：允许 Funnel',
    'help.allowBody': '打开 Access controls → Definitions，选择 Node attributes。在现有 nodeAttrs 数组中追加下面这一项；不要覆盖已有访问规则，也不要创建第二个 nodeAttrs 顶层字段。',
    'help.allowHint': '保存策略后回到本页刷新。公共 DNS 和权限变更可能需要几分钟生效。',
    'help.faqTitle': '常见问题',
    'help.faq1': '提示"HTTPS must be enabled"：完成上面的 HTTPS Certificates 设置。',
    'help.faq2': '"Funnel not available"：确认 nodeAttrs 已保存，并且当前节点属于规则的 target。',
    'help.faq3': '已有公网地址但手机超时：等待几分钟后重试，同时确认这台电脑未休眠、DSH 正在运行，再重新扫描最新二维码。',
    'help.faq4': '没有公网地址：检查 Tailscale 授权是否完成，然后点击"刷新"或重启 DSH。',
    'help.securityTitle': '安全说明',
    'help.security1': 'Funnel 公网地址可从互联网访问，但手机接口仍需要配对 Token。不要分享二维码、Token 或包含它们的截图。',
    'help.security2': '怀疑 Token 泄露时，点击上方"更换"生成新 Token：旧 Token 立即失效，所有已连接设备会被断开并需要重新配对。',
    'help.security3': '插件只通过 Funnel 转发 /phone 和 /phone/health，不会新增 3098 端口。',
    'help.security4': '局域网连接沿用 DSH 的 3080 端口；仅在可信网络中使用，不建议直接把 3080 暴露到公网。',
    'help.security5': '关闭远程连接开关会停止 Funnel，但不会影响可用的局域网连接。',
    'help.funnelDocs': 'Tailscale Funnel 官方文档',
    'help.docsPrefix': '更多信息：',

    // ---- diagnostic line (visible when something is missing) ----
    'diag.remoteUnavailable': 'remote 服务不可用',
    'diag.remoteUnmounted': 'report remote 未挂载',
    'diag.mountFailed': '报告远程未挂载（remote mount 失败）— 请确认宿主包含 typert 组合',
    'diag.mountFailedShort': 'remote mount 失败: ',
    'diag.callFailed': 'report remote 调用失败',
    'diag.settingsUnavailable': '设置命名空间不可用（settingsScope 未提供）',
    'diag.missingReportHook': 'useDeepPilotReport hook 缺失',
    'diag.missingEnabledHook': 'useDeepPilotEnabled hook 缺失',
    'diag.missingRemoteEnabledHook': 'useDeepPilotRemoteEnabled hook 缺失',
    'diag.missingRefresh': 'refresh 回调缺失',
    'diag.missingReveal': 'revealPairingToken 回调缺失',
    'diag.missingRotate': 'rotatePairingToken 回调缺失',
    'diag.missingTestRelay': 'testRelay 回调缺失',
    'diag.missingTestPush': 'testPush 回调缺失',
    'diag.missingSetEnabled': 'setDeepPilotEnabled 回调缺失',
    'diag.missingSetRemote': 'setDeepPilotRemoteEnabled 回调缺失',
    'diag.renderError': '渲染异常: ',
    'diag.prefix': 'diag: ',

    // ---- clipboard fallback error (unrelated to user action) ----
    'clipboard.rejected': '浏览器拒绝了剪贴板写入',

    // ---- push test edge cases (server-side messages the UI surfaces verbatim) ----
    'push.staleHost': '宿主插件版本较旧，不支持推送测试',
    'push.staleHostRelay': '宿主插件版本较旧，不支持中继测试',
    'push.staleHostPush': '宿主插件版本较旧，不支持推送测试 — 请更新 dsh-deeppilot',
    'push.staleHostPushRelay': '宿主插件版本较旧，不支持中继测试 — 请更新 dsh-deeppilot',

    // ---- update checker ----
    'update.badge': '有新版本',
  },

  en: {
    // ---- meta / nav ----
    'nav': 'DeepPilot',
    'meta.title': 'DeepPilot',
    'meta.intro': 'Connect your iPhone to DeepSeek Harness (DSH) on this Mac (protocol v1).',
    'meta.refresh': 'Refresh',

    // ---- master switch ----
    'master.title': 'DeepPilot connection',
    'master.loading': 'Loading settings…',
    'master.on': 'On: accepting phone connections.',
    'master.off': 'Off: not accepting phone connections.',

    // ---- remote switch (Tailscale Funnel) ----
    'remote.title': 'Remote connection (Tailscale Funnel)',
    'remote.on': 'Configured: the embedded Funnel will start and sync state automatically.',
    'remote.off': 'Off: LAN connections only.',
    'remote.openAuth': 'Open authorization page',

    // ---- remote phases ----
    'phase.disabled': 'Disabled',
    'phase.starting': 'Starting',
    'phase.login_required': 'Awaiting Tailscale authorization',
    'phase.online': 'Remote connection ready',
    'phase.error': 'Remote connection failed',
    'phase.unavailable': 'Remote helper unavailable',
    'phase.stopped': 'Stopped',
    'phase.unknown': 'Status unknown',

    // ---- connection panel ----
    'panel.activeConnections': 'Active connections',
    'panel.token': 'Pairing token',
    'panel.tokenReady': 'Ready',
    'panel.tokenNotReady': 'Not generated',
    'panel.tokenMasked': '••••••••••••',
    'panel.tokenAction.show': 'Show',
    'panel.tokenAction.hide': 'Hide',
    'panel.tokenAction.copy': 'Copy',
    'panel.tokenAction.rotate': 'Rotate',
    'panel.tokenAction.rotateConfirm': 'Confirm rotate?',
    'panel.tokenAction.showing': 'Reading…',
    'panel.tokenAction.rotating': 'Rotating…',
    'panel.tokenAutoHidden': 'Token auto-hidden',
    'panel.tokenCopied': 'Copied to clipboard',
    'panel.tokenCopyFailed': 'Copy failed: ',
    'panel.tokenRevealFailed': 'Token reveal failed: ',
    'panel.tokenRotateWarning': 'Rotation invalidates the current token immediately and drops every paired phone. Click again within 5s to confirm.',
    'panel.tokenRotated': 'New token active, old token invalidated. Please re-pair every device.',
    'panel.tokenRotateFailed': 'Rotation failed: ',

    // ---- pairing QR ----
    'pair.qrPanelTitle': 'Scan to pair this phone',
    'pair.kind.public': 'Public',
    'pair.kind.lan': 'LAN',
    'pair.noAddress': 'No address available',
    'pair.noAddressHelp': 'No LAN address reachable from a phone. Make sure this Mac is on the local network.',
    'pair.qrAlt': 'DeepPilot pairing QR code',
    'pair.qrShow': 'Show QR code',
    'pair.qrHide': 'Hide QR code',
    'pair.qrGenerating': 'Generating…',
    'pair.qrAutoHidden': 'Pairing QR auto-hidden',
    'pair.qrFailed': 'QR generation failed: ',
    'pair.publicCopyDone': 'Public URL copied',
    'pair.publicCopyFailed': 'Copy failed: ',
    'pair.qrHint': 'The QR contains a {kind} address and the pairing token; it auto-hides after 60 seconds.',

    // ---- advanced info ----
    'advanced.summary': 'Advanced info',
    'advanced.protocolVersion': 'Protocol version',
    'advanced.serverVersion': 'Server version',
    'advanced.tokenPath': 'Token path',
    'advanced.bufferMax': 'Replay buffer cap',
    'advanced.frames': ' frames',

    // ---- push tests ----
    'push.relayTitle': 'Offline push relay',
    'push.testRelay': 'Test reach & enroll',
    'push.testPush': 'Send test notification',
    'push.relayTesting': 'Testing…',
    'push.pushSending': 'Sending…',
    'push.relayDefault': 'Verify Mac → push relay connectivity and zero-touch enrollment.',
    'push.pushDefault': 'Force one real push to every registered device (ignores online state and category switches).',
    'push.relayOk': 'OK',
    'push.relayBad': 'Issues found',
    'push.relayUrlEmpty': '(disabled)',
    'push.pushSent': 'Delivered',
    'push.pushFailed': 'Send failed',
    'push.pushNoTargets': 'No registered devices',
    'push.pushNotEnabled': 'Push not enabled',
    'push.relayStep.health': 'Service reachable',
    'push.relayStep.enroll': 'Auto enrollment',
    'push.prefix.ok': '✓ ',
    'push.prefix.fail': '✗ ',

    // ---- devices table ----
    'devices.title': 'Paired devices',
    'devices.col.name': 'Device',
    'devices.col.appVersion': 'App version',
    'devices.col.push': 'Push',
    'devices.col.lastSeen': 'Last seen',
    'devices.pushRegistered': 'Registered (',
    'devices.pushNotRegistered': 'Not registered',
    'devices.pushEnvProduction': 'Production',
    'devices.pushEnvDevelopment': 'Development',
    'devices.empty': 'No devices paired yet. Scan the QR code or enter the host address + token in DeepPilot on iPhone to pair.',

    // ---- remote help ----
    'help.remoteTitle': 'Remote connection help',
    'help.recommended': 'Recommended setup',
    'help.step1': 'Turn on "DeepPilot connection" first, then "Remote connection (Tailscale Funnel)".',
    'help.step2': 'When the status shows "Awaiting Tailscale authorization", click "Open authorization page".',
    'help.step3': 'Sign in with an account that can manage this Tailnet and follow the on-page prompts to enable Funnel. Owner / Admin / Network admin is usually required.',
    'help.step4': 'Come back to this page and click "Refresh". When a green dot appears next to the remote title, scan the QR code below to add your phone.',
    'help.funnelHint': 'The plugin bundles the Tailscale networking stack, so neither this Mac nor the phone needs the Tailscale app — but a Tailnet administrator must approve first-time use.',
    'help.httpsTitle': 'If authorization does not complete: enable HTTPS',
    'help.httpsStep1': 'Open the Tailscale admin console → Network → DNS.',
    'help.httpsStep2': 'Confirm MagicDNS is enabled.',
    'help.httpsStep3': 'In HTTPS Certificates click Enable HTTPS.',
    'help.httpsHint': 'Enabling HTTPS publishes the device hostname to public certificate transparency logs. Rename the device in Tailscale first if its name is sensitive.',
    'help.allowTitle': 'If authorization does not complete: allow Funnel',
    'help.allowBody': 'Open Access controls → Definitions, select Node attributes. Append the snippet below to your existing nodeAttrs array; do not overwrite other access rules and do not add a second top-level nodeAttrs field.',
    'help.allowHint': 'Save the policy and refresh this page. Public DNS and policy changes can take a few minutes to propagate.',
    'help.faqTitle': 'Frequently asked questions',
    'help.faq1': '"HTTPS must be enabled" — finish the HTTPS Certificates steps above.',
    'help.faq2': '"Funnel not available" — make sure the nodeAttrs snippet is saved and this node is in the rule\'s target.',
    'help.faq3': 'Public URL exists but the phone times out: wait a few minutes, confirm the Mac is awake and DSH is running, then re-scan the latest QR code.',
    'help.faq4': 'No public URL: check that Tailscale authorization completed, then click "Refresh" or restart DSH.',
    'help.securityTitle': 'Security notes',
    'help.security1': 'A Funnel public URL is reachable from the public Internet, but the phone interface still needs the pairing token. Do not share the QR code, the token, or any screenshot that contains them.',
    'help.security2': 'If you suspect the token leaked, click "Rotate" above to mint a new one. The old token stops working immediately and every paired device must re-pair.',
    'help.security3': 'The plugin only forwards /phone and /phone/health through Funnel; no new port 3098 is opened.',
    'help.security4': 'LAN connections reuse DSH\'s existing 3080 port. Use them only on trusted networks; do not expose 3080 directly to the public Internet.',
    'help.security5': 'Disabling the remote switch stops Funnel but does not affect any LAN connection you already have.',
    'help.funnelDocs': 'Tailscale Funnel docs',
    'help.docsPrefix': 'More info: ',

    // ---- diagnostic line (visible when something is missing) ----
    'diag.remoteUnavailable': 'remote service unavailable',
    'diag.remoteUnmounted': 'report remote not mounted',
    'diag.mountFailed': 'Report remote not mounted (mount failed) — confirm the host includes the typert composition',
    'diag.mountFailedShort': 'remote mount failed: ',
    'diag.callFailed': 'report remote call failed',
    'diag.settingsUnavailable': 'Settings namespace unavailable (settingsScope not provided)',
    'diag.missingReportHook': 'useDeepPilotReport hook missing',
    'diag.missingEnabledHook': 'useDeepPilotEnabled hook missing',
    'diag.missingRemoteEnabledHook': 'useDeepPilotRemoteEnabled hook missing',
    'diag.missingRefresh': 'refresh callback missing',
    'diag.missingReveal': 'revealPairingToken callback missing',
    'diag.missingRotate': 'rotatePairingToken callback missing',
    'diag.missingTestRelay': 'testRelay callback missing',
    'diag.missingTestPush': 'testPush callback missing',
    'diag.missingSetEnabled': 'setDeepPilotEnabled callback missing',
    'diag.missingSetRemote': 'setDeepPilotRemoteEnabled callback missing',
    'diag.renderError': 'Render error: ',
    'diag.prefix': 'diag: ',

    // ---- clipboard fallback error (unrelated to user action) ----
    'clipboard.rejected': 'Clipboard write rejected by the browser',

    // ---- push test edge cases (server-side messages the UI surfaces verbatim) ----
    'push.staleHost': 'Host plugin is too old for push testing',
    'push.staleHostRelay': 'Host plugin is too old for relay testing',
    'push.staleHostPush': 'Host plugin is too old for push testing — please update dsh-deeppilot',
    'push.staleHostPushRelay': 'Host plugin is too old for relay testing — please update dsh-deeppilot',

    // ---- update checker ----
    'update.badge': 'New version available',
  },
}

const ALL_KEYS: ReadonlyArray<string> = Object.keys(TABLES.zh)
/** Throw-on-missing helper, used by tests and as a last-ditch fallback in
 *  `t()`. Kept exported so the parity test can walk the entire namespace. */
export function translateOrThrow(
  locale: SupportedLocale,
  key: string,
): string {
  const value = TABLES[locale][key]
  if (value === undefined) {
    throw new Error(`i18n: missing key "${key}" in ${locale} table`)
  }
  return value
}

/** Substitute every `{name}` in `template` with `String(vars[name])`. The
 *  host bind() does not interpolate, so we always run the result through
 *  here for any key the caller asked to format. Numeric / object placeholders
 *  are coerced to strings; missing placeholders are left intact so a
 *  missing key is visible in the rendered output. */
export function interpolate(
  template: string,
  vars?: Readonly<Record<string, unknown>>,
): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    if (value === undefined) return match
    return String(value)
  })
}

/** Detect the active language from the locale snapshot or browser hints. */
function detectLocale(ctx: AnyCtx): SupportedLocale {
  try {
    const active = ctx.locale?.getSnapshot?.().active
    if (active === 'zh' || active?.toLowerCase().startsWith('zh-')) return 'zh'
    if (active === 'en' || active?.toLowerCase().startsWith('en-')) return 'en'
  } catch {
    // Fall through to browser hints when the locale face is unavailable.
  }

  const htmlLanguage = typeof document === 'undefined' ? '' : document.documentElement.lang
  if (htmlLanguage.toLowerCase().startsWith('zh')) return 'zh'
  const browserLanguages = typeof navigator === 'undefined' ? [] : navigator.languages
  if (browserLanguages.some((language) => language.toLowerCase().startsWith('zh'))) return 'zh'
  return 'en'
}

/**
 * Invoke the translation function supplied to a locale-aware slot. Keeping
 * this adapter distinct from `t(ctx, ...)` prevents a translator function
 * from being mistaken for a Cordis Context, which previously forced every
 * settings-page lookup through the English no-host fallback.
 */
export function translateWith(
  translator: unknown,
  key: string,
  vars?: Readonly<Record<string, unknown>>,
): string {
  if (typeof translator !== 'function') return key
  return (translator as Translate)(key, vars)
}

/** Translation function. Callers always go through this — never the
 *  underlying locale face — so the substitution / fallback path stays in
 *  one place. `ctx` may be omitted (offline / SSR / tests) and we resolve
 *  to en automatically. */
export function t(
  ctx: Context | undefined,
  key: string,
  vars?: Readonly<Record<string, unknown>>,
): string {
  const anyCtx = ctx as AnyCtx | undefined
  let template: string | undefined
  // Prefer the host locale when it can answer; fall back to our table only
  // when the host does not know the key (e.g. unsupported language) or
  // there is no host at all. The bind contract is `string`, so a missing
  // key is signalled by throwing — catch and fall through.
  if (anyCtx?.locale) {
    try {
      template = anyCtx.locale.bind(DEEPPILOT_LOCALE_NS)(key)
    } catch {
      template = undefined
    }
  }
  if (template === undefined || template === key) {
    const locale = detectLocale(anyCtx ?? ({ locale: undefined } as unknown as AnyCtx))
    // Walk the local tables; the test for a missing key in our own zh/en
    // tables is a *bug* in this module and must not crash the page. We
    // surface the key itself so the gap is visible in the rendered
    // output rather than masked by a blank or an exception.
    template = TABLES[locale][key] ?? TABLES.zh[key] ?? TABLES.en[key] ?? key
  }
  return interpolate(template, vars)
}

/** Register both dictionaries and return the host-owned disposer. */
export function registerLocale(ctx: Context): () => void {
  const anyCtx = ctx as AnyCtx
  if (anyCtx.locale === undefined) return () => {}
  return anyCtx.locale.register(DEEPPILOT_LOCALE_NS, {
    zh: TABLES.zh,
    en: TABLES.en,
  })
}

/** Test-time access: read every key we ship. Used by the parity test to
 *  guarantee zh and en stay in lock-step. */
export function _allKeysForTest(): ReadonlyArray<string> {
  return ALL_KEYS
}
