import { networkInterfaces } from 'node:os'

function octetsOf(address: string): [number, number, number, number] | null {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return null
  }
  return octets as [number, number, number, number]
}

/** RFC1918 私有地址。名字保持诚实：它**不**包含 CGNAT 段，见 isSharedAddressSpaceIPv4。 */
export function isPrivateIPv4(address: string): boolean {
  const parsed = octetsOf(address)
  if (parsed === null) return false
  const [a, b] = parsed
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * RFC 6598 共享地址空间（100.64.0.0/10）。
 *
 * Tailscale 与 Headscale 都从这个段里给节点分配地址（Headscale 的
 * `prefixes.v4` 默认就是它），因此它在实践中是私有的，只是不是 RFC1918——
 * 这正是 `isPrivateIPv4` 会把它拒掉的原因。把它单列成一个谓词而不是塞进
 * `isPrivateIPv4`，是为了不谎报那个名字（issue #24）。
 */
export function isSharedAddressSpaceIPv4(address: string): boolean {
  const parsed = octetsOf(address)
  if (parsed === null) return false
  const [a, b] = parsed
  return a === 100 && b >= 64 && b <= 127
}

/**
 * 可以交给手机的私有地址候选：RFC1918 加 CGNAT 段。
 *
 * 候选多于一个时，配对二维码页才会渲染地址选择器——只有一个候选时用户没有
 * 任何办法指定别的地址。把 tailnet 地址放进来，选择器才会出现，物理局域网
 * 离开之后用户仍可切到 tailnet 那个。
 *
 * 排序**不动**：物理 en* 接口仍然排在隧道接口之前，默认拿到的还是局域网地址，
 * 改变的只是「多了一个可选项」这件事本身。
 */
function isRoutablePrivateIPv4(address: string): boolean {
  return isPrivateIPv4(address) || isSharedAddressSpaceIPv4(address)
}

/** Private IPv4 candidates, preferring physical en* interfaces over tunnels. */
export function localLANIPv4Addresses(): string[] {
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isRoutablePrivateIPv4(entry.address)) {
        candidates.push({ name, address: entry.address })
      }
    }
  }
  const priority = (name: string): number => name === 'en0' ? 0 : name.startsWith('en') ? 1 : name.startsWith('bridge') ? 2 : 3
  candidates.sort((left, right) => priority(left.name) - priority(right.name) || left.name.localeCompare(right.name))
  return [...new Set(candidates.map(({ address }) => address))]
}
