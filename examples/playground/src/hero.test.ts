import { describe, expect, it } from 'vitest'
import { droppedSample, heroSlotStyle, swapDurationFor, SWAP_DURATION_MS } from './hero'

describe('heroSlotStyle', () => {
  it('is the artwork box at cssPx on its long side, which frameStyle does not carry', () => {
    // `frameStyle` gives the PAPER box (400×500, scaled) offset onto the picture. The slot is the
    // picture's own rectangle: 200×300 at 360 css px on the long side is 1.2 css px per box px.
    expect(
      heroSlotStyle({ box: { w: 400, h: 500 }, artwork: { x: 50, y: 70, w: 200, h: 300 } }, 360),
    ).toEqual({ width: '240px', height: '360px' })
  })

  it('uses the width when the artwork is landscape', () => {
    expect(
      heroSlotStyle({ box: { w: 500, h: 400 }, artwork: { x: 70, y: 50, w: 300, h: 200 } }, 360),
    ).toEqual({ width: '360px', height: '240px' })
  })

  it('is null while no front is resident, so the slot keeps its stylesheet size', () => {
    expect(heroSlotStyle(null, 360)).toBeNull()
  })

  it('lays out a zero box, not a NaN one, for a frame with no artwork', () => {
    expect(
      heroSlotStyle({ box: { w: 0, h: 0 }, artwork: { x: 0, y: 0, w: 0, h: 0 } }, 360),
    ).toEqual({ width: '0px', height: '0px' })
  })
})

describe('droppedSample', () => {
  it('gives every drop its own sprite key, because a key names a picture and not a slot', () => {
    const fileA = new File([], 'photo.png')
    const fileB = new File([], 'photo.png')
    const a = droppedSample(fileA, 1)
    const b = droppedSample(fileB, 2)
    expect(a.id).not.toBe(b.id)
    expect(a.src).toBe(fileA)
    expect(b.src).toBe(fileB)
  })

  it('keeps the file name as the label the chips show', () => {
    expect(droppedSample(new File([], 'camel.png'), 7).label).toBe('camel.png')
  })
})

describe('swapDurationFor', () => {
  it('takes the audio clip length when there is one', () => {
    expect(swapDurationFor(585)).toBe(585)
  })

  it('falls back to the demo constant when sound is off or silent', () => {
    expect(swapDurationFor(null)).toBe(SWAP_DURATION_MS)
    expect(swapDurationFor(undefined)).toBe(SWAP_DURATION_MS)
  })

  it('never hands the binding a zero, which is a swap with no traversal at all', () => {
    expect(swapDurationFor(0)).toBe(SWAP_DURATION_MS)
  })
})
