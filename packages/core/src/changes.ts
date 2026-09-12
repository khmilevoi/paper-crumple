import { rethrowFromMicrotask } from './emitter.js'

export type ChangeArea = 'lifecycle' | 'settings' | 'resources' | 'content' | 'geometry' | 'state'

export interface ChangeSource {
  subscribe(area: ChangeArea, listener: () => void): () => void
  revision(area: ChangeArea): number
}

export interface ChangePublisher extends ChangeSource {
  emit(area: ChangeArea): void
  batch<T>(operation: () => T): T
  clear(): void
}

/** Internal lifecycle operation; deliberately absent from the public barrel interfaces. */
export interface InternalChangePublisher extends ChangePublisher {
  clearAfterBatch(): void
}

const areas: readonly ChangeArea[] = [
  'lifecycle',
  'settings',
  'resources',
  'content',
  'geometry',
  'state',
]

/** Internal stage transaction: queues only publishers with observed, dirty areas. */
export function createChangeBatch() {
  const pending = new Set<() => void>()
  const cleanup = new Set<() => void>()
  let depth = 0
  let flushing = false
  function flush(): void {
    if (depth !== 0 || flushing || (pending.size === 0 && cleanup.size === 0)) return
    flushing = true
    try {
      while (pending.size > 0) {
        const next = pending.values().next().value
        if (next === undefined) break
        pending.delete(next)
        next()
      }
      for (const done of cleanup) done()
      cleanup.clear()
    } finally {
      flushing = false
    }
  }
  return {
    batch<T>(operation: () => T): T {
      depth += 1
      try {
        return operation()
      } finally {
        depth -= 1
        flush()
      }
    },
    schedule(deliver: () => void): void {
      pending.add(deliver)
      flush()
    },
    after(done: () => void): void {
      cleanup.add(done)
      flush()
    },
  }
}

export function createChanges(
  group?: ReturnType<typeof createChangeBatch>,
): InternalChangePublisher {
  const listeners: (Set<() => void> | undefined)[] = Array.from({ length: areas.length })
  const revisions = Array.from({ length: areas.length }, () => 0)
  let dirty = 0
  let depth = 0
  let generation = 0
  let listenerCount = 0

  function mark(area: ChangeArea): void {
    const index = areas.indexOf(area)
    revisions[index] = (revisions[index] ?? 0) + 1
    if (listeners[index]?.size) dirty |= 1 << index
  }

  function flush(): void {
    const startGeneration = generation
    while (dirty !== 0) {
      const pending = dirty
      dirty = 0
      for (let index = 0; index < areas.length; index += 1) {
        if ((pending & (1 << index)) === 0) continue
        const bucket = listeners[index]
        if (bucket === undefined || bucket.size === 0) continue
        const snapshot = [...bucket]
        for (const listener of snapshot) {
          if (!bucket.has(listener)) continue
          try {
            listener()
          } catch (thrown) {
            rethrowFromMicrotask(thrown)
          }
          if (generation !== startGeneration) return
        }
      }
    }
  }

  function subscribe(area: ChangeArea, listener: () => void): () => void {
    const index = areas.indexOf(area)
    const bucket = listeners[index] ?? new Set<() => void>()
    listeners[index] = bucket
    if (!bucket.has(listener)) listenerCount += 1
    bucket.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (bucket.delete(listener)) listenerCount -= 1
      if (bucket.size === 0 && listeners[index] === bucket) {
        listeners[index] = undefined
        dirty &= ~(1 << index)
      }
    }
  }

  function emit(area: ChangeArea): void {
    mark(area)
    if (depth === 0 && dirty !== 0) {
      if (group === undefined) flush()
      else group.schedule(flush)
    }
  }

  function batch<T>(operation: () => T): T {
    depth += 1
    try {
      return operation()
    } finally {
      depth -= 1
      if (depth === 0 && dirty !== 0) {
        if (group === undefined) flush()
        else group.schedule(flush)
      }
    }
  }

  function clear(): void {
    generation += 1
    dirty = 0
    if (listenerCount === 0) return
    for (let index = 0; index < areas.length; index += 1) {
      listeners[index]?.clear()
      listeners[index] = undefined
    }
    listenerCount = 0
  }

  return {
    subscribe,
    revision: (area) => revisions[areas.indexOf(area)] ?? 0,
    emit,
    batch: group === undefined ? batch : (operation) => group.batch(() => batch(operation)),
    clear,
    clearAfterBatch: () => {
      if (listenerCount === 0 || group === undefined) clear()
      else group.after(clear)
    },
  }
}
