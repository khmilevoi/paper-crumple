/**
 * Synthetic alpha planes for the level-1 suites. Deliberately **not** exported from `index.ts`:
 * `tsdown` bundles from the barrel, so a module nothing re-exports never reaches a tarball.
 *
 * A disc is the right fixture for the hull because its distance field is analytic — the field reads
 * `r - d` everywhere — so a claim about where a vertex ended up is a claim about a radius.
 */
import { makeRandom } from './random.js'

/** Anti-aliased disc coverage: 0.5 at exactly `r` from the centre. */
export function discAlpha(w: number, h: number, cx: number, cy: number, r: number): Float32Array {
  const a = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      a[y * w + x] = Math.min(1, Math.max(0, r + 0.5 - Math.hypot(x - cx, y - cy)))
    }
  }
  return a
}

/** A disc of radius `outer` with a concentric hole of radius `inner`. */
export function annulusAlpha(
  w: number,
  h: number,
  cx: number,
  cy: number,
  outer: number,
  inner: number,
): Float32Array {
  const a = discAlpha(w, h, cx, cy, outer)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const hole = Math.min(1, Math.max(0, inner + 0.5 - Math.hypot(x - cx, y - cy)))
      a[y * w + x] = Math.min(a[y * w + x], 1 - hole)
    }
  }
  return a
}

/** Per-texel maximum of two alphas: two islands in one plane. */
export function unionAlpha(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = Math.max(a[i], b[i])
  return out
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

function sdRoundedBox(px: number, py: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px) - hx + r
  const qy = Math.abs(py) - hy + r
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r
}

function sdCircle(px: number, py: number, r: number): number {
  return Math.sqrt(px * px + py * py) - r
}

/**
 * The CPU bench's `logoArtwork` silhouette (`tools/bench/cpu/artworks.mjs`), as alpha alone: a
 * wobbly rounded body with a ring welded onto its top edge, a detached disc, two round holes and a
 * slot, so a tracer sees several outer loops, inner loops and a long non-primitive boundary.
 * Ported rather than imported — the bench lives outside this package's `tsconfig` project.
 */
export function logoAlpha(size: number, seed = 7, inset = 0.12): Float32Array {
  const rand = makeRandom(seed)
  const span = 1 - 2 * inset
  const holeAx = 0.3 + (rand() - 0.5) * 0.04
  const holeAy = 0.5 + (rand() - 0.5) * 0.04
  const holeBx = 0.7 + (rand() - 0.5) * 0.04
  const holeBy = 0.5 + (rand() - 0.5) * 0.04
  const phase1 = rand() * Math.PI * 2
  const phase2 = rand() * Math.PI * 2
  const alpha = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size - inset) / span
      const v = ((y + 0.5) / size - inset) / span
      const cx = u - 0.5
      const cy = v - 0.5
      const angle = Math.atan2(cy, cx)
      const wobble = 0.012 * Math.sin(9 * angle + phase1) + 0.007 * Math.sin(17 * angle + phase2)
      let d = sdRoundedBox(cx, cy, 0.34, 0.24, 0.09) + wobble
      d = Math.min(d, Math.abs(sdCircle(cx, cy + 0.26, 0.15)) - 0.045)
      d = Math.min(d, sdCircle(cx - 0.36, cy - 0.36, 0.075))
      d = Math.max(d, -sdCircle(u - holeAx, v - holeAy, 0.055))
      d = Math.max(d, -sdCircle(u - holeBx, v - holeBy, 0.055))
      d = Math.max(d, -sdRoundedBox(cx, cy + 0.11, 0.17, 0.02, 0.015))
      alpha[y * size + x] = 1 - smoothstep(-0.75, 0.75, d * span * size)
    }
  }
  return alpha
}

/**
 * A true analytic signed distance field — exact Euclidean distance to the boundary of a union of
 * three discs, so 1-Lipschitz by construction — plus up to half a texel of seeded noise per texel.
 * That is the error budget the GPU jump flood carries (`gl-sdf.ts`), and it is the fixture the
 * contour row skip's one texel of slack exists for. Positive inside, like `signedDistanceField`.
 */
export function noisySdf(w: number, h: number, seed = 11): Float32Array {
  const rand = makeRandom(seed)
  const discs: readonly (readonly [number, number, number])[] = [
    [w * 0.4, h * 0.45, Math.min(w, h) * 0.28],
    [w * 0.68, h * 0.6, Math.min(w, h) * 0.18],
    [w * 0.3, h * 0.75, Math.min(w, h) * 0.12],
  ]
  const field = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity
      for (const [cx, cy, r] of discs) best = Math.min(best, Math.hypot(x - cx, y - cy) - r)
      field[y * w + x] = -best + (rand() - 0.5)
    }
  }
  return field
}
