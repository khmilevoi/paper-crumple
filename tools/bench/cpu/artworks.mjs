/**
 * Deterministic synthetic artworks — no image decoding, no DOM. Two kinds:
 *
 *   - `logoArtwork(size, o)`: a logo-like silhouette with a soft (anti-aliased, ~1.5 px) edge, a
 *     second detached piece, two round holes, a ring with a hole inside it and a slot — so the
 *     contour tracer sees inner loops, several outer loops and a long wobbly boundary. Built from
 *     analytic signed distances, so the alpha edge is genuinely fractional the way a resampled
 *     PNG's is. Seeded (`makeRandom`, paper's own mulberry32) for the hole positions and the
 *     boundary wobble.
 *   - `photoArtwork(size, seed)`: a fully opaque rectangle with seeded noise in RGB — the
 *     "photo" case where the silhouette is the whole frame and nothing is transparent.
 *
 * `inset` is the fraction of the frame left empty on every side, standing in for the front's
 * reserved margin around the artwork (spec 8.6): the hull band must fit inside the field.
 *
 * Replica: `logoArtwork`'s silhouette is ported into `packages/paper/src/test-fixtures.ts` as
 * `logoAlpha`, where `contours.test.ts` traces it — this package sits outside paper's `tsconfig`
 * project, so the tests cannot import it. Keep the two shapes in step, or the identity tests stop
 * covering the field the benchmark actually runs on.
 */
import { makeRandom } from '@paper-crumple/paper'

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

function sdRoundedBox(px, py, hx, hy, r) {
  const qx = Math.abs(px) - hx + r
  const qy = Math.abs(py) - hy + r
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r
}

function sdCircle(px, py, r) {
  return Math.sqrt(px * px + py * py) - r
}

export function logoArtwork(size, o = {}) {
  const seed = o.seed ?? 7
  const inset = o.inset ?? 0.12
  const rand = makeRandom(seed)
  const w = size
  const h = size
  const span = 1 - 2 * inset
  // Hole centres jitter a little per seed; the wobble phases too.
  const holeAx = 0.3 + (rand() - 0.5) * 0.04
  const holeAy = 0.5 + (rand() - 0.5) * 0.04
  const holeBx = 0.7 + (rand() - 0.5) * 0.04
  const holeBy = 0.5 + (rand() - 0.5) * 0.04
  const phase1 = rand() * Math.PI * 2
  const phase2 = rand() * Math.PI * 2
  const rgba = new Uint8ClampedArray(w * h * 4)
  const alpha01 = new Float32Array(w * h)
  const edgePx = 0.75
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Artwork-normalised coordinates: (0, 0)..(1, 1) is the inset box.
      const u = ((x + 0.5) / w - inset) / span
      const v = ((y + 0.5) / h - inset) / span
      const cx = u - 0.5
      const cy = v - 0.5
      // Boundary wobble along the angle: the contour is not a clean primitive.
      const angle = Math.atan2(cy, cx)
      const wobble = 0.012 * Math.sin(9 * angle + phase1) + 0.007 * Math.sin(17 * angle + phase2)
      let d = sdRoundedBox(cx, cy, 0.34, 0.24, 0.09) + wobble
      // A ring welded onto the body's top edge, with its own hole.
      const ring = Math.abs(sdCircle(cx, cy + 0.26, 0.15)) - 0.045
      d = Math.min(d, ring)
      // A detached second piece, bottom right.
      d = Math.min(d, sdCircle(cx - 0.36, cy - 0.36, 0.075))
      // Holes: two discs and a slot.
      d = Math.max(d, -sdCircle(u - holeAx, v - holeAy, 0.055))
      d = Math.max(d, -sdCircle(u - holeBx, v - holeBy, 0.055))
      d = Math.max(d, -sdRoundedBox(cx, cy + 0.11, 0.17, 0.02, 0.015))
      // Frame-normalised distance -> pixels; soft edge over ~1.5 px.
      const dPx = d * span * size
      const a = 1 - smoothstep(-edgePx, edgePx, dPx)
      const i = y * w + x
      alpha01[i] = a
      const p = i * 4
      rgba[p] = Math.round(40 + 200 * u)
      rgba[p + 1] = Math.round(30 + 180 * v)
      rgba[p + 2] = Math.round(120 + 100 * Math.sin(6 * u + 4 * v))
      rgba[p + 3] = Math.round(a * 255)
    }
  }
  return { width: w, height: h, rgba, alpha01, kind: 'logo', seed, inset }
}

export function photoArtwork(size, seed = 11) {
  const rand = makeRandom(seed)
  const w = size
  const h = size
  const rgba = new Uint8ClampedArray(w * h * 4)
  const alpha01 = new Float32Array(w * h).fill(1)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    rgba[p] = (rand() * 256) | 0
    rgba[p + 1] = (rand() * 256) | 0
    rgba[p + 2] = (rand() * 256) | 0
    rgba[p + 3] = 255
  }
  return { width: w, height: h, rgba, alpha01, kind: 'photo', seed, inset: 0 }
}

/** Box-filter an alpha plane down by an integer factor — a stand-in for the GPU resample. */
export function downsampleAlpha(alpha01, w, h, factor) {
  const dw = Math.floor(w / factor)
  const dh = Math.floor(h / factor)
  const out = new Float32Array(dw * dh)
  const norm = 1 / (factor * factor)
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let sum = 0
      for (let yy = 0; yy < factor; yy++) {
        const row = (y * factor + yy) * w + x * factor
        for (let xx = 0; xx < factor; xx++) sum += alpha01[row + xx]
      }
      out[y * dw + x] = sum * norm
    }
  }
  return { alpha01: out, width: dw, height: dh }
}
