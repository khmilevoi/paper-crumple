import { describe, expect, it } from 'vitest'
import { KnobError, SheetError } from './errors.js'
import type { EdgeParams } from './overscan.js'
import {
  artworkLongSide,
  checkGuardBand,
  EDGE_SLOP_REFERENCE_PX,
  exactFrontLongSide,
  GUARD_BAND_INNER,
  GUARD_EPSILON_REFERENCE_PX,
  GUARD_MARGIN_G,
  guardMarginsFor,
  KNOB_REFERENCE_PX,
  marginFractionFor,
  overscanFor,
  overscanFromRadius,
  overscanRadius,
  RADIUS_CAP_REFERENCE_PX,
} from './overscan.js'

/** design 2026-09-05 §4.1's single radius: `cleanParams` under finish `'clean'`. */
const cleanParams: EdgeParams = {
  widthRef: 47,
  variance: 0.53,
  fiberLen: 0,
  deckleWidth: 0,
}
/** Same width and variance, under finish `'paper'`. */
const paperParams: EdgeParams = { ...cleanParams, fiberLen: 4, deckleWidth: 7 }

const number = (v: InstanceType<typeof KnobError> | number): number => {
  expect(v).not.toBeInstanceOf(KnobError)
  return v as number
}

describe('the reference frame', () => {
  it('quotes every edge dimension against KNOB_REFERENCE_PX = 1000', () => {
    expect(KNOB_REFERENCE_PX).toBe(1000)
  })

  it('takes the conservative end of the 8-12 reference px slop band', () => {
    expect(EDGE_SLOP_REFERENCE_PX).toBe(12)
  })
})

describe('overscanFromRadius', () => {
  it('is p = r / (1000 - 2r)', () => {
    expect(number(overscanFromRadius(76))).toBeCloseTo(0.0896, 4)
    expect(number(overscanFromRadius(126.87))).toBeCloseTo(0.17, 4)
    expect(number(overscanFromRadius(171.05))).toBeCloseTo(0.26, 4)
  })

  it("inverts the spike's hard-coded PAD_FRACTION = 0.28 at 179.5 reference px", () => {
    expect(number(overscanFromRadius(179.5))).toBeCloseTo(0.28, 3)
  })

  it('returns a KnobError rather than a negative or infinite reserve', () => {
    expect(overscanFromRadius(500)).toBeInstanceOf(KnobError)
    expect(overscanFromRadius(600)).toBeInstanceOf(KnobError)
    expect(number(overscanFromRadius(0))).toBe(0)
  })
})

describe('overscanRadius (design 2026-09-05 §4.1)', () => {
  it('collapses the three branches to one radius', () => {
    expect(overscanRadius(cleanParams)).toBeCloseTo(47 * 1.53 + 12, 9)
    expect(overscanRadius(paperParams)).toBeCloseTo(47 * 1.53 + 4 * 4 + 7 + 12, 9)
  })

  it('is the slop alone at width 0', () => {
    expect(overscanRadius({ widthRef: 0, variance: 0.53, fiberLen: 0, deckleWidth: 0 })).toBe(12)
  })

  it('accepts a caller-supplied slop instead of the default', () => {
    expect(overscanRadius({ ...cleanParams, slop: 8 })).toBeCloseTo(47 * 1.53 + 8, 9)
  })

  it('composes with overscanFromRadius through overscanFor', () => {
    // Fix round 1: this compared overscanFor(cleanParams) against its own definition and could
    // never fail for a real reason. Pin the composition against the independently-computed
    // number too: R = 47*1.53+12 = 83.91, p = 83.91/(1000-2*83.91) ~= 0.10083.
    const composed = number(overscanFor(cleanParams))
    expect(composed).toBeCloseTo(number(overscanFromRadius(overscanRadius(cleanParams))), 12)
    expect(composed).toBeCloseTo(0.10083, 5)
  })
})

