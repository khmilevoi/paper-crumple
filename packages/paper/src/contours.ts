import type { Loop } from './point.js'

/** Texels this far (in field units) from the iso value are candidates for a crossing cell. */
export const CANDIDATE_BAND = 2.0

/**
 * Texels of slack the step-1 row skip keeps against a field that is not *exactly* 1-Lipschitz.
 *
 * The skip (`collectCandidates`) rests on one property of a distance field: along a row, the value
 * moves by at most one unit per texel, so a texel `away = |d − iso| − CANDIDATE_BAND` outside the
 * band has no candidate for the next `floor(away − slack)` texels. One texel of slack covers the
 * two ways this package's own fields depart from that bound, both of which are bounded by 1:
 *
 * - **The GPU jump flood** (`gl-sdf.ts`, the specified path) is a true SDF plus up to half a texel
 *   of error, so two texels of it can differ by `1 + 0.5 + 0.5 = 2` — one more than the bound.
 * - **The CPU EDT** (`sdf.ts`, the `cpuFieldFallback` branch) is exactly 1-Lipschitz outside its
 *   boundary layer, and inside it replaces the EDT value by a convex combination with `alpha − 0.5`
 *   — a shift of at most 1, and only where the *result* satisfies `|d| < 1.5`. Two shifted texels
 *   cannot both matter: a shifted texel is a candidate only when `|iso| < 3.5`, and then the skip
 *   never reaches a stride of 2 from a shifted texel in the first place.
 *
 * `Infinity` disables the skip: `floor(away − Infinity)` is never above 1. `extractContoursWithSlack`
 * takes it that way so `contours.test.ts` can compare against the exhaustive scan.
 */
export const CANDIDATE_ROW_SLACK = 1

/**
 * §8.2.1's one in-scope optimisation. The spike held its scratch in a **single** slot keyed by
 * dimensions, so a grid whose sprites are not all the same size reallocated on nearly every call —
 * measured at **1.8x** on a heterogeneous grid. §8.6 fixes exactly three front buckets
 * (256x384 / 384x384 / 384x256), so three slots are exactly sufficient and the 1.8x becomes 1.0x
 * for a few hundred bytes of bookkeeping.
 *
 * It is cheaper than anything §8.2 defers: a perfect tracer saves under 0.3 ms per sprite, a
 * coarser field has already been bought (512 -> 192 banked 6.6-7.1x), and a Worker cannot be
 * justified against 0.4-0.9 ms of main-thread work.
 */
export const CONTOUR_SCRATCH_SLOTS = 3

interface ContourScratch {
  readonly w: number
  readonly h: number
  readonly S: number
  readonly next: Int32Array
  readonly px: Float32Array
  readonly py: Float32Array
  readonly seen: Uint8Array
  readonly stamp: Uint8Array
}

/**
 * Most recently used first. The edge tables are half a million entries at 512 and allocating them
 * per slider move is most of what a rebuild would otherwise cost.
 */
let slots: ContourScratch[] = []
let allocations = 0

function scratchFor(w: number, h: number): ContourScratch {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    if (slot.w !== w || slot.h !== h) continue
    if (i > 0) {
      slots.splice(i, 1)
      slots.unshift(slot)
    }
    return slot
  }
  const S = w + 2
  const edgeCount = 2 * S * (h + 2)
  const fresh: ContourScratch = {
    w,
    h,
    S,
    next: new Int32Array(edgeCount).fill(-1),
    px: new Float32Array(edgeCount),
    py: new Float32Array(edgeCount),
    seen: new Uint8Array(edgeCount),
    stamp: new Uint8Array(S * (h + 2)),
  }
  allocations++
  slots.unshift(fresh)
  if (slots.length > CONTOUR_SCRATCH_SLOTS) slots.length = CONTOUR_SCRATCH_SLOTS
  return fresh
}

/** How many slots are live, and how many allocations have happened since the last release. */
export function contourScratchStats(): { slots: number; allocations: number } {
  return { slots: slots.length, allocations }
}

/**
 * The candidate cells of the call in flight, as `cx, cy` pairs — one shared, geometrically grown
 * buffer rather than the `number[]` the scan used to `push` into (a few thousand pairs per trace,
 * so half a megabyte of garbage per hull at 512²). Not per slot: the tracer is synchronous and
 * never re-entered, so one buffer serves every field size.
 */
