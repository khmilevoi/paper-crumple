/**
 * The external store `useSyncExternalStore` reads, versioned by hand.
 *
 * Spec §5.5: the core's events are a supplementary source, not the source — the default entrance,
 * every reduced-motion swap, every `draw`, every landed re-source and the whole ball park emit
 * nothing at all. So the binding bumps this store on every call it makes into the core, and each
 * bump re-reads the getters into one cached snapshot object.
 */
export interface VersionedStore<T> {
  /** Returns the unsubscribe closure `useSyncExternalStore` expects. */
  subscribe(onStoreChange: () => void): () => void
  /** The cached snapshot. Identical by reference until the next `bump()`. */
  getSnapshot(): T
  /** The snapshot captured at construction — spec §8's detached snapshot. */
  getServerSnapshot(): T
  /** Re-read the getters into a new cached snapshot, then notify. */
  bump(): void
}

export function createVersionedStore<T>(read: () => T): VersionedStore<T> {
  const listeners = new Set<() => void>()
  let snapshot = read()
  const detached = snapshot

  return {
    subscribe(onStoreChange: () => void): () => void {
      listeners.add(onStoreChange)
      return () => {
        listeners.delete(onStoreChange)
      }
    },
    getSnapshot: (): T => snapshot,
    getServerSnapshot: (): T => detached,
    bump(): void {
      snapshot = read()
      // Iterate a copy: a listener is allowed to unsubscribe itself from inside the notification,
      // and a listener added during one must not be called by it.
      for (const listener of [...listeners]) listener()
    },
  }
}
