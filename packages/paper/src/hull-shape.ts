import type { Loop } from './point.js'

/**
 * The hull polygon as §8.5 budgets it: one `Float32Array` of interleaved `x, y` for every component
 * concatenated, plus a `Uint32Array` of component start offsets **in vertices** with a sentinel at
 * the end, so `offsets.length === components + 1` and `offsets[0] === 0`.
 *
 * 8 bytes per vertex plus 4 per component boundary — 328 B for the ~40 vertices a 2 600 px
 * perimeter yields at the default `angularity`, and **independent of source dimensions**, which is
 * the property that would have caught the original design's 45 MB handle tier.
 *
 * Coordinates are field texels at texel centres, exactly as `extractContours` produced them.
 */
export interface PackedHull {
  readonly kind: 'polygons'
  readonly points: Float32Array
  readonly offsets: Uint32Array
  /** The iso value the contour was traced at, in texels. */
  readonly iso: number
  /** The Douglas-Peucker tolerance used, in texels. */
  readonly tolerance: number
}

/**
 * What `buildHull` returns when both distances are 0: use the artwork alpha itself as the sheet.
 * `paper.js:117` — "hull with minDist = maxDist = 0: the sheet IS the artwork alpha".
 */
export interface UseAlphaHull {
  readonly kind: 'use-alpha'
}

export type HullShape = PackedHull | UseAlphaHull

export const HULL_USE_ALPHA: UseAlphaHull = Object.freeze({ kind: 'use-alpha' as const })

/** Packs the tracer's loops into the layout above. An empty list packs to an empty hull. */
export function packPolygons(loops: readonly Loop[], iso: number, tolerance: number): PackedHull {
  let total = 0
  for (const loop of loops) total += loop.length
  const points = new Float32Array(total * 2)
  const offsets = new Uint32Array(loops.length + 1)
  let vertex = 0
  for (let c = 0; c < loops.length; c++) {
    offsets[c] = vertex
    const loop = loops[c]
    for (let i = 0; i < loop.length; i++, vertex++) {
      points[vertex * 2] = loop[i][0]
      points[vertex * 2 + 1] = loop[i][1]
    }
  }
  offsets[loops.length] = vertex
  return { kind: 'polygons', points, offsets, iso, tolerance }
}

/** How many separate pieces of paper this hull is. */
export function hullComponentCount(hull: HullShape): number {
  return hull.kind === 'use-alpha' ? 0 : hull.offsets.length - 1
}

export function hullVertexCount(hull: HullShape): number {
  return hull.kind === 'use-alpha' ? 0 : hull.offsets[hull.offsets.length - 1]
}

/** Materialises one component as a `Loop`. An index outside the hull gives an empty loop. */
export function hullComponent(hull: PackedHull, index: number): Loop {
  if (index < 0 || index >= hull.offsets.length - 1) return []
  const start = hull.offsets[index]
  const end = hull.offsets[index + 1]
  const loop: Loop = []
  for (let v = start; v < end; v++) loop.push([hull.points[v * 2], hull.points[v * 2 + 1]])
  return loop
}

/**
 * The buffers a `SheetHandle` retains, in the order the core's `handleBytes` counts them. Every
 * entry satisfies core's structural `CountedBuffer` (`{ readonly byteLength: number }`) without
 * this package importing it.
 */
export function hullBuffers(hull: HullShape): readonly (Float32Array | Uint32Array)[] {
  return hull.kind === 'use-alpha' ? [] : [hull.points, hull.offsets]
}

/** The hull's own byte length: what `hullBuffers` sums to. */
export function hullBytes(hull: HullShape): number {
  let total = 0
  for (const buffer of hullBuffers(hull)) total += buffer.byteLength
  return total
}

/**
 * §8.3's rect source: "min/max over the hull vertices plus a margin". Rounds **outward** — floor on
 * the minimum, ceil on the maximum — because a paper extent that rounds inward clips the paper, and
 * clamps to the grid. `undefined` when there is nothing to take a minimum over.
 *
 * The margin is `sheetRect`'s (`mask.ts`); the guard band reads `hullBounds` below, not this.
 */
export function hullExtent(
  hull: HullShape,
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } | undefined {
  const b = hullBounds(hull)
  if (b === undefined) return undefined
  return boundsExtent(b, w, h)
}

/** The exact min/max over a hull's vertices, in the texel-centre coordinates the vertices carry. */
export interface VertexBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/**
 * `hullExtent` before its rounding and clamping: the vertices' own min/max, continuous. The guard
 * band (spec 8.6) reads THIS rather than the extent, because a box rounded outward charges the
 * check for a texel the reserve never promised, and one clamped to the plane cannot say how far
 * past the plane's edge a sheet really reaches — it stops at exactly 0.5. `undefined` when there
 * is nothing to take a minimum over.
 */
export function hullBounds(hull: HullShape): VertexBounds | undefined {
  if (hull.kind === 'use-alpha') return undefined
  const n = hullVertexCount(hull)
  if (n === 0) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let v = 0; v < n; v++) {
    const x = hull.points[v * 2]
    const y = hull.points[v * 2 + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

/** `hullExtent`'s rounding — outward — and clamp, applied to bounds already taken. */
export function boundsExtent(
  b: VertexBounds,
  w: number,
  h: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.min(Math.max(Math.floor(b.minX), 0), w - 1),
    y0: Math.min(Math.max(Math.floor(b.minY), 0), h - 1),
    x1: Math.min(Math.max(Math.ceil(b.maxX), 0), w - 1),
    y1: Math.min(Math.max(Math.ceil(b.maxY), 0), h - 1),
  }
}
