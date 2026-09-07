import { describe, expect, it } from 'vitest'
import { hullBandFor } from './edge-derive.js'
import { cpuSdfFromAlpha } from './field.js'
import {
  buildHull,
  DISTANCE_WAVELENGTH_PX,
  fillHullMask,
  measureHull,
  rasterizeHull,
  toleranceFor,
  TOL_ANGULAR_PX,
  TOL_SMOOTH_PX,
} from './hull.js'
import type { HullCanvas, HullRasterContext } from './hull.js'
import { hullComponent, hullComponentCount, hullVertexCount, packPolygons } from './hull-shape.js'
import { makeRandom } from './random.js'
import { annulusAlpha, discAlpha, logoAlpha, unionAlpha } from './test-fixtures.js'

const W = 64
const H = 64

/** A disc of radius 16 at the centre of a 64x64 field. */
function discField(): Float32Array {
  return cpuSdfFromAlpha(discAlpha(W, H, 32, 32, 16), W, H)
}

const BAND = { minDist: 3, maxDist: 8 }

function build(o: Partial<{ seed: number; angularity: number; minDist: number; maxDist: number }>) {
  return buildHull({
    field: discField(),
    width: W,
    height: H,
    minDist: o.minDist ?? BAND.minDist,
    maxDist: o.maxDist ?? BAND.maxDist,
    angularity: o.angularity ?? 0.5,
    seed: o.seed ?? 3,
  })
}

/** A `HullCanvas` that records the 2D calls it is given instead of drawing them. */
function recorder(): { calls: string[]; ctx: HullRasterContext; canvas: HullCanvas } {
  const calls: string[] = []
  const ctx: HullRasterContext = {
    fillStyle: '',
    clearRect: (x, y, w, h) => calls.push(`clearRect(${x},${y},${w},${h})`),
    beginPath: () => calls.push('beginPath'),
    moveTo: (x, y) => calls.push(`moveTo(${x},${y})`),
    lineTo: (x, y) => calls.push(`lineTo(${x},${y})`),
    closePath: () => calls.push('closePath'),
    fill: (rule) => calls.push(`fill(${rule})`),
  }
  const canvas: HullCanvas = { width: 0, height: 0, getContext: () => ctx }
  return { calls, ctx, canvas }
}

describe('toleranceFor', () => {
  it('interpolates the two authored tolerances with a 1.5 power', () => {
    expect(TOL_SMOOTH_PX).toBe(1)
    expect(TOL_ANGULAR_PX).toBe(7)
    expect(DISTANCE_WAVELENGTH_PX).toBe(170)
    expect(toleranceFor(0)).toBeCloseTo(1, 10)
    expect(toleranceFor(1)).toBeCloseTo(7, 10)
    expect(toleranceFor(0.7)).toBeCloseTo(1 + 6 * Math.pow(0.7, 1.5), 10)
  })

  it('clamps out-of-range and non-finite angularity rather than propagating NaN', () => {
    expect(toleranceFor(-1)).toBeCloseTo(1, 10)
    expect(toleranceFor(5)).toBeCloseTo(7, 10)
    expect(toleranceFor(Number.NaN)).toBeCloseTo(1, 10)
  })
})