let cellBuf = new Int32Array(4096)

/** Drops every slot and resets the counter. The sheet renderer calls this from `dispose()`. */
export function releaseContourScratch(): void {
  slots = []
  allocations = 0
  cellBuf = new Int32Array(4096)
}

/**
 * Closed iso-contours of `field` at `iso`, as arrays of `[x, y]` in texel-centre coordinates.
 *
 * Each cell's segments are oriented so the inside (field > iso) is on the LEFT when walking them
 * with y up, which makes outer loops come out with a positive shoelace area and holes with a
 * negative one — that is how the caller tells them apart. The grid is treated as -1e9 outside its
 * border, which allows an edge-touching silhouette to produce a crossing at all.
 *
 * **LIMITATION:** Because the candidate scan admits a cell only when a real corner lies within
 * `CANDIDATE_BAND` of `iso`, a silhouette running along the border deeper than that band is traced
 * only near the band; the remainder of the border run is missing and the emitted loop closes with
 * a straight chord across the gap. Measured: a quarter-disc of radius 20 jammed into a corner of a
 * 48×48 field at iso -2 yields area 205.22 where the true figure is ~380, and the same disc in the
 * opposite corner shatters into four fragments.
 *
 * **A consequence:** The traversal stops on `next[id] === -1` and emits the path whenever it has
 * three or more vertices, without checking that it returned to its start — so an unclosed path is
 * emitted as a closed loop with the missing span replaced by a straight chord.
 *
 * This limitation is inherent to band-limiting as specified: along the perimeter, a corner-jammed
 * disc and a fully-filled field are indistinguishable, so closing the border properly and
 * returning `[]` for a uniformly-inside field are mutually exclusive.
 *
 * Only cells next to a texel within `CANDIDATE_BAND` of the iso value are visited. A distance field
 * has unit gradient, so a cell whose corners straddle the iso has a corner within ~0.7 of it; the
 * band is generous against the half-texel error of the GPU jump flood. **That turns a 250 k-cell
 * scan into a pass over the field plus a few thousand real cells**, which is why §8.2's proposed
 * Moore-boundary rewrite buys close to nothing and is deferred out of v1. The same unit gradient
 * then shortens the pass itself: `collectCandidates` jumps a texel far outside the band forward by
 * the distance no candidate can lie within, so most of the field is never read at all.
 */
export function extractContours(
  field: ArrayLike<number>,
  w: number,
  h: number,
  iso: number,
): Loop[] {
  return extractContoursWithSlack(field, w, h, iso, CANDIDATE_ROW_SLACK)
}

/**
 * Step 1 of `extractContours`: the four cells around every texel within `CANDIDATE_BAND` of `iso`,
 * each stamped once, written into `cellBuf` as `cx, cy` pairs. Returns how many numbers were
 * written; the caller must clear every stamp it set (step 2 does, cell by cell).
 *
 * **The row skip.** The band test itself is unchanged — `field[i] - iso` against `±CANDIDATE_BAND`,
 * the same subtraction in the same order, so the same texels qualify to the last bit. What changed
 * is what happens on a texel that does *not* qualify: instead of stepping one texel, the scan
 * steps `floor(away - slack)` where `away = |field[i] - iso| - CANDIDATE_BAND` is how far outside
 * the band the texel sits. A distance field moves by at most one unit per texel along a row, so no
 * texel closer than that can be inside the band; `slack` (see `CANDIDATE_ROW_SLACK`) pays for the
 * ways this package's fields depart from that bound. The cell list is therefore identical to the
 * exhaustive scan's, which `contours.test.ts` pins on the analytic fixtures, a CPU-EDT field of a
 * logo-shaped silhouette and a jump-flood-like field carrying ±0.5 texel of noise.
 */
