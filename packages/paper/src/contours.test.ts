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
 * `extractContours`'s step 1 as it stood before the row skip (commit `93910ae`): one compare per
 * texel over the whole field, `CANDIDATE_BAND` read from the module binding each time, the four
 * cells walked by nested `dy`/`dx` loops, pushed into a `number[]`. Kept here, and only here, as
 * the INDEPENDENT oracle for the tests below.
 *
 * `contourCandidateCells(..., Infinity)` disables the row skip but still runs the shipped scan, so
 * the hoist, the unrolled stamp and the per-row index re-anchor would sit on both sides of an
 * equality against it and could not be caught. This copy shares no line with the shipped code, so
 * an equality against it pins all four changes at once — the same role `fillHullMaskAllEdges`
 * plays in `hull.test.ts`.
 */
function collectCandidatesAllTexels(
  field: ArrayLike<number>,
  w: number,
  h: number,
  iso: number,
  S: number,
  stamp: Uint8Array,
): number[] {
  const cells: number[] = []
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const v = field[i] - iso
      if (v > CANDIDATE_BAND || v < -CANDIDATE_BAND) continue
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
          const cx = x + dx
          const cy = y + dy
          const k = (cy + 1) * S + (cx + 1)
          if (stamp[k]) continue
          stamp[k] = 1
          cells.push(cx, cy)
        }
      }
    }
  }
  return cells
}

/** The same commit's whole tracer, on its own scratch so it cannot disturb the shipped slots. */
function extractContoursAllTexels(
  field: ArrayLike<number>,
  w: number,
  h: number,
  iso: number,
): Loop[] {
  const S = w + 2
  const edgeCount = 2 * S * (h + 2)
  const next = new Int32Array(edgeCount).fill(-1)
  const px = new Float32Array(edgeCount)
  const py = new Float32Array(edgeCount)
  const seen = new Uint8Array(edgeCount)
  const stamp = new Uint8Array(S * (h + 2))
  const F = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? -1e9 : field[y * w + x]
  const H = (x: number, y: number): number => 2 * ((y + 1) * S + (x + 1))
  const V = (x: number, y: number): number => 2 * ((y + 1) * S + (x + 1)) + 1

  const cells = collectCandidatesAllTexels(field, w, h, iso, S, stamp)

  const corner = new Float64Array(4)
  const edgeIds = new Int32Array(4)
  const exits: number[] = []
  for (let c = 0; c < cells.length; c += 2) {
    const x = cells[c]
    const y = cells[c + 1]
    stamp[(y + 1) * S + (x + 1)] = 0
    const v0 = F(x, y)
    const v1 = F(x + 1, y)
    const v2 = F(x + 1, y + 1)
    const v3 = F(x, y + 1)
    const b0 = v0 > iso
    const b1 = v1 > iso
    const b2 = v2 > iso
    const b3 = v3 > iso
    if (b0 === b1 && b1 === b2 && b2 === b3) continue
    corner[0] = v0
    corner[1] = v1
    corner[2] = v2
    corner[3] = v3
    edgeIds[0] = H(x, y)
    edgeIds[1] = V(x + 1, y)
    edgeIds[2] = H(x, y + 1)
    edgeIds[3] = V(x, y)
    for (let i = 0; i < 4; i++) {
      const a = corner[i]
      const b = corner[(i + 1) & 3]
      if (a > iso === b > iso) continue
      const t = Math.min(1, Math.max(0, (iso - a) / (b - a)))
      const id = edgeIds[i]
      if (i === 0) {
        px[id] = x + t
        py[id] = y
      } else if (i === 1) {
        px[id] = x + 1
        py[id] = y + t
      } else if (i === 2) {
        px[id] = x + 1 - t
        py[id] = y + 1
      } else {
        px[id] = x
        py[id] = y + 1 - t
      }
    }
    const saddle = (b0 && b2 && !b1 && !b3) || (b1 && b3 && !b0 && !b2)
    const centreInside = saddle && (v0 + v1 + v2 + v3) * 0.25 > iso
    for (let i = 0; i < 4; i++) {
      const a = corner[i] > iso
      const b = corner[(i + 1) & 3] > iso
      if (!(a && !b)) continue
      let j = -1
      if (saddle && !centreInside) {
        j = (i + 3) & 3
      } else {
        for (let k = 1; k < 4; k++) {
          const m = (i + k) & 3
          if (!(corner[m] > iso) && corner[(m + 1) & 3] > iso) {
            j = m
            break
          }
        }
      }
      if (j >= 0) {
        next[edgeIds[i]] = edgeIds[j]
        exits.push(edgeIds[i])
      }
    }
  }

  const loops: Loop[] = []
  for (const start of exits) {
    if (seen[start]) continue
    const loop: Loop = []
    let id = start
    while (id >= 0 && !seen[id]) {
      seen[id] = 1
      loop.push([px[id], py[id]])
      id = next[id]
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

/**
 * The step-1 row skip (perf package P4 / report C2). Its whole claim is that it changes nothing:
 * the candidate cells are the same cells in the same order, so the traced loops are the same loops.
 * Every case below is judged against `collectCandidatesAllTexels` / `extractContoursAllTexels`
 * above — the scan as it stood before this package, sharing no line with the shipped code — and
 * the assertions are equalities, not tolerances. `slack = Infinity` is checked against the same
 * oracle in the same tests, which is what separates the row skip from the three micro-changes that
 * came with it.
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
        name: 'a jump-flood-like field: a 1-Lipschitz field with ±0.5 texel of noise',
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
    it(`admits exactly the pre-skip scan's candidate cells on ${c.name}`, () => {
      const S = c.w + 2
      const oracle = collectCandidatesAllTexels(
        c.field,
        c.w,
        c.h,
        c.iso,
        S,
        new Uint8Array(S * (c.h + 2)),
      )
      expect(
        oracle.length,
        'the fixture must produce candidates, or the equality proves nothing',
      ).toBeGreaterThan(0)
      expect(contourCandidateCells(c.field, c.w, c.h, c.iso)).toEqual(oracle)
      // And the shipped scan with the skip disabled, which isolates the skip from the hoist,
      // the unrolled stamp and the per-row index re-anchor.
      expect(contourCandidateCells(c.field, c.w, c.h, c.iso, Infinity)).toEqual(oracle)
    })

    it(`traces exactly the pre-skip scan's loops on ${c.name}`, () => {
      const oracle = extractContoursAllTexels(c.field, c.w, c.h, c.iso)
      releaseContourScratch()
      expect(extractContours(c.field, c.w, c.h, c.iso)).toEqual(oracle)
      releaseContourScratch()
      expect(extractContoursWithSlack(c.field, c.w, c.h, c.iso, Infinity)).toEqual(oracle)
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
      collectCandidatesAllTexels(field, 32, 32, 0, 34, new Uint8Array(34 * 34)),
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
