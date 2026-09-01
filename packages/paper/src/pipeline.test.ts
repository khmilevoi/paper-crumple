import { describe, expect, it } from 'vitest'
import * as paper from './index.js'
import {
  buildHull,
  cpuSdfFromAlpha,
  hullCache,
  hullComponentCount,
  hullBytes,
  hullExtent,
  hullVertexCount,
  measureHull,
  sheetRect,
  toleranceFor,
} from './index.js'
import type { PackedHull } from './index.js'
import { discAlpha, unionAlpha } from './test-fixtures.js'

// The default configuration §8.6 and the spike's DEFAULT_PARAMS between them fix.
const FIELD = 192 // sdfRes at maxSize 384
const ARTWORK = 326 // maxSize / (1 + 2p) at p = 0.09, the hull mode's derived overscan
const KNOB_REFERENCE_PX = 1000 // core's constant, quoted rather than imported (see the constraints)
const HULL_SAMPLE_PX = 4

const KNOBS = { minDist: 22, maxDist: 72, angularity: 0.7, seed: 3 } // reference px

/**
 * `engine.js`'s conversion: knobs are reference px, the field is in texels.
 *   pxScale = artwork height / KNOB_REFERENCE_PX
 *   texel   = artwork width / field width
 *   k       = pxScale / texel
 * At a square 326 px artwork on a 192 texel field that is exactly 0.192.
 */
const pxScale = ARTWORK / KNOB_REFERENCE_PX
const texel = ARTWORK / FIELD
const k = pxScale / texel

function hullFor(field: Float32Array) {
  return buildHull({
    field,
    width: FIELD,
    height: FIELD,
    minDist: KNOBS.minDist * k,
    maxDist: KNOBS.maxDist * k,
    angularity: KNOBS.angularity,
    seed: KNOBS.seed,
    tolerance: toleranceFor(KNOBS.angularity) * k,
    wavelength: paper.DISTANCE_WAVELENGTH_PX * k,
    sampleStep: HULL_SAMPLE_PX / texel,
  })
}

/** One garment-shaped island: a disc of radius 50 at the centre of the field. */
const garment = (radius = 50): Float32Array =>
  cpuSdfFromAlpha(discAlpha(FIELD, FIELD, 96, 96, radius), FIELD, FIELD)

/** Two well-separated islands. */
const sneakers = (): Float32Array =>
  cpuSdfFromAlpha(
    unionAlpha(discAlpha(FIELD, FIELD, 48, 96, 26), discAlpha(FIELD, FIELD, 144, 96, 26)),
    FIELD,
    FIELD,
  )

function packed(hull: paper.HullShape): PackedHull {
  expect(hull.kind).toBe('polygons')
  return hull as PackedHull
}

describe('the k conversion the harness reproduces', () => {
  it('is 0.192 at the default configuration, and the band lands where §8.2.1 says', () => {
    expect(k).toBeCloseTo(0.192, 10)
    expect(KNOBS.minDist * k).toBeCloseTo(4.224, 10)
    expect(KNOBS.maxDist * k).toBeCloseTo(13.824, 10)
  })
})

describe('measureHull reproduces the authored [22, 72] band', () => {
  it('keeps every vertex inside it and no chord closer than minDist', () => {
    const field = garment()
    const built = hullFor(field)
    const m = measureHull(field, FIELD, FIELD, packed(built.hull), HULL_SAMPLE_PX / texel)

    // Back to reference px, the frame the knobs are quoted in.
    const vertexMin = m.vertexMin / k
    const vertexMax = m.vertexMax / k
    const segmentMin = m.segmentMin / k

    // moveToDistance stops within 0.02 texels of its target, i.e. 0.104 reference px.
    expect(vertexMin).toBeGreaterThanOrEqual(KNOBS.minDist - 0.5)
    expect(vertexMax).toBeLessThanOrEqual(KNOBS.maxDist + 0.5)
    // The repair pass calls a sample too close at `-(lo - 0.25)`: 0.25 texels, i.e. 1.30 ref px.
    expect(segmentMin).toBeGreaterThanOrEqual(KNOBS.minDist - 2)
    // The band is actually used rather than collapsing onto one distance.
    expect(vertexMax - vertexMin).toBeGreaterThan(10)
  })
})

