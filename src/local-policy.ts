export const DEFAULT_LOCAL_PORT = 3098
export const MIN_LOCAL_PORT = 1024
export const MAX_LOCAL_PORT = 65_535

export function normalizeLocalPort(value: unknown): number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_LOCAL_PORT
    && value <= MAX_LOCAL_PORT
    ? value
    : DEFAULT_LOCAL_PORT
}

/** The LAN listener is TLS-only, so every advertised endpoint is `https://`. */
export function localEndpointURLs(addresses: readonly string[], port: number): string[] {
  const normalizedPort = normalizeLocalPort(port)
  return [...new Set(addresses)].map((address) => `https://${address}:${normalizedPort}`)
}

export function localListenError(error: unknown, port: number): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return `local port ${port} is already in use`
  if (code === 'EACCES') return `permission denied while opening local port ${port}`
  return error instanceof Error ? error.message : String(error)
}
