import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_REMOTE_HOSTNAME,
} from './remote-supervisor.ts'
import { DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE, MAX_FUNNEL_CONNECTIONS_PER_SOURCE } from './funnel-policy.ts'
import { bridgeDataDir } from './token.ts'
import { DEFAULT_LOCAL_PORT, MAX_LOCAL_PORT, MIN_LOCAL_PORT } from './local-policy.ts'

export interface Config {
  /** Master switch; when false the plugin activates and does nothing. */
  enabled?: boolean
  /** Protocol-v2 device registry JSON path. */
  devicesPath?: string
  /** Replay ring buffer bound (frames) per deployment. */
  historyBufferMax?: number
  /** Testing & troubleshooting, rendered as its own settings section. */
  diagnostics?: {
    /** Verbose per-frame diagnostics (never prints token or message bodies). */
    debug?: boolean
  }
  /** Independent LAN transport. Never exposes the wider DSH web server. */
  local?: {
    enabled?: boolean
    port?: number
  }
  /**
   * 本机预览（能力 localPreview）：允许已配对手机经预览连接查看电脑回环地址上、
   * 且在会话消息里出现过的网页。默认开启；关闭后新请求回 reason "disabled"。
   */
  preview?: {
    enabled?: boolean
    /**
     * 电脑端网页（能力 hostWeb）：允许已配对手机经预览连接打开电脑上的 DSH 网页端
     * （所有者权限，含第三方插件页面），并打开网页里出现的其他本机端口。默认关闭；
     * 还要求 `enabled` 为 true。关闭后请求回 reason "hostweb-disabled"，已开通道随即断开。
     */
    hostWeb?: boolean
  }
  /** Optional embedded remote transport. Reconciled when settings change. */
  remote?: {
    enabled?: boolean
    provider?: 'tailscale-funnel'
    hostname?: string
    statePath?: string
    helperPath?: string
    funnelPort?: 443 | 8443 | 10000
    /** Concurrent Funnel WebSockets allowed from one public source address. */
    maxConnectionsPerSource?: number
  }
  /**
   * Offline push (F-9). `apns` sends directly from the computer with the user's
   * Apple credentials. `relay` sends notify projections to an operator-run
   * relay for distributed builds. The device reports its own APNs environment,
   * so development and TestFlight/App Store devices may coexist.
   */
  push?: {
    /** `none` (default), `apns`, or `relay`. */
    provider?: 'none' | 'apns' | 'relay'
    /** Generic mode removes conversation-derived titles and bodies before outbound push. */
    contentMode?: 'preview' | 'generic'
    /** Apple Developer team id (JWT iss claim). */
    teamId?: string
    /** APNs auth key id (JWT kid header). */
    keyId?: string
    /** `.p8` private key path. */
    keyPath?: string
    /** App bundle id — the apns-topic header. */
    bundleId?: string
    /** Relay base URL. */
    relayUrl?: string
    /** Per-user bearer token issued by the relay operator. */
    relayToken?: string
  }
}

/** Operator-run relay used by distributed builds; overridable via config. */
export const DEFAULT_RELAY_URL = 'https://pilot.hailab.dev'