describe('buildHull', () => {
  it('uses the artwork alpha itself when both distances are zero', () => {
    const out = build({ minDist: 0, maxDist: 0 })
    expect(out.hull.kind).toBe('use-alpha')
    expect(out.stats.components).toBe(0)
  })

  it('builds one polygon around one island', () => {
    const out = build({})
    expect(out.hull.kind).toBe('polygons')
    expect(hullComponentCount(out.hull)).toBe(1)
    expect(hullVertexCount(out.hull)).toBeGreaterThanOrEqual(3)
    expect(out.stats.components).toBe(1)
    expect(out.stats.vertices).toBe(hullVertexCount(out.hull))
    expect(out.stats.rawVertices).toBeGreaterThan(out.stats.vertices)
    expect(out.stats.ms).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic in its inputs, which is what the hull cache stands in for', () => {
    const a = build({})
    const b = build({})
    expect(a.hull.kind).toBe('polygons')
    if (a.hull.kind !== 'polygons' || b.hull.kind !== 'polygons') return
    expect(Array.from(a.hull.points)).toEqual(Array.from(b.hull.points))
    expect(Array.from(a.hull.offsets)).toEqual(Array.from(b.hull.offsets))
    expect(a.hull.iso).toBe(b.hull.iso)
  })

  it('gives a different outline for a different seed', () => {
    const a = build({ seed: 3 })
    const b = build({ seed: 4 })
    if (a.hull.kind !== 'polygons' || b.hull.kind !== 'polygons') return
    expect(Array.from(a.hull.points)).not.toEqual(Array.from(b.hull.points))
  })

  it('traces at the middle of the band and records the tolerance it used', () => {
    const out = build({ angularity: 0.5 })
    if (out.hull.kind !== 'polygons') return
    expect(out.hull.iso).toBeCloseTo(-(3 + 8) / 2, 10)
    expect(out.hull.tolerance).toBeCloseTo(toleranceFor(0.5), 10)
  })

  it('honours an explicit tolerance over the one angularity would derive', () => {
    const out = buildHull({
      field: discField(),
      width: W,
      height: H,
      minDist: 3,
      maxDist: 8,
      angularity: 0.5,
      seed: 3,
      tolerance: 2.5,
    })
    if (out.hull.kind !== 'polygons') return
    expect(out.hull.tolerance).toBe(2.5)
  })

  it('drops a degenerate loop rather than emitting a two-vertex piece of paper', () => {
    // A field with no inside at all traces nothing, so nothing is packed and nothing is dropped.
    const empty = new Float32Array(W * H).fill(-50)
    const out = buildHull({
      field: empty,
      width: W,
      height: H,
      minDist: 3,
      maxDist: 8,
      angularity: 0.5,
      seed: 3,
    })
    expect(hullComponentCount(out.hull)).toBe(0)
  })

  it('drops the hole of an annulus, which the tracer sees as a negative-area loop', () => {
    // A ring far from the field border: the outer contour keeps its component, the inner
    // contour around the hole is a negative-area loop and is dropped before simplification.
    const width = 100
    const height = 100
    const field = cpuSdfFromAlpha(annulusAlpha(width, height, 50, 50, 35, 15), width, height)
    const out = buildHull({
      field,
      width,
      height,
      minDist: 3,
      maxDist: 8,
      angularity: 0.5,
      seed: 3,
    })
    expect(out.stats.dropped).toBeGreaterThanOrEqual(1)
    expect(hullComponentCount(out.hull)).toBeGreaterThanOrEqual(1)
  })
})

describe('measureHull', () => {
  it('keeps every vertex inside the band and no chord closer than minDist', () => {
    const field = discField()
    const out = buildHull({
      field,
      width: W,
      height: H,
      minDist: 3,
      maxDist: 8,
      angularity: 0.5,
      seed: 3,
    })
    if (out.hull.kind !== 'polygons') return
    const m = measureHull(field, W, H, out.hull)
    // moveToDistance stops within 0.02 texels of its target, so the band holds to 0.05.
    expect(m.vertexMin).toBeGreaterThanOrEqual(3 - 0.05)
    expect(m.vertexMax).toBeLessThanOrEqual(8 + 0.05)
    // The repair pass treats a sample as too close at `-(lo - 0.25)`, so 0.25 texels of slack.
    expect(m.segmentMin).toBeGreaterThanOrEqual(3 - 0.3)
  })
})

