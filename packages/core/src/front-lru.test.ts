import { beforeEach, describe, expect, it } from 'vitest'
import type { FrontLru } from './front-lru.js'
import { createFrontLru } from './front-lru.js'

/** The fake slot: it records what the LRU asked it to free, and owns nothing real. */
function fakeSlot(): { released: string[]; release: (key: string) => void } {
  const released: string[] = []
  return {
    released,
    release: (key: string) => {
      released.push(key)
    },
  }
}

describe('the front LRU', () => {
  let slot: ReturnType<typeof fakeSlot>
  let lru: FrontLru

  beforeEach(() => {
    slot = fakeSlot()
    lru = createFrontLru({ bytes: 1000, release: slot.release })
  })

  const add = (key: string, bytes: number, reclaimable = true): void =>
    lru.insert({ key, bytes, reclaimable })

  it('accounts fronts and nothing else', () => {
    add('a', 400)
    add('b', 300)
    expect(lru.usage()).toEqual({
      bytes: 700,
      reclaimable: 700,
      unreclaimable: 0,
      fronts: 2,
      pinned: 0,
      attached: 0,
    })
  })

  it('evicts least-recently-used first and hands the key back to the slot', () => {
    add('a', 400)
    add('b', 400)
    add('c', 400)
    expect(slot.released).toEqual(['a'])
    expect(lru.has('a')).toBe(false)
    expect(lru.usage().bytes).toBe(800)
  })

  it('touch reorders, so a drawn front outlives an untouched one', () => {
    add('a', 400)
    add('b', 400)
    lru.touch('a')
    add('c', 400)
    expect(slot.released).toEqual(['b'])
  })

  it('never evicts a front with attachCount > 0', () => {
    add('a', 400)
    lru.attach('a')
    add('b', 400)
    add('c', 400)
    expect(slot.released).toEqual(['b'])
    expect(lru.has('a')).toBe(true)
    expect(lru.usage().attached).toBe(1)
  })

  it('releases the hold when the last attachment goes', () => {
    add('a', 400)
    lru.attach('a')
    lru.attach('a')
    lru.detach('a')
    add('b', 400)
    add('c', 400)
    expect(slot.released).toEqual(['b'])
    lru.detach('a')
    expect(lru.usage().attached).toBe(0)
    add('d', 900)
    expect(slot.released).toContain('a')
  })

  it('never evicts a pinned front', () => {
    add('a', 400)
    lru.pin('a')
    add('b', 400)
    add('c', 400)
    expect(slot.released).toEqual(['b'])
    expect(lru.usage().pinned).toBe(1)
    lru.unpin('a')
    expect(lru.usage().pinned).toBe(0)
  })

  it('never evicts a front held as the pending target of a live crumpleTo', () => {
    add('a', 400)
    lru.hold('a')
    add('b', 400)
    add('c', 400)
    expect(slot.released).toEqual(['b'])
    lru.releaseHold('a')
    add('d', 900)
    expect(slot.released).toContain('a')
  })

  it('never evicts a front the application forbade it to free', () => {
    add('a', 400, false)
    add('b', 400)
    add('c', 400)
    expect(slot.released).toEqual(['b'])
    expect(lru.usage()).toMatchObject({ reclaimable: 400, unreclaimable: 400 })
  })

  it('keeps reclaimable + unreclaimable equal to the front tier', () => {
    add('a', 400, false)
    add('b', 300)
    const u = lru.usage()
    expect(u.reclaimable + u.unreclaimable).toBe(u.bytes)
  })

  it('never evicts the most recently used front, however small the budget', () => {
    lru.setBudget(1)
    add('a', 400)
    expect(lru.has('a')).toBe(true)
    expect(lru.usage().bytes).toBe(400)
  })

  it('never evicts the front the caller just inserted, even when the only other front is pinned', () => {
    add('a', 400)
    lru.pin('a')
    add('b', 700)
    expect(lru.has('b')).toBe(true)
    expect(slot.released).not.toContain('b')
    expect(lru.usage().bytes).toBe(1100)
  })

  it('overshoots rather than evicting what it may not, and says so', () => {
    add('a', 900, false)
    lru.pin('a')
    add('b', 900, false)
    expect(lru.usage().bytes).toBe(1800)
    expect(lru.usage().unreclaimable).toBe(1800)
    // The budget bounds the reclaimable set; it cannot bound a set the application has forbidden
    // the library to free. P9 emits the warning; the LRU only reports.
    expect(lru.usage().unreclaimable).toBeGreaterThan(1000)
  })

  it('evicts immediately when the budget is lowered', () => {
    add('a', 400)
    add('b', 400)
    lru.setBudget(500)
    expect(slot.released).toEqual(['a'])
  })

  it('replaces an entry in place and touches it', () => {
    add('a', 400)
    add('b', 400)
    add('a', 100)
    expect(lru.usage().bytes).toBe(500)
    expect(lru.usage().fronts).toBe(2)
    // 'a' is now the most recently used, so 'b' goes first when the budget bites.
    add('c', 600)
    expect(slot.released).toEqual(['b'])
  })

  it('remove frees the front exactly once', () => {
    add('a', 400)
    lru.remove('a')
    expect(slot.released).toEqual(['a'])
    expect(lru.usage().fronts).toBe(0)
    lru.remove('a')
    expect(slot.released).toEqual(['a'])
  })

  it('clear releases everything, most recently used last', () => {
    add('a', 100)
    add('b', 100)
    lru.pin('b')
    lru.clear()
    expect(slot.released.sort()).toEqual(['a', 'b'])
    expect(lru.usage().fronts).toBe(0)
  })

  it('reports keys most recently used first', () => {
    add('a', 10)
    add('b', 10)
    add('c', 10)
    lru.touch('a')
    expect(lru.keys()).toEqual(['a', 'c', 'b'])
  })

  it('ignores an operation on a key it does not hold, rather than throwing', () => {
    lru.touch('nope')
    lru.attach('nope')
    lru.detach('nope')
    lru.pin('nope')
    lru.unpin('nope')
    lru.hold('nope')
    lru.releaseHold('nope')
    expect(lru.usage().fronts).toBe(0)
  })
})
