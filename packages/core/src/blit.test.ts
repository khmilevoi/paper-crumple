import { describe, expect, it } from 'vitest'
import { blitPlan, managedBackingStore } from './blit.js'

describe('blitPlan', () => {
  it('reads the source rect from the surface bottom-left, not the top-left', () => {
    // GL's viewport origin is bottom-left; a 2D canvas's is top-left.
    const p = blitPlan({
      surface: { w: 384, h: 384 },
      front: { w: 200, h: 120 },
      dest: { w: 200, h: 120 },
      fit: 'stretch',
    })
    expect(p.src).toEqual({ x: 0, y: 384 - 120, w: 200, h: 120 })
  })

  it("fit: 'stretch' fills the destination and clears nothing but the destination itself", () => {
    const p = blitPlan({
      surface: { w: 512, h: 512 },
      front: { w: 100, h: 100 },
      dest: { w: 300, h: 60 },
      fit: 'stretch',
    })
    expect(p.dest).toEqual({ x: 0, y: 0, w: 300, h: 60 })
    expect(p.clear).toEqual([{ x: 0, y: 0, w: 300, h: 60 }])
  })

  it("fit: 'contain' letterboxes and names the bars to clear", () => {
    const p = blitPlan({
      surface: { w: 512, h: 512 },
      front: { w: 100, h: 100 },
      dest: { w: 300, h: 100 },
      fit: 'contain',
    })
    // A square front inside a 300x100 box scales to 100x100 and is centred horizontally.
    expect(p.dest).toEqual({ x: 100, y: 0, w: 100, h: 100 })
    expect(p.clear).toEqual([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 200, y: 0, w: 100, h: 100 },
    ])
  })

  it("fit: 'contain' letterboxes on the other axis too", () => {
    const p = blitPlan({
      surface: { w: 512, h: 512 },
      front: { w: 100, h: 100 },
      dest: { w: 100, h: 300 },
      fit: 'contain',
    })
    expect(p.dest).toEqual({ x: 0, y: 100, w: 100, h: 100 })
    expect(p.clear).toEqual([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 200, w: 100, h: 100 },
    ])
  })

  it('clears the whole destination when the front is degenerate rather than drawing nothing', () => {
    const p = blitPlan({
      surface: { w: 64, h: 64 },
      front: { w: 0, h: 10 },
      dest: { w: 40, h: 40 },
      fit: 'contain',
    })
    expect(p.dest).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(p.clear).toEqual([{ x: 0, y: 0, w: 40, h: 40 }])
  })
})

describe('managedBackingStore', () => {
  it('sizes the destination to round(cssSize x dpr)', () => {
    expect(
      managedBackingStore({
        cssSize: { w: 150, h: 75 },
        dpr: 2,
        front: { w: 1024, h: 1024 },
        current: { w: 300, h: 150 },
      }),
    ).toEqual({ w: 300, h: 150 })
  })

  it('caps at the front size, because a destination past the front resamples by definition', () => {
    expect(
      managedBackingStore({
        cssSize: { w: 400, h: 400 },
        dpr: 3,
        front: { w: 384, h: 384 },
        current: { w: 10, h: 10 },
      }),
    ).toEqual({ w: 384, h: 384 })
  })

  it('answers null when the backing store is already correct, so no draw resets it', () => {
    expect(
      managedBackingStore({
        cssSize: { w: 96, h: 96 },
        dpr: 2,
        front: { w: 512, h: 512 },
        current: { w: 192, h: 192 },
      }),
    ).toBeNull()
  })

  it('leaves a zero CSS size alone: a zero-sized backing store is a destroyed one', () => {
    expect(
      managedBackingStore({
        cssSize: { w: 0, h: 0 },
        dpr: 2,
        front: { w: 512, h: 512 },
        current: { w: 300, h: 150 },
      }),
    ).toBeNull()
  })

  it('treats a non-finite or non-positive dpr as 1 rather than producing NaN', () => {
    expect(
      managedBackingStore({
        cssSize: { w: 100, h: 50 },
        dpr: Number.NaN,
        front: { w: 512, h: 512 },
        current: { w: 1, h: 1 },
      }),
    ).toEqual({ w: 100, h: 50 })
  })
})
