/**
 * 宿主能力探测（host capability probe）的唯一属主。
 *
 * `welcome.capabilities` 的每一位都必须由这里的一张表推导；此前同一条事实
 * 存在两份——getter 里的表达式与各 Bridge 方法内的 `typeof` 再探测——
 * 已经漂移过两次：`models` 位要求 `models && selectModel`，而
 * `c2s.session.models` 只需要 `models`（门过严）；`schedules` 位只探
 * `list && create`，而五个 schedule 方法只要求服务存在（部分 Host 上会 TypeError）。
 * 新增的 `schedulesHost` 取同一个 adapter 的判别位（与会话级位同源），不再单独
 * 探方法——同类漂移在宿主级模型上会直接表现为「新帧被门挡住」或「能力位撒谎」。
 *
 * 规则：一位一行，表达式取「该位所闸的帧真正需要的最小依赖」。位与帧的绑定
 * 由 wire 注册表的 `capability` 字段声明（见 wire-registry.ts），host-bridge
 * 只负责把表算出来，不再各自判断。
 */

import type { ApiProxyLike, PushOutlet } from './host-api.ts'
import type { WelcomeCapabilities } from './protocol.ts'

/** 由宿主表达式挣得的位；表在 HOST_CAPABILITY_PROBES。 */
export type ProbedCapability =
  | 'models'
  | 'skills'
  | 'commands'
  | 'references'
  | 'sessionManagement'
  | 'sessionFork'
  | 'sessionRestore'
  | 'projectSelection'
  | 'schedules'
  | 'schedulesHost'
  | 'promptQueue'
  | 'sessionMarkdown'
  | 'assistantStream'
  | 'pluginUpdate'

// 自更新服务由宿主可选注入，生命周期与 Bridge 数据源相互独立。按代理实例绑定
// 就绪探针，避免用「模块被导入」冒充服务已就绪，也不让能力表反向依赖 wire 行表。
const pluginUpdateProbes = new WeakMap<ApiProxyLike, () => boolean>()
export function setPluginUpdateProbe(proxy: ApiProxyLike, probe: (() => boolean) | undefined): void {
  if (probe) pluginUpdateProbes.set(proxy, probe)
  else pluginUpdateProbes.delete(proxy)
}

/** 每位一行：Host 上必须存在的依赖。缺失即该位为 false，相关帧回 E_UNSUPPORTED。 */
export const HOST_CAPABILITY_PROBES: Record<ProbedCapability, (proxy: ApiProxyLike) => boolean> = {
  // PROTOCOL.md：模型列表必须由 Host 的 session.models 动态提供。切换模型另由
  // c2s.session.selectModel 自己的探测兜底（缺 selectModel 时回 E_UNSUPPORTED）。
  models: (proxy) => typeof proxy.sessions.models === 'function',
  skills: (proxy) => typeof proxy.sessions.skills === 'function',
  commands: (proxy) => typeof proxy.commands?.list === 'function' && typeof proxy.commands?.execute === 'function',
  // 文件引用（fileReferences）或会话引用（sessionReferenceResolver）任一挂载即为真；
  // 哪一类可用由 s2c.session.references 的 available 字段逐类说明。
  references: (proxy) => typeof proxy.references?.list === 'function',
  sessionManagement: (proxy) =>
    typeof proxy.sessions.rename === 'function' &&
    typeof proxy.workspace?.archiveSession === 'function',
  sessionFork: (proxy) => typeof proxy.sessions.fork === 'function',
  sessionRestore: (proxy) => typeof proxy.workspace?.unarchiveSession === 'function',
  projectSelection: (proxy) =>
    typeof proxy.workspace?.list === 'function' &&
    typeof proxy.workspace?.create === 'function',
  // 五个会话级 schedule 帧都只要求 Schedule 服务存在；历史上按 list&&create 探测
  // 的取值会在只实现了部分方法的 Host 上把位压成 false，而方法体内又只判服务存在。
  schedules: (proxy) => proxy.schedule !== undefined,
  // 宿主级能力位与 schedules 同源：取同一个已解析 adapter 的判别位，而不是再按
  // 控制器的某个方法探一遍（该方法探测与能力位曾漂移过两次，见文件头）。
  schedulesHost: (proxy) => proxy.schedule?.mode === 'host',
  // 排队快照来自 inbox 投影，增删转向走 session.updateQueue；两者在支持的 DSH
  // 版本里同时提供（DSH_RELEASE_MEMORY 2026-10-24 实测 0.2.0-rc.2），因此只探方法。
  promptQueue: (proxy) => typeof proxy.sessions.updateQueue === 'function',
  sessionMarkdown: (proxy) => proxy.commands?.markdownAvailable === true && typeof proxy.commands?.export === 'function',
  assistantStream: (proxy) => proxy.assistantStreamAvailable === true,
  pluginUpdate: (proxy) => pluginUpdateProbes.get(proxy)?.() === true,
}

