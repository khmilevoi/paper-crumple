import { describe, expect, it } from 'vitest'
import * as index from './index.js'
import * as unstable from './unstable.js'

describe('the stable barrel', () => {
  it('exports the one consumer-facing name of 7.4', () => {
    expect(typeof index.sizeForDisplay).toBe('function')
    expect(index.sizeForDisplay({ cssPx: 320, dpr: 2, cap: 1024 })).toBe(640)
  })

  it('does not publish the slot-authoring surface', () => {
    expect('identityResample' in index).toBe(false)
    expect('handleBytes' in index).toBe(false)
    expect('overscanFor' in index).toBe(false)
  })
})

describe('the slot-authoring barrel', () => {
  it('exports the filter and its constants', () => {
    expect(typeof unstable.identityResample).toBe('function')
    expect(typeof unstable.resampleAreaExact).toBe('function')
    expect(typeof unstable.axisPlan).toBe('function')
    expect(typeof unstable.idiv).toBe('function')
    expect(typeof unstable.roundDiv).toBe('function')
    expect(unstable.RESAMPLE_Q).toBe(128)
    expect(unstable.RESAMPLE_T).toBe(16384)
    expect(unstable.RESAMPLE_MAX_ACCUMULATOR).toBe(1_067_458_560)
  })

  it('exports the resolution and overscan arithmetic', () => {
    expect(unstable.sdfResFor(998)).toBe(512)
    expect(typeof unstable.overscanFor).toBe('function')
    expect(typeof unstable.overscanRadius).toBe('function')
    expect(typeof unstable.checkGuardBand).toBe('function')
    expect(unstable.artworkLongSide(384, 0.09)).toBe(326)
    expect(unstable.exactFrontLongSide(2000, 0.09)).toBe(2360)
    expect(unstable.KNOB_REFERENCE_PX).toBe(1000)
  })

  it('exports the byte accounting', () => {
    expect(unstable.frontBytes({ w: 384, h: 384 })).toBe(589_824)
    expect(typeof unstable.handleBytes).toBe('function')
    expect(unstable.poolABytes({ w: 326, h: 326 }, 192)).toBe(1_466_512)
    expect(unstable.poolBBytes({ w: 998, h: 951 })).toBe(3_796_392)
    expect(typeof unstable.scratchBytes).toBe('function')
  })

  it('keeps the LRU out of both barrels, because P9 owns its public shape', () => {
    expect('createFrontLru' in unstable).toBe(false)
    expect('createFrontLru' in index).toBe(false)
  })

  it('re-exports sizeForDisplay from the stable barrel only', () => {
    expect('sizeForDisplay' in unstable).toBe(false)
  })
})
