import { describe, expect, it } from 'vitest'
import { HULL_CACHE_VARIANTS_PER_SPRITE, hullCache } from './hull-cache.js'
import type { HullCacheKey } from './hull-cache.js'
import { HULL_USE_ALPHA, packPolygons } from './hull-shape.js'
import type { HullShape } from './hull-shape.js'

const key = (spriteKey: string, sdfRes = 192, knobKey = 'a=1'): HullCacheKey => ({
  spriteKey,
  sdfRes,
  knobKey,
})

/** A distinguishable hull: the marker rides in the iso, which nothing here reads. */
const hull = (marker: number): HullShape =>
  packPolygons(
    [
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    ],
    marker,
    1,
  )

const isoOf = (h: HullShape | undefined): number | undefined =>
  h && h.kind === 'polygons' ? h.iso : undefined

describe('the hull cache', () => {
  it('returns what it was given, under the same key', () => {
    const cache = hullCache()
    expect(cache.get(key('shirt'))).toBeUndefined()
    cache.set(key('shirt'), hull(1))
    expect(isoOf(cache.get(key('shirt')))).toBe(1)
    expect(cache.size).toBe(1)
  })

  it('keys on all three of sprite key, sdfRes and hull knobs', () => {
    const cache = hullCache()
    cache.set(key('shirt', 192, 'a=1'), hull(1))
    expect(cache.get(key('shirt', 512, 'a=1'))).toBeUndefined()
    expect(cache.get(key('shirt', 192, 'a=2'))).toBeUndefined()
    expect(cache.get(key('shoes', 192, 'a=1'))).toBeUndefined()
    expect(isoOf(cache.get(key('shirt', 192, 'a=1')))).toBe(1)
  })

  it('stores the use-alpha sentinel like any other shape', () => {
    const cache = hullCache()
    cache.set(key('shirt'), HULL_USE_ALPHA)
    expect(cache.get(key('shirt'))).toBe(HULL_USE_ALPHA)
  })

  it('overwrites rather than duplicating when the same key is set twice', () => {
    const cache = hullCache()
    cache.set(key('shirt'), hull(1))
    cache.set(key('shirt'), hull(2))
    expect(cache.size).toBe(1)
    expect(isoOf(cache.get(key('shirt')))).toBe(2)
  })

  it('counts hits and misses', () => {
    const cache = hullCache()
    cache.set(key('shirt'), hull(1))
    cache.get(key('shirt'))
    cache.get(key('shirt'))
    cache.get(key('shoes'))
    expect(cache.stats()).toEqual({
      sprites: 1,
      entries: 1,
      hits: 2,
      misses: 1,
      invalidations: 0,
    })
  })
})

describe('invalidate, the entry point §18 amendment 10 needs', () => {
  it('drops every variant of one sprite from a key that carries nothing but the sprite key', () => {
    const cache = hullCache()
    cache.set(key('shirt', 192, 'a=1'), hull(1))
    cache.set(key('shirt', 512, 'a=1'), hull(2))
    cache.set(key('shirt', 192, 'a=2'), hull(3))
    cache.set(key('shoes', 192, 'a=1'), hull(4))
    expect(cache.size).toBe(4)

    expect(cache.invalidate('shirt')).toBe(3)

    expect(cache.get(key('shirt', 192, 'a=1'))).toBeUndefined()
    expect(cache.get(key('shirt', 512, 'a=1'))).toBeUndefined()
    expect(cache.get(key('shirt', 192, 'a=2'))).toBeUndefined()
    expect(isoOf(cache.get(key('shoes', 192, 'a=1')))).toBe(4)
    expect(cache.size).toBe(1)
    expect(cache.stats().invalidations).toBe(1)
  })

  it('is a no-op on a key it has never seen, and says so with a zero', () => {
    const cache = hullCache()
    expect(cache.invalidate('never-added')).toBe(0)
    expect(cache.stats().invalidations).toBe(1)
  })

  it('is what stops a re-supplied 200 serving the previous artwork torn edge', () => {
    // The premise §8.2.1 keeps the cache on: the polygon is deterministic in the alpha, and the key
    // merely stands in for it. Amendment 10 is the case where the bytes move under the key.
    const cache = hullCache()
    const before = hull(1) // the hull built from the first response's bytes
    const after = hull(2) // the hull the 200's bytes would build
    cache.set(key('shirt'), before)

    // A 304 leaves the entry alone and the rebuild proceeds as a rebuild.
    expect(cache.get(key('shirt'))).toBe(before)

    // A 200 is replace() semantics: the entry goes, so the new artwork gets its own torn edge.
    cache.invalidate('shirt')
    expect(cache.get(key('shirt'))).toBeUndefined()
    cache.set(key('shirt'), after)
    expect(cache.get(key('shirt'))).toBe(after)
  })
})

describe('the per-sprite variant cap', () => {
  it('defaults to four, so a front-class slider drag cannot grow the cache without bound', () => {
    expect(HULL_CACHE_VARIANTS_PER_SPRITE).toBe(4)
    const cache = hullCache()
    for (let i = 0; i < 20; i++) cache.set(key('shirt', 192, `angularity=${i}`), hull(i))
    expect(cache.size).toBe(4)
    expect(isoOf(cache.get(key('shirt', 192, 'angularity=19')))).toBe(19)
    expect(cache.get(key('shirt', 192, 'angularity=0'))).toBeUndefined()
  })

  it('evicts the least recently used variant, and a get counts as a use', () => {
    const cache = hullCache({ variantsPerSprite: 2 })
    cache.set(key('shirt', 192, 'a'), hull(1))
    cache.set(key('shirt', 192, 'b'), hull(2))
    cache.get(key('shirt', 192, 'a')) // 'b' is now the least recently used
    cache.set(key('shirt', 192, 'c'), hull(3))
    expect(isoOf(cache.get(key('shirt', 192, 'a')))).toBe(1)
    expect(cache.get(key('shirt', 192, 'b'))).toBeUndefined()
    expect(isoOf(cache.get(key('shirt', 192, 'c')))).toBe(3)
  })

  it('caps per sprite and not globally, because one sprite must not evict another', () => {
    const cache = hullCache({ variantsPerSprite: 1 })
    cache.set(key('shirt'), hull(1))
    cache.set(key('shoes'), hull(2))
    cache.set(key('hat'), hull(3))
    expect(cache.size).toBe(3)
    expect(cache.stats().sprites).toBe(3)
  })
})

describe('clear', () => {
  it('drops every sprite and resets the counters', () => {
    const cache = hullCache()
    cache.set(key('shirt'), hull(1))
    cache.get(key('shirt'))
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.stats()).toEqual({ sprites: 0, entries: 0, hits: 0, misses: 0, invalidations: 0 })
  })
})
