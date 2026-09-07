import { describe, expect, it } from 'vitest'
import {
  INVALIDATION_ORDER,
  SPRITE_SCOPE,
  VIEW_SCOPE,
  atOrAbove,
  hullCacheKey,
  invalidationRank,
  maxInvalidation,
} from './invalidation.js'
import { knobs } from './knobs.js'

describe('the ladder (§6.3)', () => {
  it('is exactly four levels, in order', () => {
    expect(INVALIDATION_ORDER).toEqual(['draw', 'front', 'hull', 'field'])
  })

  it('ranks each level by its position, so a level implies everything to its left', () => {
    expect(invalidationRank('draw')).toBe(0)
    expect(invalidationRank('field')).toBe(3)
    expect(atOrAbove('field', 'hull')).toBe(true)
    expect(atOrAbove('hull', 'hull')).toBe(true)
    expect(atOrAbove('front', 'hull')).toBe(false)
    expect(atOrAbove('draw', 'draw')).toBe(true)
  })

  it('takes the strongest level of a set, and nothing from an empty one', () => {
    expect(maxInvalidation(['draw', 'hull', 'front'])).toBe('hull')
    expect(maxInvalidation(['draw'])).toBe('draw')
    expect(maxInvalidation([])).toBeUndefined()
  })
})

describe('the two scopes (§6.6)', () => {
  it('gives a view the draw class alone and a sprite the whole ladder', () => {
    expect(VIEW_SCOPE).toEqual(['draw'])
    expect(SPRITE_SCOPE).toEqual(['draw', 'front', 'hull', 'field'])
  })
})

describe('the hull cache key (§6.3, §8.5)', () => {
  const descriptors = knobs([
    { key: 'ambient', kind: 'number', invalidates: 'draw', default: 0.35, min: 0, max: 1 },
    { key: 'grain', kind: 'number', invalidates: 'front', default: 0.09, min: 0, max: 0.5 },
    { key: 'angularity', kind: 'number', invalidates: 'hull', default: 0.5, min: 0, max: 1 },
    { key: 'sdfRes', kind: 'int', invalidates: 'field', default: 192, min: 64, max: 512 },
  ])

  it('carries every knob at or above hull, and nothing below it', () => {
    const key = hullCacheKey(descriptors, {
      ambient: 0.35,
      grain: 0.09,
      angularity: 0.5,
      sdfRes: 192,
    })
    expect(key).toBe('angularity=0.5|sdfRes=192')
  })

  it('is stable under descriptor order, because the cache is keyed on it', () => {
    const reversed = [...descriptors].reverse()
    const values = { ambient: 0.35, grain: 0.09, angularity: 0.5, sdfRes: 192 }
    expect(hullCacheKey(reversed, values)).toBe(hullCacheKey(descriptors, values))
  })

  it('changes when a hull knob changes and not when a draw knob does', () => {
    const base = { ambient: 0.35, grain: 0.09, angularity: 0.5, sdfRes: 192 }
    expect(hullCacheKey(descriptors, { ...base, ambient: 0.9 })).toBe(
      hullCacheKey(descriptors, base),
    )
    expect(hullCacheKey(descriptors, { ...base, angularity: 0.6 })).not.toBe(
      hullCacheKey(descriptors, base),
    )
  })
})