describe('rasterizeHull', () => {
  it('offsets texel centres to pixel centres and fills with non-zero winding', () => {
    const { calls, ctx, canvas } = recorder()
    const hull = packPolygons(
      [
        [
          [0, 0],
          [4, 0],
          [0, 3],
        ],
      ],
      0,
      1,
    )
    expect(rasterizeHull(hull, 8, 6, canvas)).toBe(canvas)
    expect(canvas.width).toBe(8)
    expect(canvas.height).toBe(6)
    expect(ctx.fillStyle).toBe('#fff')
    expect(calls).toEqual([
      'clearRect(0,0,8,6)',
      'beginPath',
      'moveTo(0.5,0.5)',
      'lineTo(4.5,0.5)',
      'lineTo(0.5,3.5)',
      'closePath',
      'fill(nonzero)',
    ])
  })

  it('unions every component into one path, so a pair of sneakers is one fill', () => {
    const { calls, canvas } = recorder()
    const hull = packPolygons(
      [
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
        [
          [5, 5],
          [6, 5],
          [5, 6],
        ],
      ],
      0,
      1,
    )
    rasterizeHull(hull, 8, 8, canvas)
    expect(calls.filter((c) => c === 'beginPath')).toHaveLength(1)
    expect(calls.filter((c) => c === 'closePath')).toHaveLength(2)
    expect(calls.filter((c) => c.startsWith('fill('))).toEqual(['fill(nonzero)'])
  })

  it('skips a component with fewer than three vertices', () => {
    const { calls, canvas } = recorder()
    const hull = packPolygons(
      [
        [
          [0, 0],
          [1, 0],
        ],
      ],
      0,
      1,
    )
    rasterizeHull(hull, 8, 8, canvas)
    expect(calls.filter((c) => c.startsWith('moveTo'))).toEqual([])
  })

  it('returns undefined when the canvas cannot give a 2D context, rather than throwing', () => {
    const canvas: HullCanvas = { width: 0, height: 0, getContext: () => null }
    const hull = packPolygons(
      [
        [
          [0, 0],
          [1, 0],
          [0, 1],
        ],
      ],
      0,
      1,
    )
    expect(rasterizeHull(hull, 8, 6, canvas)).toBeUndefined()
    // The size is still applied: the caller sees a canvas that was prepared and not drawn into.
    expect(canvas.width).toBe(8)
    expect(canvas.height).toBe(6)
  })

  it('reads back what it wrote, so hullComponent and the path agree', () => {
    const loop = hullComponent(
      packPolygons(
        [
          [
            [2, 3],
            [7, 3],
            [7, 9],
          ],
        ],
        0,
        1,
      ),
      0,
    )
    expect(loop).toEqual([
      [2, 3],
      [7, 3],
      [7, 9],
    ])
  })
})

