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
  /** Verbose per-frame diagnostics (never prints token or message bodies). */
  debug?: boolean
  /** Independent LAN transport. Never exposes the wider DSH web server. */
  local?: {
    enabled?: boolean
    port?: number
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
   * Offline push (F-9). `apns` sends directly from the Mac with the user's
   * Apple credentials. `relay` sends notify projections to an operator-run
   * relay for distributed builds. The device reports its own APNs environment,
   * so development and TestFlight/App Store devices may coexist.
   */
  push?: {
    /** `none` (default), `apns`, or `relay`. */
    provider?: 'none' | 'apns' | 'relay'
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
  enabled: z.boolean().default(true),
  devicesPath: z.string().default(join(bridgeDataDir(), 'devices-v2.json')),
  historyBufferMax: z.natural().min(100).default(2000),
  debug: z.boolean().default(false),
  local: z.object({
    enabled: z.boolean().default(true),
    port: z.natural()
      .min(MIN_LOCAL_PORT)
      .max(MAX_LOCAL_PORT)
      .default(DEFAULT_LOCAL_PORT)
      .description('DeepPilot 局域网独立端口（默认 3098，修改后本地连接会短暂重连）'),
  }).default({
    enabled: true,
    port: DEFAULT_LOCAL_PORT,
  }),
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
  }),
  push: z.object({
    provider: z.union(['none', 'apns', 'relay'] as const).default('none'),
    teamId: z.string().default(''),
    keyId: z.string().default(''),
    keyPath: z.string().default(join(bridgeDataDir(), 'apns', 'AuthKey.p8')),
    bundleId: z.string().default('dev.hailab.deeppilot'),
    relayUrl: z.string().default(DEFAULT_RELAY_URL),
    relayToken: z.string().default(''),
  }).default({
    provider: 'none',
    teamId: '',
    keyId: '',
    keyPath: join(bridgeDataDir(), 'apns', 'AuthKey.p8'),
    bundleId: 'dev.hailab.deeppilot',
    relayUrl: DEFAULT_RELAY_URL,
    relayToken: '',
  }),
})

/**
 * Cordis hands the second argument in different shapes depending on host
 * composition: a reactive options getter, the resolved config value, or
 * nothing when the patch row omits `config`. Normalize all of them.
 */
export function normalizeOptions(options: unknown): Config {
  if (typeof options === 'function') return (options as () => Config)()
  if (options && typeof options === 'object') return options as Config
  const validated = (Config as unknown as (data: unknown) => Config)(undefined)
  return validated ?? {}
}