describe('artworkLongSide and exactFrontLongSide', () => {
  it('gives 8.5 A = 326 at maxSize 384 and p = 0.09', () => {
    expect(artworkLongSide(384, 0.09)).toBe(326)
  })

  it('recovers 64% of the long side at the deleted constant 0.28, which is what 8.6 refutes', () => {
    expect(artworkLongSide(384, 0.28)).toBe(Math.ceil(384 / 1.56))
    expect(artworkLongSide(384, 0.09)).toBeGreaterThan(artworkLongSide(384, 0.28))
  })

  it('sizes the exact front as ceil(source x (1 + 2p)), which is larger than the source', () => {
    expect(exactFrontLongSide(2000, 0.09)).toBe(2360)
    expect(exactFrontLongSide(998, 0.09)).toBe(1178)
  })
})

describe('checkGuardBand', () => {
  const frontSize = { w: 384, h: 384 }

  it('passes a hull that clears the band', () => {
    expect(checkGuardBand({ frontSize, hullExtent: { x: 40, y: 40, w: 304, h: 304 } })).toBe(
      undefined,
    )
  })

  it('passes a hull exactly on the band edge', () => {
    const inset = Math.round(384 * (0.5 - GUARD_BAND_INNER))
    expect(
      checkGuardBand({
        frontSize,
        hullExtent: { x: inset, y: inset, w: 384 - 2 * inset, h: 384 - 2 * inset },
      }),
    ).toBe(undefined)
  })

  it('returns a SheetError when the hull intrudes, rather than letting the shader slice it flat', () => {
    const err = checkGuardBand({ frontSize, hullExtent: { x: 2, y: 40, w: 380, h: 304 } })
    expect(err).toBeInstanceOf(SheetError)
    expect(err?.message).toMatch(/guard band/i)
    expect(err?.message).toMatch(/re-add/i)
  })

  it('names the axis that intrudes', () => {
    const onX = checkGuardBand({ frontSize, hullExtent: { x: 2, y: 40, w: 380, h: 304 } })
    const onY = checkGuardBand({ frontSize, hullExtent: { x: 40, y: 2, w: 304, h: 380 } })
    expect(onX?.message).toMatch(/\bx\b/)
    expect(onY?.message).toMatch(/\by\b/)
  })

  it('measures each axis against its own dimension on a non-square front', () => {
    // The band is the outer 1.8% of each dimension. A uniform 6-texel margin is 2.34% of 256 and
    // clears it, but only 1.56% of 384 and intrudes. Measuring both axes against one dimension
    // would miss that entirely.
    const tall = { w: 256, h: 384 }
    const err = checkGuardBand({ frontSize: tall, hullExtent: { x: 6, y: 6, w: 244, h: 372 } })
    expect(err).toBeInstanceOf(SheetError)
    expect(err?.message).toMatch(/\by\b/)
  })

  it('returns a SheetError for a degenerate front rather than dividing by zero', () => {
    expect(
      checkGuardBand({ frontSize: { w: 0, h: 384 }, hullExtent: { x: 0, y: 0, w: 1, h: 1 } }),
    ).toBeInstanceOf(SheetError)
  })
})

