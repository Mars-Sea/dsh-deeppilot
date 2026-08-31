/**
 * Normalize an operator-configured relay URL without a backtracking regular
 * expression. Scanning from the end keeps even pathological inputs linear.
 */
export function normalizeRelayBaseUrl(value: string): string {
  const trimmed = value.trim()
  let end = trimmed.length
  while (end > 0 && trimmed.charCodeAt(end - 1) === 0x2f) end -= 1
  return end === trimmed.length ? trimmed : trimmed.slice(0, end)
}
