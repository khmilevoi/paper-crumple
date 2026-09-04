import { beforeEach, describe, expect, it } from 'vitest'
import {
  CANDIDATE_BAND,
  CANDIDATE_ROW_SLACK,
  CONTOUR_SCRATCH_SLOTS,
  contourCandidateCells,
  contourScratchStats,
  extractContours,
  extractContoursWithSlack,
  releaseContourScratch,
  signedArea,
} from './contours.js'
import type { Loop } from './point.js'
import { signedDistanceField } from './sdf.js'
import { annulusAlpha, discAlpha, logoAlpha, noisySdf, unionAlpha } from './test-fixtures.js'

beforeEach(() => {
  releaseContourScratch()
})

describe('signedArea', () => {
  it('is positive for a counter-clockwise loop with y up', () => {
    const square: Loop = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    expect(signedArea(square)).toBeCloseTo(1, 10)
    expect(signedArea([...square].reverse())).toBeCloseTo(-1, 10)
  })
})

describe('extractContours', () => {
  it('traces one closed loop around a disc, at the iso the caller asks for', () => {
    const field = signedDistanceField(discAlpha(64, 64, 32, 32, 20), 64, 64)
    const loops = extractContours(field, 64, 64, -4)
    expect(loops).toHaveLength(1)
    expect(loops[0].length).toBeGreaterThan(20)
    // Every vertex sits on the iso, which for a disc means radius 24 within half a texel.
    for (const [x, y] of loops[0]) {
      expect(Math.abs(Math.hypot(x - 32, y - 32) - 24)).toBeLessThanOrEqual(0.5)
    }
  })

  it('orients outer loops positive and holes negative, which is how the caller tells them apart', () => {
    const field = signedDistanceField(annulusAlpha(64, 64, 32, 32, 24, 10), 64, 64)
    const loops = extractContours(field, 64, 64, 0)
    expect(loops).toHaveLength(2)
    const areas = loops.map(signedArea).sort((a, b) => b - a)
    expect(areas[0]).toBeGreaterThan(0)
    expect(areas[1]).toBeLessThan(0)
  })

  it('a border-touching silhouette is traced only near the band (KNOWN LIMITATION, see contours.ts)', () => {
    // A quarter-disc jammed into a corner: this demonstrates the band-limiting limitation.
    // The true area is ~380 (quarter-disc of radius 20), but the tracer yields 205.22 because
    // cells deeper than CANDIDATE_BAND from the iso are skipped, so the border run is only
    // traced near the band and the rest is missing — the emitted loop closes with a straight
    // chord across the gap. This assertion pins the current behaviour rather than describing
    // desired behaviour; see the limitation documented in contours.ts.
    const field = signedDistanceField(discAlpha(48, 48, 0, 0, 20), 48, 48)
    const loops = extractContours(field, 48, 48, -2)
    expect(loops).toHaveLength(1)
    expect(signedArea(loops[0])).toBeCloseTo(205.2, 0)
  })

  it('finds one loop per island, so a pair of sneakers gets two pieces of paper', () => {
    const both = unionAlpha(discAlpha(192, 96, 48, 48, 26), discAlpha(192, 96, 144, 48, 26))
    const field = signedDistanceField(both, 192, 96)
    expect(extractContours(field, 192, 96, -9)).toHaveLength(2)
  })

  it('restores its scratch, so a second call on the same field gives the same loops', () => {
    const field = signedDistanceField(discAlpha(64, 64, 32, 32, 20), 64, 64)
    expect(extractContours(field, 64, 64, -4)).toEqual(extractContours(field, 64, 64, -4))
  })

  it('band-limits the scan: cells further than CANDIDATE_BAND from the iso are never visited', () => {
    expect(CANDIDATE_BAND).toBe(2.0)
    // A field uniformly far from the iso yields nothing at all, at any size — the band admits
    // no cell. This mirrors the limitation documented in contours.ts: a uniformly-inside field
    // would close a border loop under -1e9 outside semantics, but band-limiting skips border
    // cells deeper than CANDIDATE_BAND from the iso, so no loop is emitted.
    const flat = new Float32Array(64 * 64).fill(50)
    expect(extractContours(flat, 64, 64, 0)).toEqual([])
  })

  it('a reused slot gives the same contours as a fresh one, so no trace leaks into the next', () => {
    const a = signedDistanceField(discAlpha(64, 64, 32, 32, 20), 64, 64)
    const b = signedDistanceField(annulusAlpha(64, 64, 32, 32, 24, 10), 64, 64)
    releaseContourScratch()
    const fresh = extractContours(b, 64, 64, 0)
    releaseContourScratch()
    extractContours(a, 64, 64, 0)
    const reused = extractContours(b, 64, 64, 0)
    expect(reused).toEqual(fresh)
  })
})

/**
 * The step-1 row skip (perf package P4 / report C2). Its whole claim is that it changes nothing:
 * the candidate cells are the same cells in the same order, so the traced loops are the same loops.
 * `slack = Infinity` runs the exhaustive scan the skip replaces, which is the reference every case
 * below is judged against — the assertions are equalities, not tolerances.
 */