function collectCandidates(
  field: ArrayLike<number>,
  w: number,
  h: number,
  iso: number,
  S: number,
  stamp: Uint8Array,
  slack: number,
): number {
  // Hoisted out of the loop: `CANDIDATE_BAND` is a module binding, and V8 reloads it per compare.
  const band = CANDIDATE_BAND
  const negBand = -CANDIDATE_BAND
  let n = 0
  for (let y = 0; y < h; y++) {
    // Re-anchored per row rather than carried across the whole field: a skip can leave `x` past
    // `w`, and a running index would then start the next row that far in.
    const row = y * w
    for (let x = 0; x < w; x++) {
      const v = field[row + x] - iso
      if (v > band || v < negBand) {
        const away = v > band ? v - band : negBand - v
        const stride = Math.floor(away - slack)
        if (stride > 1) x += stride - 1
        continue
      }
      // The four cells around this texel, in the order the nested `dy`/`dx` loops walked them:
      // (x-1, y-1), (x, y-1), (x-1, y), (x, y). Unrolled — on a scan this short every in-band texel
      // is now a measurable share of the pass, and `k` walks by 1 and by `S` between the four.
      if (n + 8 > cellBuf.length) {
        const grown = new Int32Array(cellBuf.length * 2)
        grown.set(cellBuf)
        cellBuf = grown
      }
      const k0 = y * S + x
      if (stamp[k0] === 0) {
        stamp[k0] = 1
        cellBuf[n++] = x - 1
        cellBuf[n++] = y - 1
      }
      if (stamp[k0 + 1] === 0) {
        stamp[k0 + 1] = 1
        cellBuf[n++] = x
        cellBuf[n++] = y - 1
      }
      if (stamp[k0 + S] === 0) {
        stamp[k0 + S] = 1
        cellBuf[n++] = x - 1
        cellBuf[n++] = y
      }
      if (stamp[k0 + S + 1] === 0) {
        stamp[k0 + S + 1] = 1
        cellBuf[n++] = x
        cellBuf[n++] = y
      }
    }
  }
  return n
}

/**
 * `extractContours` with the row skip's slack made explicit. Not part of the package's public
 * surface (`index.ts` exports `extractContours` alone): it exists so `contours.test.ts` can run the
 * exhaustive scan — `slack = Infinity` — and prove the skip changes neither the candidate cells nor
 * the loops they trace.
 */
export function extractContoursWithSlack(
  field: ArrayLike<number>,
  w: number,
  h: number,
  iso: number,
  slack: number,
): Loop[] {
  const { S, next, px, py, seen, stamp } = scratchFor(w, h)
  const F = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? -1e9 : field[y * w + x]
  // Edge ids on the (w+2)x(h+2) lattice that includes the virtual -inf border ring.
  const H = (x: number, y: number): number => 2 * ((y + 1) * S + (x + 1))
  const V = (x: number, y: number): number => 2 * ((y + 1) * S + (x + 1)) + 1

  // 1. candidate cells: the four cells around every texel near the iso, each once.
  const cellCount = collectCandidates(field, w, h, iso, S, stamp, slack)
  const cells = cellBuf

  // 2. segments per cell.
  const corner = new Float64Array(4)
  const edgeIds = new Int32Array(4)
  const exits: number[] = []
  for (let c = 0; c < cellCount; c += 2) {
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
    // Crossing positions, walking the corners counter-clockwise (y up).
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
      if (!(a && !b)) continue // not an exit crossing
      // Pair the exit with the next entry counter-clockwise — or, on a saddle whose centre is
      // outside, with the previous one, which separates the two inside corners.
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

  // 3. link the segments into loops, then put the scratch back the way it was found.
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
  for (const id of exits) {
    next[id] = -1
    seen[id] = 0
  }
  return loops
}

/**
 * The candidate cells step 1 admits, as a flat `cx, cy` list in scan order. Not part of the
 * package's public surface: like `extractContoursWithSlack` it exists for `contours.test.ts`, which
 * compares the row-skipping scan's list against the exhaustive one's cell for cell — a sharper
 * failure than comparing the traced loops, because the loops are a function of this list alone.
 *
 * Runs on its own stamp buffer rather than the shared scratch, so calling it neither evicts a slot
 * nor moves `contourScratchStats()`.
 */
export function contourCandidateCells(
  field: ArrayLike<number>,
  w: number,
  h: number,
  iso: number,
  slack: number = CANDIDATE_ROW_SLACK,
): number[] {
  const S = w + 2
  const n = collectCandidates(field, w, h, iso, S, new Uint8Array(S * (h + 2)), slack)
  return Array.from(cellBuf.subarray(0, n))
}

/** Shoelace area; positive for counter-clockwise loops (y up). */
export function signedArea(loop: Loop): number {
  let a = 0
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i]
    const q = loop[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a * 0.5
}