describe('the guard margin (design 2026-09-05 §4.2)', () => {
  it('derives g from the band itself', () => {
    expect(GUARD_MARGIN_G).toBeCloseTo(0.018, 12)
    expect(RADIUS_CAP_REFERENCE_PX).toBeCloseTo(482, 9)
  })

  it('refuses a radius at or past the 482 px cap, where the guard margin diverges', () => {
    expect(overscanFromRadius(RADIUS_CAP_REFERENCE_PX)).toBeInstanceOf(KnobError)
    expect(overscanFromRadius(RADIUS_CAP_REFERENCE_PX - 1)).not.toBeInstanceOf(KnobError)
  })

  // R14: the brief's own test named this "129 texels of total y margin" but its assertion
  // evaluates to 131 (129 is the epsilon = 0 value, 128.7164 before rounding). Named to state
  // both.
  it('reproduces the hull defaults: 128.72 before epsilon, 131 texels with epsilon = 2, of total y margin at A.h 790', () => {
    // The radius is the REDESIGN's, `W (1 + v) + e` at `W 47, v 0.53`, times the 0.25 headroom —
    // not `maxDist + e`, which is 105 and gives a different sixth digit.
    const p = number(overscanFromRadius(1.25 * (47 * 1.53 + 12)))
    expect(p).toBeCloseTo(0.132731, 6)
    expect(marginFractionFor(p)).toBeCloseTo(0.162932, 6)
    const eps = GUARD_EPSILON_REFERENCE_PX / KNOB_REFERENCE_PX
    const m = guardMarginsFor({ artwork: { w: 790, h: 790 }, overscan: p })
    expect(m.y).toBe(Math.ceil(790 * (0.162932 + eps)))
    expect(m.y).toBe(131)
    expect(m.x).toBe(m.y) // a square: the two axes coincide
  })

  it('needs a wider x margin than y on a landscape artwork', () => {
    const p = number(overscanFromRadius(1.25 * (47 * 1.53 + 12)))
    const m = guardMarginsFor({ artwork: { w: 2370, h: 790 }, overscan: p })
    expect(m.x).toBeGreaterThan(m.y)
    const g = GUARD_MARGIN_G
    const eps = GUARD_EPSILON_REFERENCE_PX / KNOB_REFERENCE_PX
    const q = 1 - 2 * g * (1 + 2 * p)
    expect(m.x).toBe(Math.ceil((g * 2370 + (790 * p) / q) / (1 - 2 * g) + 790 * eps))
  })

  it('keeps q <= GUARD_BAND_INNER on both axes for every aspect and reserve it is used with', () => {
    for (const R of [40, 84, 105, 150, 300]) {
      const p = number(overscanFromRadius(R))
      for (const [w, h] of [
        [790, 790],
        [2370, 790],
        [790, 3160],
        [531, 271],
        [433, 768],
      ]) {
        const m = guardMarginsFor({ artwork: { w, h }, overscan: p })
        const front = { w: w + 2 * m.x, h: h + 2 * m.y }
        const rho = (R * front.h) / KNOB_REFERENCE_PX
        const check = checkGuardBand({
          frontSize: front,
          hullExtent: { x: m.x - rho, y: m.y - rho, w: w + 2 * rho, h: h + 2 * rho },
        })
        expect(check, `R ${R} on ${w}x${h}: ${String(check?.message)}`).toBeUndefined()
      }
    }
  })

  // measurement, not a gate (R13): see the task report for the verdict line this produces.
  it('reports the slack the closed form leaves at epsilon 0 (design §11, item 4)', () => {
    const rows: string[] = []
    // R14: rho is computed from the true reserve radius R = 104.8875, not the rounded 105 the
    // brief's own snippet used — the rounded value pushes qx to 0.482073, over the line, for no
    // real reason.
    const R = 1.25 * (47 * 1.53 + 12)
    const p = number(overscanFromRadius(R))
    for (const [w, h] of [
      [790, 790],
      [2370, 790],
      [790, 3160],
    ]) {
      const g = GUARD_MARGIN_G
      const q = 1 - 2 * g * (1 + 2 * p)
      const my = Math.ceil(h * marginFractionFor(p))
      const mx = Math.ceil((g * w + (h * p) / q) / (1 - 2 * g))
      const front = { w: w + 2 * mx, h: h + 2 * my }
      const rho = (R * front.h) / KNOB_REFERENCE_PX
      rows.push(
        `${w}x${h}: qx=${((w + 2 * rho) / 2 / front.w).toFixed(6)} ` +
          `qy=${((h + 2 * rho) / 2 / front.h).toFixed(6)}`,
      )
    }
    // Recorded in the task report; the gate is the `q <= 0.482` case above, which runs at
    // epsilon 2. Verdict per controller ruling R1: epsilon frozen at 2 for the whole branch —
    // not revisited here despite every measured q clearing 0.482 at epsilon 0.
    expect(rows).toHaveLength(3)
  })
})
