export const DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE = 8
export const MAX_FUNNEL_CONNECTIONS_PER_SOURCE = 16

export function normalizeFunnelConnectionLimit(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FUNNEL_CONNECTIONS_PER_SOURCE
    ? value
    : DEFAULT_FUNNEL_CONNECTIONS_PER_SOURCE
}
