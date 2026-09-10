// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { droppedSample } from './hero'
import { nextLibrarySample, SAMPLES } from './samples'

describe('dropped samples', () => {
  it('keeps the File itself as the reclaimable SpriteSource', () => {
    const file = new File(['pixels'], 'photo.png', { type: 'image/png' })
    const sample = droppedSample(file, 4)
    expect(sample.src).toBe(file)
    expect(sample.id).toBe('dropped-4')
    expect(sample.label).toBe('photo.png')
  })
})

describe('nextLibrarySample', () => {
  const sweater = SAMPLES[0]
  const trench = SAMPLES[1]

  it('adopts library samples', () => {
    expect(nextLibrarySample(sweater, trench)).toBe(trench)
  })

  it('keeps the controlled select on a library option for a dropped source', () => {
    expect(nextLibrarySample(sweater, droppedSample(new File([], 'x.png'), 1))).toBe(sweater)
  })
})
