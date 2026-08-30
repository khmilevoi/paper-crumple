/**
 * Synthetic alpha planes for the level-1 suites. Deliberately **not** exported from `index.ts`:
 * `tsdown` bundles from the barrel, so a module nothing re-exports never reaches a tarball.
 *
 * A disc is the right fixture for the hull because its distance field is analytic — the field reads
 * `r - d` everywhere — so a claim about where a vertex ended up is a claim about a radius.
 */

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
