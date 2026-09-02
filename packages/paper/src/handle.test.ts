import { describe, expect, it } from 'vitest'
import { KnobError, SheetError } from '@paper-crumple/core'
import { handleBytes } from '@paper-crumple/core/unstable'
import type { EdgeParams } from '@paper-crumple/core/unstable'
import { packPolygons } from './hull-shape.js'
import { checkReserve, freezeOverscan, handleFactsFor } from './handle.js'
import type { PaperSheetHandle } from './handle.js'

const hullDefaults: EdgeParams = {
  mode: 'hull',
  maxDist: 72,
  thickness: 0,
  looseness: 0,
  tearAmp: 0,
  midAmp: 0,
  fiberLen: 0,
}

/** ~40 vertices, which is what a 2 600 px perimeter yields at the default angularity (spec 8.5). */
function fortyVertexHull() {
  const loop: [number, number][] = []
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2
    loop.push([128 + 100 * Math.cos(t), 128 + 100 * Math.sin(t)])
  }
  return packPolygons([loop], 0, 1)
}

function handleAt(srcW: number, srcH: number): PaperSheetHandle {
  return {
    spriteKey: 'k',
    rect: { x: 10, y: 10, w: srcW - 20, h: srcH - 20 },
    frontRect: { x: 2, y: 2, w: 380, h: 380 },
    artwork: { w: 326, h: 326 },
    overscan: 0.09,
    sdfRes: 192,
    srcW,
    srcH,
    aspect: srcW / srcH,
    exact: false,
    edgeMode: 'hull',
    hull: fortyVertexHull(),
    alive: true,
    bytes: 0,
  }
}

describe('the handle holds no image data (spec 8.5, 11)', () => {
  // Spec 8.5 itemises "about 704 B for the ~40 vertices" and a ~1 712 B total, but that is not
  // reproducible from the shipped code: P8's `packPolygons` stores interleaved x, y in a
  // `Float32Array` at 8 B/vertex (not the spec's implied rate) plus a `Uint32Array` of component
  // offsets, so the 40-vertex single-loop fixture is 328 B and the whole handle is 728 B. The
  // code is authoritative over the spec's arithmetic; this is a regression pin on that figure.
  it('costs exactly 728 B and stays under 4 096', () => {
    const bytes = handleBytes(handleFactsFor(handleAt(998, 951)))
    expect(bytes).toBe(728)
    expect(bytes).toBeLessThan(4096)
  })

  it('is independent of source dimensions, which is what would have caught the 45 MB', () => {
    const small = handleBytes(handleFactsFor(handleAt(128, 128)))
    const huge = handleBytes(handleFactsFor(handleAt(4000, 4000)))
    expect(huge).toBe(small)
  })

  it('carries the packed polygon and nothing that scales with the artwork', () => {
    const facts = handleFactsFor(handleAt(998, 951))
    expect(facts.hull).toHaveLength(2)
    expect(facts.hull[0].byteLength).toBe(40 * 2 * 4)
  })
})

describe('freezeOverscan (spec 8.6)', () => {
  // §8.6's "Defaults: hull ~ 0.09" is reachable only from maxDist = 64 - exactly the input
  // core's own overscan.test.ts picks to reproduce that sentence. The spike ships
  // DEFAULT_PARAMS.maxDist = 72, so r = maxDist + slop = 72 + 12 = 84 and
  // p = r / (1000 - 2r) = 84 / 832 ~= 0.10096. This asserts the true derived default.
  it('derives the hull default at about 0.10', () => {
    const reserve = freezeOverscan(hullDefaults, 0)
    expect(KnobError.is(reserve)).toBe(false)
    if (KnobError.is(reserve)) return
    expect(reserve.overscan).toBeGreaterThan(0.08)
    expect(reserve.overscan).toBeLessThan(0.11)
  })

  it('adds headroom to the frozen radius rather than to the overscan', () => {
    const plain = freezeOverscan(hullDefaults, 0)
    const roomy = freezeOverscan(hullDefaults, 0.5)
    expect(KnobError.is(plain)).toBe(false)
    expect(KnobError.is(roomy)).toBe(false)
    if (KnobError.is(plain) || KnobError.is(roomy)) return
    expect(roomy.radius).toBeCloseTo(plain.radius * 1.5, 6)
    expect(roomy.overscan).toBeGreaterThan(plain.overscan)
  })

  it('returns a KnobError rather than NaN when the radius cannot fit the reference plane', () => {
    expect(KnobError.is(freezeOverscan({ ...hullDefaults, maxDist: 600 }, 0))).toBe(true)
  })
})

describe('checkReserve (spec 8.6)', () => {
  it('passes a knob that moves inside the reserve', () => {
    const reserve = freezeOverscan(hullDefaults, 0.5)
    expect(KnobError.is(reserve)).toBe(false)
    if (KnobError.is(reserve)) return
    expect(checkReserve(reserve, { ...hullDefaults, maxDist: 80 })).toBeUndefined()
  })

  it('names "re-add required" rather than clamping when a knob leaves it', () => {
    const reserve = freezeOverscan(hullDefaults, 0)
    expect(KnobError.is(reserve)).toBe(false)
    if (KnobError.is(reserve)) return
    const err = checkReserve(reserve, { ...hullDefaults, maxDist: 140 })
    expect(SheetError.is(err)).toBe(true)
    expect(err?.message).toContain('re-add required')
    expect(err?.message).toContain('overscanHeadroom')
  })
})