export const Config = z.object({
  // rc.2 accepts live settings writes only for fields declared volatile.
  enabled: z.boolean().default(true).volatile(),
  devicesPath: z.string().default(join(bridgeDataDir(), 'devices-v2.json')),
  historyBufferMax: z.natural().min(100).default(2000),
  diagnostics: z.object({
    debug: z.boolean().default(false)
      .description('打印握手、推送等诊断日志；不会打印配对令牌、APNs token 或消息内容'),
  }).default({
    debug: false,
  }).volatile(),
  local: z.object({
    // 已废弃：局域网监听常开，此值不再生效。保留字段只为让旧配置（含 enabled: false）照常加载。
    enabled: z.boolean().default(true),
    port: z.natural()
      .min(MIN_LOCAL_PORT)
      .max(MAX_LOCAL_PORT)
      .default(DEFAULT_LOCAL_PORT)
      .description('DeepPilot 局域网独立端口（仅 TLS；默认 3098，修改后本地连接会短暂重连）'),
  }).default({
    enabled: true,
    port: DEFAULT_LOCAL_PORT,
  }).volatile(),
  preview: z.object({
    enabled: z.boolean().default(true)
      .description('允许手机预览本机网页：只限会话消息里出现过的本机地址'),
    hostWeb: z.boolean().default(false)
      .description('允许手机打开电脑端网页：手机获得与本机浏览器相同的完全权限，需同时开启本机网页预览'),
  }).default({
    enabled: true,
    hostWeb: false,
  }).volatile(),
  remote: z.object({
    enabled: z.boolean().default(false),
    provider: z.union(['tailscale-funnel'] as const).default('tailscale-funnel'),
    hostname: z.string().default(DEFAULT_REMOTE_HOSTNAME),
    statePath: z.string().default(join(bridgeDataDir(), 'tailscale')),
    helperPath: z.string().default(''),
    funnelPort: z.union([443, 8443, 10000] as const).default(443),
    maxConnectionsPerSource: z.natural()
      .min(1)
      .max(MAX_FUNNEL_CONNECTIONS_PER_SOURCE)
      .default(DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE)
      .description('Funnel 每个来源允许的并发连接数（1–16，修改后远程连接会短暂重连）'),
  }).default({
    enabled: false,
    provider: 'tailscale-funnel',
    hostname: DEFAULT_REMOTE_HOSTNAME,
    statePath: join(bridgeDataDir(), 'tailscale'),
    helperPath: '',
    funnelPort: 443,
    maxConnectionsPerSource: DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE,
  }).volatile(),
  push: z.object({
    provider: z.union(['none', 'apns', 'relay'] as const).default('none'),
    contentMode: z.union(['preview', 'generic'] as const).default('preview'),
    teamId: z.string().default(''),
    keyId: z.string().default(''),
    keyPath: z.string().default(join(bridgeDataDir(), 'apns', 'AuthKey.p8')),
    bundleId: z.string().default('dev.hailab.deeppilot'),
    relayUrl: z.string().default(DEFAULT_RELAY_URL),
    relayToken: z.string().default(''),
  }).default({
    provider: 'none',
    contentMode: 'preview',
    teamId: '',
    keyId: '',
    keyPath: join(bridgeDataDir(), 'apns', 'AuthKey.p8'),
    bundleId: 'dev.hailab.deeppilot',
    relayUrl: DEFAULT_RELAY_URL,
    relayToken: '',
  }),
})

/**
 * Deep-unwrap live-update (volatile) references to plain values.
 *
 * On a 0.1.7 host, `apply()`'s options — and even a direct `Config(raw)` call
 * — carry `{ get() }` reference objects for volatile fields. Every consumer of
 * `currentConfig()` compares plain values (`=== true`, numeric bounds, object
 * fields), and schemastery refuses to re-parse a reference, so normalization
 * unwraps on the way in and on the way out. A JSON-shaped config value cannot
 * carry a function, so the `get` check cannot false-positive.
 */
export function plainConfig(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (typeof (value as { get?: unknown }).get === 'function') {
    // A reference's snapshot is recursively plain data (references cannot
    // nest inside references), so one unwrap layer suffices; recursion keeps
    // plain containers working around it.
    return plainConfig((value as { get: () => unknown }).get())
  }
  if (Array.isArray(value)) return value.map(plainConfig)
  const plain: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) plain[key] = plainConfig(item)
  return plain
}

/**
 * Cordis hands the second argument in different shapes depending on host
 * composition: a reactive options getter, the resolved config value, or
 * nothing when the patch row omits `config`. Normalize all of them — and
 * unwrap volatile references so the returned Config is plain data.
 */
export function normalizeOptions(options: unknown): Config {
  if (typeof options === 'function') return plainConfig((options as () => unknown)()) as Config
  if (options && typeof options === 'object') return plainConfig(options) as Config
  const validated = (Config as unknown as (data: unknown) => Config)(undefined)
  return plainConfig(validated ?? {}) as Config
}
