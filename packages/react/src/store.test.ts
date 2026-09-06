import { describe, expect, it, vi } from 'vitest'
import { createVersionedStore } from './store.js'

describe('createVersionedStore (§5.5)', () => {
  it('reads once at construction and once per bump, never per getSnapshot', () => {
    const read = vi.fn(() => ({ n: 1 }))
    const store = createVersionedStore(read)
    expect(read).toHaveBeenCalledTimes(1)
    store.getSnapshot()
    store.getSnapshot()
    store.getSnapshot()
    expect(read).toHaveBeenCalledTimes(1)
    store.bump()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('returns one cached object until a bump, so useSyncExternalStore does not loop', () => {
    let n = 0
    const store = createVersionedStore(() => ({ n }))
    const before = store.getSnapshot()
    expect(store.getSnapshot()).toBe(before)
    n = 1
    expect(store.getSnapshot()).toBe(before)
    store.bump()
    const after = store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.n).toBe(1)
  })

  it('getServerSnapshot is the detached snapshot and never changes (§8)', () => {
    let n = 0
    const store = createVersionedStore(() => ({ n }))
    const detached = store.getServerSnapshot()
    n = 7
    store.bump()
    store.bump()
    expect(store.getServerSnapshot()).toBe(detached)
    expect(detached.n).toBe(0)
  })

  it('notifies every subscriber on bump and stops after unsubscribe', () => {
    const store = createVersionedStore(() => 0)
    const a = vi.fn()
    const b = vi.fn()
    const offA = store.subscribe(a)
    store.subscribe(b)
    store.bump()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    store.bump()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('a listener that unsubscribes during a notification does not skip its neighbour', () => {
    const store = createVersionedStore(() => 0)
    const seen: string[] = []
    const off = store.subscribe(() => {
      seen.push('a')
      off()
    })
    store.subscribe(() => {
      seen.push('b')
    })
    store.bump()
    expect(seen).toEqual(['a', 'b'])
  })

  it('does not notify a listener subscribed during the same bump', () => {
    const store = createVersionedStore(() => 0)
    const late = vi.fn()
    store.subscribe(() => {
      store.subscribe(late)
    })
    store.bump()
    expect(late).not.toHaveBeenCalled()
  })
})
