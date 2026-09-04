/**
 * The bench artwork — a head over two legs — as a pure function of size.
 *
 * **Test-only source**, on the same footing as `gl-fixture.ts`: reachable from neither `index.ts`
 * nor `tiles.ts`, so `tsdown` bundles none of it and it ships in no tarball. It lives here rather
 * than in `tools/bench/gl/harness.ts` because two readers need the same bytes: the GL bench, which
 * measures on it, and `gl-sdf.gl.test.ts`'s texel-selection oracle, whose "identical on the bench
 * artwork" is a statement about *this* artwork only if the two cannot drift apart. The bench
 * imports it by relative path (`tools/` is outside the workspace on purpose).
 */

/** Whether `(x, y)` — in pixel units of a `w x h` canvas — lies inside the silhouette. */
export function insideSilhouette(w: number, h: number, x: number, y: number): boolean {
  const cx = w / 2
  const cy = h * 0.36
  const r = Math.min(w, h) * 0.27
  if (Math.hypot(x - cx, y - cy) <= r) return true
  const legW = w * 0.15
  const top = cy
  const bottom = h * 0.93
  const l1 = cx - w * 0.22
  const l2 = cx + w * 0.07
  return y >= top && y <= bottom && ((x >= l1 && x <= l1 + legW) || (x >= l2 && x <= l2 + legW))
}

/** The silhouette as tightly packed `RGBA8UI` bytes with a colour gradient inside. */
export function silhouetteBytes(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      const inside = insideSilhouette(w, h, x + 0.5, y + 0.5)
      out[p] = (x * 255) / w
      out[p + 1] = (y * 255) / h
      out[p + 2] = 140
      out[p + 3] = inside ? 255 : 0
    }
  }
  return out
}
