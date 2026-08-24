import { networkInterfaces } from 'node:os'

export function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false
  }
  const [a, b] = octets as [number, number, number, number]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Private IPv4 candidates, preferring physical en* interfaces over tunnels. */
export function localLANIPv4Addresses(): string[] {
  const candidates: Array<{ name: string; address: string }> = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) {
        candidates.push({ name, address: entry.address })
      }
    }
  }
  const priority = (name: string): number => name === 'en0' ? 0 : name.startsWith('en') ? 1 : name.startsWith('bridge') ? 2 : 3
  candidates.sort((left, right) => priority(left.name) - priority(right.name) || left.name.localeCompare(right.name))
  return [...new Set(candidates.map(({ address }) => address))]
}