describe('the Lipschitz row skip in the candidate scan', () => {
  /** Every fixture is a field the tracer is actually asked to run on, with the iso it runs at. */
  const cases: readonly { name: string; field: Float32Array; w: number; h: number; iso: number }[] =
    [
      {
        name: 'the analytic disc',
        field: signedDistanceField(discAlpha(64, 64, 32, 32, 20), 64, 64),
        w: 64,
        h: 64,
        iso: -4,
      },
      {
        name: 'the analytic annulus (an outer loop and a hole)',
        field: signedDistanceField(annulusAlpha(64, 64, 32, 32, 24, 10), 64, 64),
        w: 64,
        h: 64,
        iso: 0,
      },
      {
        name: 'two islands',
        field: signedDistanceField(
          unionAlpha(discAlpha(192, 96, 48, 48, 26), discAlpha(192, 96, 144, 48, 26)),
          192,
          96,
        ),
        w: 192,
        h: 96,
        iso: -9,
      },
      {
        name: 'a corner-jammed quarter-disc (the documented border limitation)',
        field: signedDistanceField(discAlpha(48, 48, 0, 0, 20), 48, 48),
        w: 48,
        h: 48,
        iso: -2,
      },
      {
        name: "a CPU-EDT field of the bench's synthetic logo",
        field: signedDistanceField(logoAlpha(128), 128, 128),
        w: 128,
        h: 128,
        iso: -6,
      },
      {
        name: 'a jump-flood-like field: a true SDF with ±0.5 texel of noise',
        field: noisySdf(128, 128),
        w: 128,
        h: 128,
        iso: -5,
      },
    ]

  it('keeps a slack of one texel, which is what the two field sources need', () => {
    expect(CANDIDATE_ROW_SLACK).toBe(1)
  })

  for (const c of cases) {
    it(`admits exactly the exhaustive scan's candidate cells on ${c.name}`, () => {
      const skipped = contourCandidateCells(c.field, c.w, c.h, c.iso)
      const full = contourCandidateCells(c.field, c.w, c.h, c.iso, Infinity)
      expect(
        full.length,
        'the fixture must produce candidates, or the equality proves nothing',
      ).toBeGreaterThan(0)
      expect(skipped).toEqual(full)
    })

    it(`traces exactly the exhaustive scan's loops on ${c.name}`, () => {
      releaseContourScratch()
      const skipped = extractContours(c.field, c.w, c.h, c.iso)
      releaseContourScratch()
      const full = extractContoursWithSlack(c.field, c.w, c.h, c.iso, Infinity)
      expect(skipped).toEqual(full)
    })
  }

  it('actually skips: the logo field is scanned in far fewer reads than it has texels', () => {
    // A `Proxy` over the field counts the reads the scan makes. The exhaustive scan reads every
    // texel once; the skip must read a small fraction of them, or it is not doing anything.
    const field = signedDistanceField(logoAlpha(128), 128, 128)
    let reads = 0
    const counted: ArrayLike<number> = new Proxy(field, {
      get(target, key) {
        if (typeof key === 'string' && key !== 'length') reads++
        return Reflect.get(target, key) as unknown
      },
    }) as unknown as ArrayLike<number>
    contourCandidateCells(counted, 128, 128, -6)
    expect(reads).toBeLessThan(128 * 128 * 0.5)
  })

  it('never skips on a field that hugs the band, so nothing is lost where it matters', () => {
    // Every texel within one unit of the iso: the skip can never fire, and the two scans must be
    // the same scan.
    const field = new Float32Array(32 * 32)
    for (let i = 0; i < field.length; i++) field[i] = ((i % 7) - 3) * 0.3
    expect(contourCandidateCells(field, 32, 32, 0)).toEqual(
      contourCandidateCells(field, 32, 32, 0, Infinity),
    )
  })
})

describe('the three-slot scratch cache (§8.2.1)', () => {
  const A = { w: 128, h: 192 }
  const B = { w: 192, h: 192 }
  const C = { w: 192, h: 128 }
  const D = { w: 96, h: 96 }

  function trace(size: { w: number; h: number }): void {
    const field = new Float32Array(size.w * size.h).fill(50)
    extractContours(field, size.w, size.h, 0)
  }

  it('holds three slots, because §8.6 fixes exactly three buckets', () => {
    expect(CONTOUR_SCRATCH_SLOTS).toBe(3)
  })

  it('allocates once per bucket across a mixed grid, not once per call', () => {
    for (let i = 0; i < 5; i++) {
      trace(A)
      trace(B)
      trace(C)
    }
    // A single slot keyed by dimensions would have allocated fifteen times: the measured 1.8x.
    expect(contourScratchStats()).toEqual({ slots: 3, allocations: 3 })
  })

  it('evicts the least recently used slot when a fourth size arrives', () => {
    trace(A)
    trace(B)
    trace(C)
    trace(D) // evicts A, the least recently used
    expect(contourScratchStats()).toEqual({ slots: 3, allocations: 4 })
    trace(B)
    trace(C)
    trace(D)
    expect(contourScratchStats().allocations).toBe(4)
    trace(A)
    expect(contourScratchStats()).toEqual({ slots: 3, allocations: 5 })
  })

  it('releases everything on demand, so a disposed stage keeps no scratch', () => {
    trace(A)
    trace(B)
    expect(contourScratchStats().slots).toBe(2)
    releaseContourScratch()
    expect(contourScratchStats()).toEqual({ slots: 0, allocations: 0 })
  })
})
