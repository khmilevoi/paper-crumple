import type { ViewFrame } from '@paper-crumple/core'
import { expect, test } from 'vitest'
import { frameStyleFor } from './frame-style.js'

/** The paper reaches 20px past the picture on every side, at pose 0. */
const FRAME: ViewFrame = {
  box: { w: 240, h: 240 },
  artwork: { x: 20, y: 20, w: 200, h: 200 },
}

test('no frameTo means the hook reports frame and applies nothing (§5.1)', () => {
  expect(frameStyleFor(FRAME, undefined)).toBeNull()
})

test('no frame means no style — nothing is resident to scale (§5.1)', () => {
  expect(frameStyleFor(null, 192)).toBeNull()
})

test('one scale, frameTo / max(artwork.w, artwork.h), applied to both boxes (§6)', () => {
  // scale = 192 / 200 = 0.96
  expect(frameStyleFor(FRAME, 192)).toEqual({
    width: '230.4px',
    height: '230.4px',
    left: '-19.2px',
    top: '-19.2px',
  })
})

test('the long side is the artwork long side, not the box long side', () => {
  const wide: ViewFrame = { box: { w: 400, h: 200 }, artwork: { x: 50, y: 25, w: 300, h: 150 } }
  // scale = 150 / 300 = 0.5
  expect(frameStyleFor(wide, 150)).toEqual({
    width: '200px',
    height: '100px',
    left: '-25px',
    top: '-12.5px',
  })
})

test('a frame with no artwork lays out zero boxes rather than NaN ones', () => {
  const empty: ViewFrame = { box: { w: 240, h: 240 }, artwork: { x: 0, y: 0, w: 0, h: 0 } }
  expect(frameStyleFor(empty, 192)).toEqual({
    width: '0px',
    height: '0px',
    left: '0px',
    top: '0px',
  })
})
