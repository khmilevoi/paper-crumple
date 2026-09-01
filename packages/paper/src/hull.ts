// Hull edge mode: the paper outline as a CPU-built polygon around the silhouette.
//
// The torn mode draws its outline by thresholding noise on a distance field, which is why its
// contour is a smooth wobble with fuzz on it. The reference cutout is not that: it is a sheet that
// wraps the garment at a clearly VARYING distance with straight-ish runs and sharp corners. That is
// a polygon, so this module builds one:
//
//   1. a Euclidean signed distance field of the artwork alpha, at the runtime field's resolution —
//      supplied by the caller, because §8.2.1 makes the GPU read-back the specified source and
//      `cpuSdfFromAlpha` the degraded fallback;
//   2. the iso-contour at the middle of the [minDist, maxDist] band (marching squares), keeping
//      only OUTER loops — a magazine cutout has no holes — but every one of them, so a pair of
//      sneakers gets two pieces of paper;
//   3. Douglas-Peucker simplification, with the tolerance driven by `angularity`;
//   4. each vertex slid along the field's gradient to its own random distance in the band;
//   5. a repair pass that guarantees paper ⊇ artwork + minDist: a chord across a convex bulge dips
//      inside the band, so every segment is sampled and a new vertex is inserted (pushed out into
//      the band) wherever a sample is too close. The result is still a polygon — straight segments,
//      sharp corners — never a rounded offset.
//
// Everything here works in FIELD TEXELS. The caller converts its reference-px knobs into texels and
// rasterizes the result into a mask at the field's resolution; the GPU jump flood then turns the
// mask into the signed field the shader samples, exactly as it does for the artwork itself.
//
// Pure functions. `rasterizeHull` takes a structural canvas rather than an `HTMLCanvasElement`, so
// the whole module is level 1: no GL, no DOM, no browser.
import { extractContours, signedArea } from './contours.js'
import { moveToDistance, sampleField } from './field.js'
import type { HullShape, PackedHull } from './hull-shape.js'
import { HULL_USE_ALPHA, packPolygons } from './hull-shape.js'
import type { Loop, Point } from './point.js'
import { makeRandom, noise1d } from './random.js'
import { simplifyLoop } from './simplify.js'

/**
 * Douglas-Peucker tolerance in reference px for angularity 0 and 1 — reference pixels, not texels.
 * Feeds `toleranceFor`, whose output is reference px too; a caller working in texels (as
 * `BuildHullOptions.tolerance` and `PackedHull.tolerance` do) must multiply by the downstream `k =
 * pxScale / texel` conversion before using either constant as a texel value.
 */
export const TOL_SMOOTH_PX = 1
export const TOL_ANGULAR_PX = 7

/**
 * Wavelength, in reference px, of the slow variation of the target distance along the contour —
 * reference pixels, not texels. `BuildHullOptions.wavelength` (default `60`) is in texels; a caller
 * deriving its wavelength from this constant must multiply by `k = pxScale / texel` first.
 */
export const DISTANCE_WAVELENGTH_PX = 170

/**
 * Douglas-Peucker tolerance, reference px, for an angularity in 0..1 — reference pixels, not texels.
 * `BuildHullOptions.tolerance` is texels; scale this by `k = pxScale / texel` before passing it in,
 * rather than relying on `buildHull`'s own `tolerance ?? toleranceFor(angularity)` fallback, which
 * resolves to reference px unconverted.
 */
export function toleranceFor(angularity: number): number {
  const a = Number.isFinite(angularity) ? Math.min(1, Math.max(0, angularity)) : 0
  return TOL_SMOOTH_PX + (TOL_ANGULAR_PX - TOL_SMOOTH_PX) * Math.pow(a, 1.5)
}

export interface BuildHullOptions {
  /** Signed distance, texels, positive inside. */
  readonly field: ArrayLike<number>
  readonly width: number
  readonly height: number
  /** Band, in texels. */
  readonly minDist: number
  /** Band, in texels. */
  readonly maxDist: number
  /** 0..1. */
  readonly angularity: number
  readonly seed: number
  /**
   * Douglas-Peucker tolerance, texels. Omitting it falls back to `toleranceFor(angularity)`, which
   * yields **reference pixels, not texels** — roughly 5x too large if read as a texel count. A
   * caller working in texels should pass `toleranceFor(angularity) * k` (where `k = pxScale /
   * texel`) rather than relying on the default.
   */
  readonly tolerance?: number
  /**
   * Texels; how slowly the target distance drifts along the contour. Default `60` is already texels.
   * `DISTANCE_WAVELENGTH_PX` (170) is the reference-px equivalent — multiply it by `k = pxScale /
   * texel` before using it here, do not pass it through unconverted.
   */
  readonly wavelength?: number
  /** Texels between the repair pass's samples. */
  readonly sampleStep?: number
  /** Cap on repair passes. */
  readonly maxPasses?: number
}

