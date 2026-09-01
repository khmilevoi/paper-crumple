import type { Loop } from './point.js'

/** Texels this far (in field units) from the iso value are candidates for a crossing cell. */
export const CANDIDATE_BAND = 2.0

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

/** Drops every slot and resets the counter. The sheet renderer calls this from `dispose()`. */
export function releaseContourScratch(): void {
  slots = []
  allocations = 0
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
 * scan into one tight pass over the field plus a few thousand real cells**, which is why §8.2's
 * proposed Moore-boundary rewrite buys close to nothing and is deferred out of v1.
 */
export function extractContours(
  field: ArrayLike<number>,
  w: number,
  h: number,
  iso: number,
): Loop[] {
  const { S, next, px, py, seen, stamp } = scratchFor(w, h)
  const F = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? -1e9 : field[y * w + x]
  // Edge ids on the (w+2)x(h+2) lattice that includes the virtual -inf border ring.
  const H = (x: number, y: number): number => 2 * ((y + 1) * S + (x + 1))
  const V = (x: number, y: number): number => 2 * ((y + 1) * S + (x + 1)) + 1

  // 1. candidate cells: the four cells around every texel near the iso, each once.
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

  // 2. segments per cell.
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
