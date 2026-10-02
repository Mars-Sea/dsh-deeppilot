/**
 * 宿主能力探测（host capability probe）的唯一属主。
 *
 * `welcome.capabilities` 的每一位都必须由这里的一张表推导；此前同一条事实
 * 存在两份——getter 里的表达式与各 Bridge 方法内的 `typeof` 再探测——
 * 已经漂移过两次：`models` 位要求 `models && selectModel`，而
 * `c2s.session.models` 只需要 `models`（门过严）；`schedules` 位只探
 * `list && create`，而五个 schedule 方法只要求服务存在（部分 Host 上会 TypeError）。
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
  | 'sessionManagement'
  | 'sessionFork'
  | 'sessionRestore'
  | 'projectSelection'
  | 'schedules'

/** 每位一行：Host 上必须存在的依赖。缺失即该位为 false，相关帧回 E_UNSUPPORTED。 */
export const HOST_CAPABILITY_PROBES: Record<ProbedCapability, (proxy: ApiProxyLike) => boolean> = {
  // PROTOCOL.md：模型列表必须由 Host 的 session.models 动态提供。切换模型另由
  // c2s.session.selectModel 自己的探测兜底（缺 selectModel 时回 E_UNSUPPORTED）。
  models: (proxy) => typeof proxy.sessions.models === 'function',
  sessionManagement: (proxy) =>
    typeof proxy.sessions.rename === 'function' &&
    typeof proxy.workspace?.archiveSession === 'function',
  sessionFork: (proxy) => typeof proxy.sessions.fork === 'function',
  sessionRestore: (proxy) => typeof proxy.workspace?.unarchiveSession === 'function',
  projectSelection: (proxy) =>
    typeof proxy.workspace?.list === 'function' &&
    typeof proxy.workspace?.create === 'function',
  // 五个 schedule 帧都只要求 Schedule 服务存在；历史上按 list&&create 探测的取值
  // 会在只实现了部分方法的 Host 上把位压成 false，而方法体内又只判服务存在。
  schedules: (proxy) => proxy.schedule !== undefined,
}

/** 由 Bridge 自身恒真的位（见 BRIDGE_INVARIANT_CAPABILITIES）。 */
export type BridgeInvariantCapability = (typeof BRIDGE_INVARIANT_CAPABILITIES)[number]

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
    approvals: true,
    questions: true,
    pendingSnapshot: true,
    promptDelivery: true,
    notifyAllCategories: true,
    models: HOST_CAPABILITY_PROBES.models(proxy),
    sessionManagement: HOST_CAPABILITY_PROBES.sessionManagement(proxy),
    sessionFork: HOST_CAPABILITY_PROBES.sessionFork(proxy),
    sessionRestore: HOST_CAPABILITY_PROBES.sessionRestore(proxy),
    projectSelection: HOST_CAPABILITY_PROBES.projectSelection(proxy),
    schedules: HOST_CAPABILITY_PROBES.schedules(proxy),
    push: pushOutlet?.isAvailable() === true,
    widgetPush: true,
    liveActivityPush: true,
    deviceRevoke: true,
  }
}