export interface HullStats {
  readonly components: number
  readonly dropped: number
  readonly rawVertices: number
  readonly vertices: number
  readonly inserted: number
  readonly passes: number
  /** Wall-clock milliseconds. Deliberately outside `HullShape`, so the shape stays comparable. */
  readonly ms: number
}

export interface HullBuild {
  readonly hull: HullShape
  readonly stats: HullStats
}

export function buildHull({
  field,
  width: w,
  height: h,
  minDist,
  maxDist,
  angularity,
  seed,
  tolerance,
  wavelength = 60,
  sampleStep = 2,
  maxPasses = 12,
}: BuildHullOptions): HullBuild {
  const t0 = performance.now()
  if (!(minDist > 0) && !(maxDist > 0)) {
    return {
      hull: HULL_USE_ALPHA,
      stats: {
        components: 0,
        dropped: 0,
        rawVertices: 0,
        vertices: 0,
        inserted: 0,
        passes: 0,
        ms: performance.now() - t0,
      },
    }
  }
  const lo = Math.max(0, Math.min(minDist, maxDist))
  const hi = Math.max(lo, maxDist)
  // Units seam: `tolerance` (when given) is texels, but the `toleranceFor` fallback is reference px
  // — an unconverted default here reads roughly 5x larger than an explicit texel tolerance would.
  const tol = tolerance ?? toleranceFor(angularity)
  const rand = makeRandom(seed)
  const seedInt = Math.floor(seed) | 0

  // 2. iso-contour at the middle of the band; outer loops only, but every one of them.
  const iso = -(lo + hi) * 0.5
  const loops = extractContours(field, w, h, iso)
  let dropped = 0
  const outer: Loop[] = []
  for (const loop of loops) {
    if (signedArea(loop) <= 2) {
      dropped++
      continue
    }
    outer.push(loop)
  }

  const polygons: Loop[] = []
  let inserted = 0
  let passes = 0
  let rawVertices = 0
  for (const loop of outer) {
    rawVertices += loop.length
    // 3. simplify.
    const simple = simplifyLoop(loop, tol)
    if (simple.length < 3) continue

    // 4. slide every vertex to its own distance in the band. The target drifts slowly along the
    //    contour (value noise over arc length) with a per-vertex jitter on top: pure per-vertex
    //    randomness is a sawtooth, while the reference's distance varies over a few segments.
    let arc = 0
    const phase = rand() * 1000
    const moved: Loop = []
    for (let i = 0; i < simple.length; i++) {
      if (i > 0) arc += Math.hypot(simple[i][0] - simple[i - 1][0], simple[i][1] - simple[i - 1][1])
      const slow = noise1d(arc / Math.max(wavelength, 1) + phase, seedInt)
      // Stretched past the noise's own 0..1 and clamped, so the ends of the band are actually
      // reached: an unstretched value noise spends its life in the middle third.
      const v = Math.min(1, Math.max(0, 0.5 + (slow - 0.5) * 1.8 + (rand() - 0.5) * 0.6))
      const target = lo + (hi - lo) * v
      moved.push(moveToDistance(field, w, h, simple[i], target))
    }

    // 5. repair: no chord may pass closer to the artwork than minDist. One vertex per offending
    //    segment per pass, at the worst sample, pushed out into the lower half of the band.
    let poly = moved
    const limit = -(lo - 0.25) // field reading at which a sample counts as too close
    for (let pass = 0; pass < maxPasses; pass++) {
      const next: Loop = []
      let any = false
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % poly.length]
        next.push(a)
        const len = Math.hypot(b[0] - a[0], b[1] - a[1])
        const n = Math.max(1, Math.ceil(len / sampleStep))
        let worst = -Infinity
        let worstAt: Point | null = null
        for (let k = 1; k < n; k++) {
          const t = k / n
          const qx = a[0] + (b[0] - a[0]) * t
          const qy = a[1] + (b[1] - a[1]) * t
          const s = sampleField(field, w, h, qx, qy)
          if (s > limit && s > worst) {
            worst = s
            worstAt = [qx, qy]
          }
        }
        if (worstAt) {
          const target = lo + (hi - lo) * 0.5 * rand()
          next.push(moveToDistance(field, w, h, worstAt, Math.max(target, lo + 0.05)))
          inserted++
          any = true
        }
      }
      poly = next
      passes = Math.max(passes, pass + 1)
      if (!any) break
    }
    polygons.push(poly)
  }

  const vertices = polygons.reduce((s, p) => s + p.length, 0)
  return {
    hull: packPolygons(polygons, iso, tol),
    stats: {
      components: polygons.length,
      dropped,
      rawVertices,
      vertices,
      inserted,
      passes,
      ms: performance.now() - t0,
    },
  }
}