describe('a pair of sneakers gets two pieces of paper', () => {
  it('keeps every outer loop, not just the largest', () => {
    const built = hullFor(sneakers())
    expect(hullComponentCount(built.hull)).toBe(2)
    expect(built.stats.components).toBe(2)
  })

  it('rasterises both components into one non-zero fill', () => {
    const calls: string[] = []
    const canvas: paper.HullCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: '',
        clearRect: () => calls.push('clearRect'),
        beginPath: () => calls.push('beginPath'),
        moveTo: () => calls.push('moveTo'),
        lineTo: () => calls.push('lineTo'),
        closePath: () => calls.push('closePath'),
        fill: () => calls.push('fill'),
      }),
    }
    paper.rasterizeHull(packed(hullFor(sneakers()).hull), FIELD, FIELD, canvas)
    expect(calls.filter((c) => c === 'moveTo')).toHaveLength(2)
    expect(calls.filter((c) => c === 'closePath')).toHaveLength(2)
    expect(calls.filter((c) => c === 'fill')).toHaveLength(1)
  })
})

describe("the hull cache's premise, and what amendment 10 detects", () => {
  it('is deterministic in the alpha channel, which is what lets the key stand in for it', () => {
    const a = packed(hullFor(garment()).hull)
    const b = packed(hullFor(garment()).hull)
    expect(Array.from(a.points)).toEqual(Array.from(b.points))
    expect(Array.from(a.offsets)).toEqual(Array.from(b.offsets))
  })

  it('gives a different polygon for different bytes under the same key', () => {
    const a = packed(hullFor(garment(50)).hull)
    const b = packed(hullFor(garment(46)).hull)
    expect(Array.from(a.points)).not.toEqual(Array.from(b.points))
  })

  it('serves the stale polygon until invalidate is called, and the right one after', () => {
    const cache = hullCache()
    const key = { spriteKey: 'shirt', sdfRes: FIELD, knobKey: 'minDist=22|maxDist=72' }
    const first = packed(hullFor(garment(50)).hull)
    const second = packed(hullFor(garment(46)).hull)

    cache.set(key, first)
    // A 304: unchanged bytes, and the rebuild proceeds as a rebuild off the cached polygon.
    expect(cache.get(key)).toBe(first)

    // A 200: the bytes moved under a key §8.5.1 promised would not move. Without this call the
    // new artwork would wear the previous sprite's torn edge.
    expect(cache.invalidate('shirt')).toBe(1)
    expect(cache.get(key)).toBeUndefined()
    cache.set(key, second)
    expect(cache.get(key)).toBe(second)
  })
})

describe('what the handle carries away', () => {
  it('is a few hundred bytes, and P5 model puts the whole handle under 4096', () => {
    const hull = packed(hullFor(garment()).hull)
    const vertices = hullVertexCount(hull)
    expect(vertices).toBeGreaterThanOrEqual(8)
    // P5's model is 408 + 8 x vertices and crosses 4096 at 461 vertices.
    expect(vertices).toBeLessThan(461)
    expect(hullBytes(hull)).toBe(vertices * 8 + 8)
    expect(400 + hullBytes(hull)).toBeLessThan(4096)
  })

  it('yields §8.3 rect through hullExtent and sheetRect rather than a readPixels', () => {
    const hull = packed(hullFor(garment()).hull)
    const extent = hullExtent(hull, FIELD, FIELD)
    expect(extent).toBeDefined()
    if (!extent) return
    // The hull sits between 4.2 and 13.8 texels outside a disc of radius 50 centred at 96.
    expect(extent.x0).toBeLessThan(96 - 50)
    expect(extent.x1).toBeGreaterThan(96 + 50)
    const rect = sheetRect(extent, FIELD, FIELD)
    expect(rect.w).toBeGreaterThanOrEqual(extent.x1 - extent.x0 + 1)
    expect(rect.h).toBeGreaterThanOrEqual(extent.y1 - extent.y0 + 1)
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.w).toBeLessThanOrEqual(FIELD)
  })
})

describe('the package barrel', () => {
  it('exports the CPU surface P10 consumes', () => {
    for (const name of [
      'computeSdf',
      'signedDistanceField',
      'cpuSdfFromAlpha',
      'extractContours',
      'simplifyLoop',
      'makeRandom',
      'packPolygons',
      'buildHull',
      'measureHull',
      'rasterizeHull',
      'hullCache',
      'alphaBbox',
      'sheetRect',
      'components',
      'holes',
    ]) {
      expect(name in paper).toBe(true)
    }
  })

  it('keeps the implementation details and the fixtures out of it', () => {
    for (const name of ['noise1d', 'discAlpha', 'annulusAlpha', 'unionAlpha', 'label']) {
      expect(name in paper).toBe(false)
    }
  })
})
