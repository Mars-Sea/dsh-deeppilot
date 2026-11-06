import { isPrivateIPv4 } from './local-address.ts'
import { localEndpointURLs } from './local-policy.ts'
import type { WelcomeRoutes } from './protocol.ts'

/**
 * welcome.routes（能力 routeHints）的纯计算：局域网监听在线且有指纹时给 RFC1918 地址
 * （顺序沿用 localLANIPv4Addresses 的物理网卡优先），Funnel 在线时给公网地址；两者都没有
 * 时返回 undefined，welcome 不带该字段。
 */
export function welcomeRoutes(
  local: { phase: string; port: number; tlsFingerprint?: string },
  remote: { phase: string; publicURL?: string },
  addresses: readonly string[],
): WelcomeRoutes | undefined {
  const lanAddresses = addresses.filter(isPrivateIPv4)
  const lan = local.phase === 'online' && local.tlsFingerprint && lanAddresses.length > 0
    ? { urls: localEndpointURLs(lanAddresses, local.port), tlsFingerprint: local.tlsFingerprint }
    : undefined
  const remoteURL = remote.phase === 'online' ? remote.publicURL : undefined
  if (lan === undefined && remoteURL === undefined) return undefined
  return { ...(lan ? { lan } : {}), ...(remoteURL ? { remote: { url: remoteURL } } : {}) }
}