export interface HullMeasure {
  readonly vertexMin: number
  readonly vertexMax: number
  readonly segmentMin: number
}

/**
 * Worst-case numbers for a built hull, in texels: the smallest and largest distance any vertex sits
 * at, and the smallest distance any point along any segment sits at.
 *
 * This is how §8.2.1's measurement harness validated itself — it reproduced the authored `[22, 72]`
 * band exactly — so it is a correctness assertion and not only a readout. The caller divides by its
 * own texel scale to report reference pixels.
 */
export function measureHull(
  field: ArrayLike<number>,
  w: number,
  h: number,
  hull: PackedHull,
  sampleStep = 2,
): HullMeasure {
  let vertexMin = Infinity
  let vertexMax = -Infinity
  let segmentMin = Infinity
  for (let c = 0; c + 1 < hull.offsets.length; c++) {
    const start = hull.offsets[c]
    const end = hull.offsets[c + 1]
    const count = end - start
    for (let i = 0; i < count; i++) {
      const ai = start + i
      const bi = start + ((i + 1) % count)
      const ax = hull.points[ai * 2]
      const ay = hull.points[ai * 2 + 1]
      const bx = hull.points[bi * 2]
      const by = hull.points[bi * 2 + 1]
      const d = -sampleField(field, w, h, ax, ay)
      if (d < vertexMin) vertexMin = d
      if (d > vertexMax) vertexMax = d
      const len = Math.hypot(bx - ax, by - ay)
      const n = Math.max(1, Math.ceil(len / sampleStep))
      for (let k = 0; k <= n; k++) {
        const t = k / n
        const s = -sampleField(field, w, h, ax + (bx - ax) * t, ay + (by - ay) * t)
        if (s < segmentMin) segmentMin = s
      }
    }
  }
  return { vertexMin, vertexMax, segmentMin }
}

/** The 2D calls `rasterizeHull` makes. `CanvasRenderingContext2D` satisfies this structurally. */
export interface HullRasterContext {
  fillStyle: string | CanvasGradient | CanvasPattern
  clearRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  fill(rule: 'nonzero'): void
}

/**
 * A drawing surface `rasterizeHull` can fill. `HTMLCanvasElement` and `OffscreenCanvas` both satisfy
 * it, and so does a recording stub — which is what keeps this function level 1.
 */
export interface HullCanvas {
  width: number
  height: number
  getContext(contextId: '2d'): HullRasterContext | null
}

/**
 * Fills the hull's components into a 2D canvas the size of the field. Texel-centre coordinates map
 * to canvas pixel centres, i.e. +0.5. Non-zero winding, so overlapping pieces union.
 *
 * Returns the canvas, or `undefined` when the surface could not give a 2D context — a canvas that
 * already carries a WebGL context, say. `undefined` and not an `Error`: this package returns no
 * `Error` at all (see the plan's global constraints), and the sheet renderer turns the absence into
 * the `SheetError` its `source()` contract owes.
 */
export function rasterizeHull(
  hull: PackedHull,
  w: number,
  h: number,
  canvas: HullCanvas,
): HullCanvas | undefined {
  canvas.width = w
  canvas.height = h
  const c2d = canvas.getContext('2d')
  if (!c2d) return undefined
  c2d.clearRect(0, 0, w, h)
  c2d.fillStyle = '#fff'
  c2d.beginPath()
  for (let c = 0; c + 1 < hull.offsets.length; c++) {
    const start = hull.offsets[c]
    const end = hull.offsets[c + 1]
    if (end - start < 3) continue
    c2d.moveTo(hull.points[start * 2] + 0.5, hull.points[start * 2 + 1] + 0.5)
    for (let v = start + 1; v < end; v++) {
      c2d.lineTo(hull.points[v * 2] + 0.5, hull.points[v * 2 + 1] + 0.5)
    }
    c2d.closePath()
  }
  c2d.fill('nonzero')
  return canvas
}
