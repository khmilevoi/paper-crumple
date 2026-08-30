import type { Point } from './point.js'
import { signedDistanceField } from './sdf.js'

/**
 * Signed field (texels, positive inside) from an alpha plane at the same resolution.
 *
 * **This is the degraded path, and the specification says so (§8.2.1).** The sheet renderer's
 * specified source for the CPU field is a read-back of pass A's output: measured at 0.40-0.90 ms
 * per sprite across a 32-sprite grid at `sdfRes` 192. This exact transform is the fallback the
 * spike's `engine.js:229-243` takes when the driver refuses the read-back, and the same work costs
 * 4.06-5.68 ms per sprite in Node — a projected 16-25 ms in Chrome, 1.6-2.5 s across 100 sprites,
 * which reopens every optimisation §8.2.1 deferred out of v1.
 *
 * **The Worker deferred in §8.2 is recorded as a mitigation for this branch specifically**, not as
 * scope removed outright; an approximate EDT is the cheaper alternative if the branch ever becomes
 * load-bearing. Neither is in v1. A caller that finds itself here is degraded, not normal.
 */
export function cpuSdfFromAlpha(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array {
  return signedDistanceField(alpha, width, height)
}

/** Bilinear sample at continuous texel-centre coordinates, clamped to the grid. */
export function sampleField(
  field: ArrayLike<number>,
  w: number,
  h: number,
  x: number,
  y: number,
): number {
  const cx = Math.min(Math.max(x, 0), w - 1)
  const cy = Math.min(Math.max(y, 0), h - 1)
  const x0 = Math.min(Math.floor(cx), w - 2)
  const y0 = Math.min(Math.floor(cy), h - 2)
  const fx = cx - x0
  const fy = cy - y0
  const i = y0 * w + x0
  const a = field[i]
  const b = field[i + 1]
  const c = field[i + w]
  const d = field[i + w + 1]
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
}

/** Central-difference gradient of the bilinear field. Points INWARD: the field grows inside. */
export function fieldGradient(
  field: ArrayLike<number>,
  w: number,
  h: number,
  x: number,
  y: number,
): Point {
  const e = 0.5
  return [
    (sampleField(field, w, h, x + e, y) - sampleField(field, w, h, x - e, y)) / (2 * e),
    (sampleField(field, w, h, x, y + e) - sampleField(field, w, h, x, y - e)) / (2 * e),
  ]
}

/**
 * Slides `p` along the field gradient until the field reads `-target` — i.e. `target` texels
 * OUTSIDE the silhouette.
 *
 * Newton with damping: an SDF has unit gradient almost everywhere, so three or four steps land
 * within a hundredth of a texel; on the medial axis of a narrow gap, where the wanted distance does
 * not exist, it stops at the best it can reach.
 */
export function moveToDistance(
  field: ArrayLike<number>,
  w: number,
  h: number,
  p: Point,
  target: number,
  maxIter = 20,
): Point {
  let x = p[0]
  let y = p[1]
  let s = sampleField(field, w, h, x, y)
  let scale = 1
  let lastAbs = Infinity
  for (let iter = 0; iter < maxIter; iter++) {
    const r = s + target
    const abs = Math.abs(r)
    if (abs < 0.02) break
    if (abs > lastAbs) scale *= 0.5 // overshot: damp
    lastAbs = abs
    const [gx, gy] = fieldGradient(field, w, h, x, y)
    const g2 = gx * gx + gy * gy
    if (g2 < 1e-8) break
    // Outward is -grad; r > 0 means still too far inside.
    const k = (r / g2) * scale
    x = Math.min(Math.max(x - gx * k, 0), w - 1)
    y = Math.min(Math.max(y - gy * k, 0), h - 1)
    s = sampleField(field, w, h, x, y)
  }
  return [x, y]
}
