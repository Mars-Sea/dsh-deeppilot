/**
 * Tiny observable snapshot store consumed by the harness slot renderer's
 * `useSyncExternalStore` hooks.
 *
 * Kept local because the rc.1 browser module table does not publish
 * `@deepseek-ai/dsh-client-store` for external plugins. The generated bundle
 * therefore has no unavailable runtime dependency.
 */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(value: T): void
}

export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(value) {
      if (Object.is(value, snapshot)) return
      snapshot = value
      for (const listener of listeners) listener()
    },
  }
}