describe('fillHullMask', () => {
  /** Alpha of one texel; the only channel the seed pass reads (`gl-sdf.ts:88`). */
  function alphaAt(bytes: Uint8Array, w: number, x: number, y: number): number {
    return bytes[(y * w + x) * 4 + 3]
  }

  function insideCount(bytes: Uint8Array): number {
    let n = 0
    for (let i = 3; i < bytes.length; i += 4) if (bytes[i] === 255) n++
    return n
  }

  /**
   * The independent oracle: the winding number about a texel centre, summed edge by edge, with no
   * scanline, no sorting and no span arithmetic in common with the implementation. Coordinates in
   * the fixture it judges are half-integers, so no edge ever passes through a texel centre and no
   * tie-break is exercised — a tie is a convention rather than a property, and the convention is
   * pinned by the square case below instead.
   */
  function windingAt(
    loops: readonly (readonly (readonly [number, number])[])[],
    x: number,
    y: number,
  ): number {
    let w = 0
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const [ax, ay] = loop[i]
        const [bx, by] = loop[(i + 1) % loop.length]
        const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay)
        if (ay <= y && by > y && side > 0) w++
        else if (by <= y && ay > y && side < 0) w--
      }
    }
    return w
  }

  it('fills a square exactly, at texel centres and with no half-texel offset', () => {
    const hull = packPolygons(
      [
        [
          [2, 2],
          [6, 2],
          [6, 6],
          [2, 6],
        ],
      ],
      0,
      1,
    )
    const bytes = fillHullMask(hull, 8, 8, 1, 1)
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    // Half-open on both axes: rows 2..5 and columns 2..5, never row or column 6.
    expect(insideCount(bytes)).toBe(16)
    expect(alphaAt(bytes, 8, 2, 2)).toBe(255)
    expect(alphaAt(bytes, 8, 5, 5)).toBe(255)
    expect(alphaAt(bytes, 8, 6, 5)).toBe(0)
    expect(alphaAt(bytes, 8, 5, 6)).toBe(0)
    // RGB is set so a debug readback is legible; only alpha is ever read in anger.
    expect(Array.from(bytes.subarray((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 4))).toEqual([
      255, 255, 255, 255,
    ])
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0, 0, 0, 0])
  })

  it('fills a triangle to within its own boundary band of the true area', () => {
    const hull = packPolygons(
      [
        [
          [0, 0],
          [64, 0],
          [0, 64],
        ],
      ],
      0,
      1,
    )
    const bytes = fillHullMask(hull, 128, 128, 1, 1)
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    // A centre-sampled fill can differ from the true area only by texels the boundary passes
    // through, which is bounded by half the perimeter — the honest reading of "within a texel".
    const trueArea = 0.5 * 64 * 64
    const perimeter = 64 + 64 + Math.hypot(64, 64)
    expect(Math.abs(insideCount(bytes) - trueArea)).toBeLessThanOrEqual(perimeter / 2)
  })

  it('unions two overlapping components rather than cancelling them (the non-zero rule)', () => {
    const hull = packPolygons(
      [
        [
          [0, 0],
          [4, 0],
          [4, 4],
          [0, 4],
        ],
        [
          [2, 2],
          [6, 2],
          [6, 6],
          [2, 6],
        ],
      ],
      0,
      1,
    )
    const bytes = fillHullMask(hull, 8, 8, 1, 1)
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    // 16 + 16 - 4 shared. Under an even-odd rule the shared 2x2 would read 0 — this is the
    // assertion that tells the two rules apart, and the reason two sheets of paper overlap
    // instead of punching a hole in each other.
    expect(insideCount(bytes)).toBe(28)
    expect(alphaAt(bytes, 8, 2, 2)).toBe(255)
    expect(alphaAt(bytes, 8, 3, 3)).toBe(255)
  })

  it('fills both lobes of a self-crossing figure-eight ring', () => {
    // One loop, crossing itself at (3,3): the case a triangulator gets wrong. Pinned even though
    // the spec's probe (864 hulls, 888 components, 0 proper self-intersections) says this input
    // does not arise in practice — it is the stated reason the non-zero fill was chosen over a
    // triangulator, and a reason that lives only in a comment is not defended.
    const hull = packPolygons(
      [
        [
          [0, 0],
          [0, 6],
          [6, 0],
          [6, 6],
        ],
      ],
      0,
      1,
    )
    const bytes = fillHullMask(hull, 8, 8, 1, 1)
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    // Left lobe and right lobe both carry winding +-1, so both fill.
    expect(alphaAt(bytes, 8, 1, 3)).toBe(255)
    expect(alphaAt(bytes, 8, 4, 3)).toBe(255)
    expect(insideCount(bytes)).toBeGreaterThan(8)
  })

  it('skips a degenerate component without corrupting its neighbours', () => {
    const hull = packPolygons(
      [
        // Two vertices: nothing to fill, and `offsets` still has to stay in step.
        [
          [0, 0],
          [1, 0],
        ],
        // Three vertices, all collinear: zero area.
        [
          [0, 7],
          [3, 7],
          [6, 7],
        ],
        [
          [2, 2],
          [6, 2],
          [6, 6],
          [2, 6],
        ],
      ],
      0,
      1,
    )
    const bytes = fillHullMask(hull, 8, 8, 1, 1)
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    expect(insideCount(bytes)).toBe(16)
    expect(alphaAt(bytes, 8, 0, 0)).toBe(0)
    expect(alphaAt(bytes, 8, 3, 7)).toBe(0)
  })

  it('returns undefined when no component is drawable, rather than an empty mask', () => {
    const nothing = packPolygons([], 0, 1)
    expect(fillHullMask(nothing, 8, 8, 1, 1)).toBeUndefined()
    const degenerate = packPolygons(
      [
        [
          [0, 0],
          [1, 0],
        ],
      ],
      0,
      1,
    )
    expect(fillHullMask(degenerate, 8, 8, 1, 1)).toBeUndefined()
  })

  it('agrees texel for texel with an independent winding-number reference, under scaling', () => {
    // A comb with three fingers and gaps narrower than the fingers: concave, two reflex corners
    // per finger. Every coordinate is a half-integer, so no edge passes through a texel centre
    // and the two implementations cannot disagree merely on a tie-break.
    // `Loop` is `Point[]` and `Point` is a mutable `[number, number]` (`point.ts:9-12`), so the
    // fixture is typed as the tracer's own type rather than as a readonly tuple array.
    const comb: [number, number][] = [
      [1.5, 1.5],
      [3.5, 1.5],
      [3.5, 8.5],
      [5.5, 8.5],
      [5.5, 1.5],
      [7.5, 1.5],
      [7.5, 8.5],
      [9.5, 8.5],
      [9.5, 1.5],
      [11.5, 1.5],
      [11.5, 10.5],
      [1.5, 10.5],
    ]
    const hull = packPolygons([comb], 0, 1)
    const sx = 2
    const sy = 1.5
    const w = 32
    const h = 24
    const bytes = fillHullMask(hull, w, h, sx, sy)
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    const scaled = comb.map(([x, y]) => [x * sx, y * sy] as const)
    const wrong: string[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const want = windingAt([scaled], x, y) !== 0 ? 255 : 0
        if (alphaAt(bytes, w, x, y) !== want) wrong.push(`(${x},${y}): want ${want}`)
      }
    }
    expect(wrong.slice(0, 8)).toEqual([])
  })

  // `build()` places the artwork 1:1 in a front of whatever size the bucket fit asked for, so a
  // hull traced in `source()`'s field lands in this build's field shifted as well as scaled: the
  // artwork's origin moved. A scale about the field's origin cannot express that shift.
  it('translates the polygon by tx/ty after scaling, so a moved artwork origin moves the mask with it', () => {
    const square: [number, number][] = [
      [1, 1],
      [5, 1],
      [5, 5],
      [1, 5],
    ]
    const hull = packPolygons([square], 0, 1)
    const w = 16
    const h = 16
    const bytes = fillHullMask(hull, w, h, 2, 1, 3, 4)
    expect(bytes).toBeDefined()
    if (bytes === undefined) return
    const moved = square.map(([x, y]) => [x * 2 + 3, y * 1 + 4] as const)
    const wrong: string[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const want = windingAt([moved], x, y) !== 0 ? 255 : 0
        if (alphaAt(bytes, w, x, y) !== want) wrong.push(`(${x},${y}): want ${want}`)
      }
    }
    expect(wrong.slice(0, 8)).toEqual([])
    // The unshifted span `[2, 10) x [1, 5)` is empty now: the mask moved rather than grew.
    expect(alphaAt(bytes, w, 4, 2)).toBe(0)
    expect(alphaAt(bytes, w, 6, 6)).toBe(255)
  })

  /**
   * `fillHullMask` as it stood before the active-edge list (perf package P4): every row tested
   * against every edge, in edge order. Kept here, and only here, as the identity oracle the
   * randomised case below judges the shipped fill against — the winding oracle above proves the
   * *rule*, this proves the rewrite did not change a single byte of it.
   */
  function fillHullMaskAllEdges(
    hull: ReturnType<typeof packPolygons>,
    w: number,
    h: number,
    sx: number,
    sy: number,
    tx = 0,
    ty = 0,
  ): Uint8Array | undefined {
    let edgeCount = 0
    for (let c = 0; c + 1 < hull.offsets.length; c++) {
      const count = hull.offsets[c + 1] - hull.offsets[c]
      if (count >= 3) edgeCount += count
    }
    if (edgeCount === 0) return undefined
    const edges = new Float64Array(edgeCount * 4)
    let yMin = Infinity
    let yMax = -Infinity
    let e = 0
    for (let c = 0; c + 1 < hull.offsets.length; c++) {
      const start = hull.offsets[c]
      const end = hull.offsets[c + 1]
      if (end - start < 3) continue
      for (let v = start; v < end; v++) {
        const u = v + 1 < end ? v + 1 : start
        const ay = hull.points[v * 2 + 1] * sy + ty
        edges[e++] = hull.points[v * 2] * sx + tx
        edges[e++] = ay
        edges[e++] = hull.points[u * 2] * sx + tx
        edges[e++] = hull.points[u * 2 + 1] * sy + ty
        if (ay < yMin) yMin = ay
        if (ay > yMax) yMax = ay
      }
    }
    const rowStart = Math.max(0, Math.ceil(yMin))
    const rowEnd = Math.min(h, Math.ceil(yMax))
    const bytes = new Uint8Array(w * h * 4)
    const xs = new Float64Array(edgeCount)
    const dirs = new Int8Array(edgeCount)
    let filled = false
    for (let y = rowStart; y < rowEnd; y++) {
      let n = 0
      for (let i = 0; i < edgeCount; i++) {
        const ax = edges[i * 4]
        const ay = edges[i * 4 + 1]
        const bx = edges[i * 4 + 2]
        const by = edges[i * 4 + 3]
        let dir: number
        if (ay <= y && y < by) dir = 1
        else if (by <= y && y < ay) dir = -1
        else continue
        const x = ax + ((y - ay) * (bx - ax)) / (by - ay)
        let k = n
        while (k > 0 && xs[k - 1] > x) {
          xs[k] = xs[k - 1]
          dirs[k] = dirs[k - 1]
          k--
        }
        xs[k] = x
        dirs[k] = dir
        n++
      }
      let winding = 0
      let spanStart = 0
      for (let k = 0; k < n; k++) {
        const was = winding
        winding += dirs[k]
        if (was === 0 && winding !== 0) {
          spanStart = xs[k]
        } else if (was !== 0 && winding === 0) {
          const xa = Math.max(0, Math.ceil(spanStart))
          const xb = Math.min(w, Math.ceil(xs[k]))
          if (xa < xb) {
            bytes.fill(255, (y * w + xa) * 4, (y * w + xb) * 4)
            filled = true
          }
        }
      }
    }
    return filled ? bytes : undefined
  }

  it('fills byte for byte what the all-edges scan filled, over 200 random multi-component hulls', () => {
    const rand = makeRandom(4242)
    const w = 48
    const h = 40
    let nonEmpty = 0
    for (let trial = 0; trial < 200; trial++) {
      const components: [number, number][][] = []
      const count = 1 + Math.floor(rand() * 3)
      for (let c = 0; c < count; c++) {
        // A star-shaped ring with a jittered radius: concave, self-touching between components,
        // and — deliberately — some vertices on integer coordinates, so ties in `x` and rows that
        // land exactly on a vertex are actually exercised rather than avoided.
        const cx = rand() * w
        const cy = rand() * h
        const vertices = 3 + Math.floor(rand() * 9)
        const loop: [number, number][] = []
        for (let v = 0; v < vertices; v++) {
          const a = (v / vertices) * Math.PI * 2 + rand() * 0.2
          const r = 2 + rand() * 14
          const quantise = rand() < 0.35
          const px = cx + Math.cos(a) * r
          const py = cy + Math.sin(a) * r
          loop.push(quantise ? [Math.round(px), Math.round(py)] : [px, py])
        }
        // Half the components run clockwise, so winding can cancel as well as accumulate.
        components.push(rand() < 0.5 ? loop.reverse() : loop)
      }
      const hull = packPolygons(components, 0, 1)
      const sx = 0.6 + rand() * 1.6
      const sy = 0.6 + rand() * 1.6
      const tx = (rand() - 0.5) * 10
      const ty = (rand() - 0.5) * 10
      const got = fillHullMask(hull, w, h, sx, sy, tx, ty)
      const want = fillHullMaskAllEdges(hull, w, h, sx, sy, tx, ty)
      if (want === undefined) {
        expect(got, `trial ${trial}: both must refuse the same hull`).toBeUndefined()
        continue
      }
      nonEmpty++
      expect(
        got,
        `trial ${trial}: the active-edge list must fill what the all-edges scan filled`,
      ).toBeDefined()
      if (got === undefined) continue
      // `toEqual` on a megabyte of bytes reports uselessly, so find the first difference itself.
      let diff = -1
      for (let i = 0; i < want.length; i++) {
        if (got[i] !== want[i]) {
          diff = i
          break
        }
      }
      expect(diff, `trial ${trial}: first differing byte`).toBe(-1)
    }
    expect(nonEmpty, 'most trials must actually fill something').toBeGreaterThan(150)
  })
})

