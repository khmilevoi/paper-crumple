import type { HullShape } from './hull-shape.js'

/**
 * §8.5's hull cache key: "(sprite key, `sdfRes`, hull knobs)".
 *
 * `knobKey` is **opaque here**. The core's `hullCacheKey(descriptors, values)` on
 * `@paper-crumple/core/unstable` produces the knob half — every knob at or above `'hull'`, sorted
 * by key — and its own documentation says "the sheet slot composes this with its own sprite key".
 * The sheet renderer is that composer; this cache neither imports it nor reimplements it.
 */
export interface HullCacheKey {
  readonly spriteKey: string
  readonly sdfRes: number
  readonly knobKey: string
}

export interface HullCacheStats {
  readonly sprites: number
  readonly entries: number
  readonly hits: number
  readonly misses: number
  readonly invalidations: number
}

export interface HullCache {
  get(key: HullCacheKey): HullShape | undefined
  /**
   * Registers `hull` under `key`, marking it as the sprite's most recently used variant.
   *
   * A sprite holds at most `HULL_CACHE_VARIANTS_PER_SPRITE` (4) variants. Setting a fifth **silently
   * evicts** that sprite's least-recently-used variant — no error, no warning. A later `get` for the
   * evicted variant simply misses, and the caller rebuilds it.
   */
  set(key: HullCacheKey, hull: HullShape): void
  /**
   * §18 amendment 10. Drops **every** variant registered under `spriteKey` — every `sdfRes`, every
   * knob combination — and returns how many were dropped.
   *
   * The parameter is a sprite key alone because the caller on the `replace()` path knows the key
   * and nothing else: not `sdfRes`, not the knob values, not how many variants a slider drag left
   * behind. An entry point that demanded the whole key could not be called from where amendment 10
   * needs it called.
   *
   * Two callers, one entry point: the stage, when a conditional re-supply comes back `200` and the
   * bytes moved under a key §8.5.1 promised would not move; and the sheet renderer's `release()`,
   * when the sprite is gone.
   */
  invalidate(spriteKey: string): number
  /** Drops every sprite and resets the counters. */
  clear(): void
  /** Total entries across every sprite. */
  readonly size: number
  stats(): HullCacheStats
}

/**
 * Four variants per sprite. A front-class slider drag mints a fresh `knobKey` on every step, and an
 * uncapped map would turn "a few kilobytes" (§8.2.1) into an unbounded one; four keeps the sprite's
 * built variant plus the last few of a drag. The cap is **per sprite**, never global, because one
 * sprite evicting another's hull would make a wardrobe's rebuild cost depend on scroll order.
 */
export const HULL_CACHE_VARIANTS_PER_SPRITE = 4

function variantOf(key: HullCacheKey): string {
  return `${key.sdfRes}|${key.knobKey}`
}

export function hullCache(o?: { variantsPerSprite?: number }): HullCache {
  const cap = Math.max(1, Math.floor(o?.variantsPerSprite ?? HULL_CACHE_VARIANTS_PER_SPRITE))
  // Outer key: the sprite. Inner key: everything else. That nesting is what makes `invalidate` a
  // single delete and correct by construction rather than by a scan the next author might narrow.
  const sprites = new Map<string, Map<string, HullShape>>()
  let hits = 0
  let misses = 0
  let invalidations = 0

  const countEntries = (): number => {
    let total = 0
    for (const variants of sprites.values()) total += variants.size
    return total
  }

  return {
    get(key) {
      const variants = sprites.get(key.spriteKey)
      if (!variants) {
        misses++
        return undefined
      }
      const variant = variantOf(key)
      const hull = variants.get(variant)
      if (hull === undefined) {
        misses++
        return undefined
      }
      hits++
      // A Map iterates in insertion order, so re-inserting is what makes this an LRU.
      variants.delete(variant)
      variants.set(variant, hull)
      return hull
    },

    set(key, hull) {
      let variants = sprites.get(key.spriteKey)
      if (!variants) {
        variants = new Map<string, HullShape>()
        sprites.set(key.spriteKey, variants)
      }
      const variant = variantOf(key)
      variants.delete(variant)
      variants.set(variant, hull)
      while (variants.size > cap) {
        const oldest = variants.keys().next()
        if (oldest.done) break
        variants.delete(oldest.value)
      }
    },

    invalidate(spriteKey) {
      invalidations++
      const variants = sprites.get(spriteKey)
      if (!variants) return 0
      const dropped = variants.size
      sprites.delete(spriteKey)
      return dropped
    },

    clear() {
      sprites.clear()
      hits = 0
      misses = 0
      invalidations = 0
    },

    get size() {
      return countEntries()
    },

    stats() {
      return { sprites: sprites.size, entries: countEntries(), hits, misses, invalidations }
    },
  }
}
