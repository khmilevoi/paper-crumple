import { describe, expect, it, vi } from 'vitest'
import { detachedCrumple } from './crumple-fixtures.js'

describe('detachedCrumple', () => {
  it('returns the complete detached P4 shape', () => {
    const value = detachedCrumple()
    expect(value).toMatchObject({
      state: 'detached',
      status: 'detached',
      parked: false,
      pose: 0,
      shown: null,
      sprite: null,
      requested: null,
      pending: null,
      error: null,
      frame: null,
      frameStyle: null,
      artworkStyle: null,
      view: null,
    })
    expect(value.play('flat', 'ball')).toBeNull()
    expect(() => value.stop()).not.toThrow()
    expect(() => value.refresh()).not.toThrow()
    expect(() => value.draw(0)).not.toThrow()
    expect(() => value.sync()).not.toThrow()
    expect(() => value.retry()).not.toThrow()
  })

  it('applies overrides after the defaults', () => {
    const ref = vi.fn()
    const value = detachedCrumple({ ref, shown: 'hero', status: 'shown' })
    expect(value.ref).toBe(ref)
    expect(value.shown).toBe('hero')
    expect(value.status).toBe('shown')
  })
})
