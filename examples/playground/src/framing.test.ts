import { describe, expect, it } from 'vitest'
import { frameArtwork } from './framing'

describe('frameArtwork', () => {
  it('pins the artwork at cssPx on its long side and scales the box by the same factor', () => {
    const f = frameArtwork(
      { box: { w: 400, h: 500 }, artwork: { x: 50, y: 70, w: 200, h: 300 } },
      360,
    )
    // 360 / 300 = 1.2 css px per box px.
    expect(f.image).toEqual({ w: 240, h: 360 })
    expect(f.canvas).toEqual({ w: 480, h: 600 })
    expect(f.offset).toEqual({ x: -60, y: -84 })
  })

  it('uses the width when the artwork is landscape', () => {
    const f = frameArtwork(
      { box: { w: 600, h: 300 }, artwork: { x: 100, y: 50, w: 400, h: 200 } },
      200,
    )
    expect(f.image).toEqual({ w: 200, h: 100 })
    expect(f.canvas).toEqual({ w: 300, h: 150 })
    expect(f.offset).toEqual({ x: -50, y: -25 })
  })

  it('places the canvas so the artwork lands on the image box, wherever the paper reaches', () => {
    // The paper reaches further on the left and top than on the right and bottom: the canvas
    // starts further up and left of the picture, and the picture is still `image` in size.
    const f = frameArtwork({ box: { w: 100, h: 100 }, artwork: { x: 30, y: 40, w: 50, h: 50 } }, 50)
    expect(f.image).toEqual({ w: 50, h: 50 })
    expect(f.canvas).toEqual({ w: 100, h: 100 })
    expect(f.offset).toEqual({ x: -30, y: -40 })
    // The artwork's far edge on the canvas is the image box's far edge.
    expect(f.offset.x + (30 + 50) * 1).toBe(f.image.w)
  })

  it('lays out zero boxes, not NaN ones, for a frame with no artwork', () => {
    const f = frameArtwork({ box: { w: 100, h: 100 }, artwork: { x: 0, y: 0, w: 0, h: 0 } }, 360)
    expect(f.image).toEqual({ w: 0, h: 0 })
    expect(f.canvas).toEqual({ w: 0, h: 0 })
    expect(f.offset).toEqual({ x: -0, y: -0 })
  })
})