describe('the §11 measurement — the vertex reach under smooth after the repair pass', () => {
  const FIELDS: readonly (readonly [string, Float32Array])[] = [
    ['disc', discField()],
    // outer 26 + the band's own maxDist (~8.99) reaches past this 64-frame's edge at 32±34.99 vs
    // the frame's 32-texel half-width — the only fixture here whose contour actually touches the
    // field boundary, which is why its numbers below (segmentMin 2.58, vertexMax 7.20) diverge
    // from its neighbours. Not a defect: flagged so it doesn't read as an arbitrary outlier later.
    ['annulus', cpuSdfFromAlpha(annulusAlpha(W, H, 32, 32, 26, 12), W, H)],
    ['logo', cpuSdfFromAlpha(logoAlpha(W), W, H)],
    [
      'twoLobes',
      cpuSdfFromAlpha(unionAlpha(discAlpha(W, H, 22, 32, 11), discAlpha(W, H, 44, 32, 11)), W, H),
    ],
  ]

  it('reports the vertex distances the repair pass leaves (design §11, item 3)', () => {
    // The vertexMin/vertexMax expects below (per field) are a real gate — R13 does not ask for
    // those to be softened. Only the `rows`/`toHaveLength` bookkeeping at the end of this block is
    // the measurement half: see the comment there, and task-3-report.md §11 for the verdict line.
    const rows: string[] = []
    for (const [name, field] of FIELDS) {
      // The band is in TEXELS here: this fixture is 64x64, so the reference-px band is scaled to
      // fit it rather than used raw — `hullBandFor(47, 0.53)` divided by 8 lands inside the frame.
      const band = hullBandFor(47 / 8, 0.53)
      const built = buildHull({
        field,
        width: W,
        height: H,
        minDist: band.minDist,
        maxDist: band.maxDist,
        angularity: 0.7,
        seed: 3,
      })
      // measureHull wants a PackedHull, not the raw buffer pair hullBuffers() returns for the
      // handle's byte accounting — narrow the same way `measureHull`'s own describe block does
      // above (line ~184). A nonzero band never yields 'use-alpha', so this never fires; `continue`
      // rather than throwing keeps the errors-as-values convention even in a test file.
      if (built.hull.kind !== 'polygons') {
        expect(built.hull.kind, `${name}: expected a polygon hull at this nonzero band`).toBe(
          'polygons',
        )
        continue
      }
      const m = measureHull(field, W, H, built.hull)
      rows.push(
        `${name}: vertexMin ${m.vertexMin.toFixed(2)} vertexMax ${m.vertexMax.toFixed(2)} ` +
          `segmentMin ${m.segmentMin.toFixed(2)} inserted ${built.stats.inserted}/${built.stats.vertices}`,
      )
      // The GATE, and the only claim design §5.1 makes about `smooth`: it is a VERTEX property.
      // `moveToDistance` stops at |residual| < 0.02 texels (`field.ts:87`), and `hull.test.ts`
      // already uses +-0.05 for exactly this reason. 1e-6 is not achievable.
      expect(m.vertexMin).toBeGreaterThanOrEqual(band.minDist - 0.05)
      expect(m.vertexMax).toBeLessThanOrEqual(band.maxDist + 0.05)
    }
    // measurement, not a gate: this asserts only that all four rows were collected, not anything
    // about their content — the real per-field bounds are the two `expect`s inside the loop above.
    expect(rows).toHaveLength(4)
  })
})