/** 由 Bridge 自身恒真的位（见 BRIDGE_INVARIANT_CAPABILITIES）。 */
export type BridgeInvariantCapability = (typeof BRIDGE_INVARIANT_CAPABILITIES)[number]

/** 只约束出站瞬时帧的能力，无须用入站请求触发。 */
export const OUTBOUND_HOST_CAPABILITIES = {
  assistantStream: 's2c.session.delta',
} as const

/** 由推送出口就绪状态决定的位（APNs 凭据或中继注册）。 */
export type OutletCapability = 'push'

/**
 * 门禁必须留在 handler 内的位。`push` 是唯一一个：零配置注册（enrollKey）
 * 必须先于能力门执行，否则首次注册恰好发生在推送尚未就绪时就会被拒，
 * 分布式构建的自动启用链就此断掉（见 wire-push.ts 的同名说明）。
 */
export const HANDLER_GATED_CAPABILITIES = ['push'] as const satisfies ReadonlyArray<OutletCapability>

/** 行上的能力门可以引用三类位中的任意一种。 */
export type CapabilityGate = ProbedCapability | BridgeInvariantCapability | OutletCapability

/**
 * Bridge 自身恒为真的位：与宿主无关，列出是为了让读者一眼看出 welcome 上哪些位
 * 不是从 Host 推导的。缺失这些位中的任何一个都意味着 Bridge 实现被改动，
 * 改这里不改帧的 gate 属于遗漏。
 */
export const BRIDGE_INVARIANT_CAPABILITIES = [
  'historyPaging',
  'replay',
  'approvals',
  'questions',
  'pendingSnapshot',
  'promptDelivery',
  'notifyAllCategories',
  'widgetPush',
  'liveActivityPush',
  'deviceRevoke',
  'sessionInterest',
  'compressedFrames',
  'incrementalTail',
  'routeHints',
  'localPreview',
  'hostWeb',
] as const satisfies ReadonlyArray<keyof WelcomeCapabilities>

/**
 * 按当前 apiProxy 与推送出口算出 welcome 能力位。`push` 位描述「当前离线推送
 * 可用」：APNs 凭据或中继注册就绪才为 true，否则客户端不应压下自己的本地通知。
 */
export function capabilityBits(
  proxy: ApiProxyLike,
  pushOutlet: PushOutlet | undefined,
): WelcomeCapabilities {
  return {
    historyPaging: true,
    replay: true,
    // 插件自身能力，不依赖宿主：导出块与附件可按请求改用二进制帧。
    binaryFrames: true,
    // 插件自身能力：连接声明关注集合后，会话事件只发给打开或关注的会话。
    sessionInterest: true,
    // 插件自身能力：客户端声明 acceptEncoding 后，超过 8 KB 的下行帧以 deflate-raw 压缩。
    compressedFrames: true,
    // 插件自身能力：session.open 带 sinceSeq 时回增量 tail（无法保证完整时回全量）。
    incrementalTail: true,
    // 插件自身能力：welcome 带当前可用的局域网 / Funnel 地址，供手机自动选路。
    routeHints: true,
    // 插件自身能力：预览连接可把手机回环 TCP 连接转发到电脑回环地址（设置页关闭时请求回 disabled）。
    localPreview: true,
    // 插件自身能力：预览连接可申请电脑端网页登录地址（设置页关闭或宿主不支持时请求回 hostweb-*）。
    hostWeb: true,
    approvals: true,
    questions: true,
    pendingSnapshot: true,
    promptDelivery: true,
    notifyAllCategories: true,
    goalView: proxy.goalViewAvailable === true,
    goalNotifications: true,
    models: HOST_CAPABILITY_PROBES.models(proxy),
    skills: HOST_CAPABILITY_PROBES.skills(proxy),
    commands: HOST_CAPABILITY_PROBES.commands(proxy),
    references: HOST_CAPABILITY_PROBES.references(proxy),
    sessionManagement: HOST_CAPABILITY_PROBES.sessionManagement(proxy),
    sessionFork: HOST_CAPABILITY_PROBES.sessionFork(proxy),
    sessionRestore: HOST_CAPABILITY_PROBES.sessionRestore(proxy),
    projectSelection: HOST_CAPABILITY_PROBES.projectSelection(proxy),
    schedules: HOST_CAPABILITY_PROBES.schedules(proxy),
    schedulesHost: HOST_CAPABILITY_PROBES.schedulesHost(proxy),
    promptQueue: HOST_CAPABILITY_PROBES.promptQueue(proxy),
    sessionMarkdown: HOST_CAPABILITY_PROBES.sessionMarkdown(proxy),
    assistantStream: HOST_CAPABILITY_PROBES.assistantStream(proxy),
    pluginUpdate: HOST_CAPABILITY_PROBES.pluginUpdate(proxy),
    push: pushOutlet?.isAvailable() === true,
    widgetPush: true,
    liveActivityPush: true,
    deviceRevoke: true,
  }
}
