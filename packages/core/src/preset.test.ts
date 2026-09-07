import { describe, expect, it } from 'vitest'
import { presetForImageId } from './preset.js'

describe('presetForImageId', () => {
  it('is deterministic in the key', () => {
    expect(presetForImageId('sweater')).toBe(presetForImageId('sweater'))
  })

  it('is eight lowercase hex digits, so it is a legal override string anywhere', () => {
    expect(presetForImageId('sweater')).toMatch(/^[0-9a-f]{8}$/)
    expect(presetForImageId('')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('separates the keys a grid actually uses, so a grid does not fold in unison', () => {
    const tokens = new Set(
      Array.from({ length: 64 }, (_, i) => presetForImageId(`tile-${String(i)}`)),
    )
    expect(tokens.size).toBe(64)
  })

  it('changes when the key changes, which is what makes changing a key change the animation', () => {
    expect(presetForImageId('sweater')).not.toBe(presetForImageId('sweaterr'))
  })
})
