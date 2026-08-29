/**
 * Tiny observable snapshot store consumed by the harness slot renderer's
 * `useSyncExternalStore` hooks.
 *
 * Vendored intentionally: the 0.1.2 web shell may seed an internal
 * `@deepseek-ai/dsh-client-store` module, but that package is not published
 * for external plugins and is not present in every host module table. Keeping
 * this three-method utility local ensures the generated browser bundle has no
 * unavailable runtime dependency.
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
