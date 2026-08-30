/**
 * Signed distance field generation from an alpha channel.
 *
 * Moved in whole from the spike's `tools/sdf.mjs` (spec 3.3): `hull.js` imported it from outside
 * `src/`, so it becomes part of this package rather than being dropped with the page glue.
 *
 * Dependency-free: pure typed-array math, no image I/O.
 *
 * Pipeline
 * --------
 *   alpha (0..1, full source resolution)
 *     -> hard threshold at 0.5
 *     -> two exact Euclidean distance transforms (Felzenszwalb & Huttenlocher, O(n))
 *     -> combine into a signed field, positive inside, in SOURCE pixels
 *     -> sub-pixel refinement from the anti-aliased alpha near the boundary
 *     -> area (box) downsample to the target map size, values stay in SOURCE pixels
 *     -> quantise to 8-bit with 128 == the alpha 0.5 crossing
 *
 * Encoding contract
 * -----------------
 *   value 128            == exactly on the silhouette edge
 *   value > 128          == inside
 *   value < 128          == outside
 *   distance_px          == (value - 128) / 127 * rangePx      (source pixels)
 *   distances beyond +/- rangePx are clamped, so 1 and 255 are the extremes and 0 is never emitted.
 */

/** Sentinel "unreachable" squared distance for the transform seeds. */
export const SDF_INF = 1e20

/**
 * Felzenszwalb & Huttenlocher 1D squared distance transform (lower envelope of parabolas), O(n).
 * Reads `n` costs from `f` and writes `n` squared distances to `d`. `v` and `z` are scratch of
 * length `n` and `n + 1`.
 *
 * Scratch is Float64 on purpose: the parabola intersection abscissa is a difference of large
 * numbers and float32 loses it. The field itself stays Float32Array as the caller sees it.
 */
export function edt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
  let k = 0
  v[0] = 0
  z[0] = -SDF_INF
  z[1] = SDF_INF

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = SDF_INF
  }

  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
}

/**
 * Exact 2D squared Euclidean distance transform, in place.
 *
 * `grid` holds `width * height` costs: 0 at seed pixels, `SDF_INF` elsewhere. Returns the same
 * array, now holding squared distances to the nearest seed pixel, in pixels squared.
 */
export function squaredEdt(grid: Float32Array, width: number, height: number): Float32Array {
  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)

  // columns
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x]
    edt1d(f, d, v, z, height)
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y]
  }

  // rows
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) f[x] = grid[row + x]
    edt1d(f, d, v, z, width)
    for (let x = 0; x < width; x++) grid[row + x] = d[x]
  }

  return grid
}

/**
 * Signed distance field from an alpha channel, at the alpha's own resolution. Positive inside the
 * silhouette, negative outside, zero on the alpha 0.5 crossing.
 *
 * `inside = alpha >= 0.5`. One transform seeded on the inside pixels gives dIn (non-zero only
 * outside), one seeded on the outside pixels gives dOut (non-zero only inside). Exactly one of the
 * two is non-zero per pixel, so the unsigned distance to the nearest opposite-class PIXEL CENTRE is
 * `dIn + dOut`. The real edge sits half a pixel before that centre, hence the -0.5: a solid pixel
 * touching the boundary gets +0.5, an empty one -0.5. That offset runs along the ray to the nearest
 * pixel centre rather than along the surface normal, so it is exact facing a straight edge and
 * biased outward by at most 0.5 * (sqrt(2) - 1) ~= 0.21 px diagonally off a corner.
 *
 * Sub-pixel refinement: where alpha is fractional the pixel is cut by the edge, and for a straight
 * edge crossing a unit pixel the coverage maps to the signed distance from the centre as
 * `alpha - 0.5`. That estimate replaces the quantised +/-0.5 in the boundary layer and is faded out
 * over the next pixel so the field stays continuous; further than 1.5 px from the edge the field is
 * pure EDT.
 */
export function signedDistanceField(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
): Float32Array {
  const count = width * height
  const insideSeeds = new Float32Array(count)
  const outsideSeeds = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const inside = alpha[i] >= 0.5
    insideSeeds[i] = inside ? 0 : SDF_INF
    outsideSeeds[i] = inside ? SDF_INF : 0
  }

  squaredEdt(insideSeeds, width, height)
  squaredEdt(outsideSeeds, width, height)

  const field = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const a = alpha[i]
    const sign = a >= 0.5 ? 1 : -1
    const unsigned = Math.sqrt(insideSeeds[i]) + Math.sqrt(outsideSeeds[i])
    let dist = sign * (unsigned - 0.5)

    if (a > 0 && a < 1) {
      const subPixel = a - 0.5
      // 1 in the boundary layer (|dist| <= 0.5), fading to 0 at 1.5 px out.
      const w = Math.min(1, Math.max(0, 1.5 - Math.abs(dist)))
      dist += w * (subPixel - dist)
    }

    field[i] = dist
  }

  return field
}

/**
 * Area (box) filter downsample of a distance field. Distances are already in source pixels and stay
 * in source pixels, so values are averaged, never rescaled. Handles non-integer ratios by weighting
 * partially covered pixels.
 */
export function downsampleField(
  src: ArrayLike<number>,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) return Float32Array.from(src)

  const dst = new Float32Array(dstWidth * dstHeight)
  const sx = srcWidth / dstWidth
  const sy = srcHeight / dstHeight

  for (let y = 0; y < dstHeight; y++) {
    const y0 = y * sy
    const y1 = y0 + sy
    const iy0 = Math.max(0, Math.floor(y0))
    const iy1 = Math.min(srcHeight - 1, Math.ceil(y1) - 1)

    for (let x = 0; x < dstWidth; x++) {
      const x0 = x * sx
      const x1 = x0 + sx
      const ix0 = Math.max(0, Math.floor(x0))
      const ix1 = Math.min(srcWidth - 1, Math.ceil(x1) - 1)

      let sum = 0
      let weight = 0
      for (let yy = iy0; yy <= iy1; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy)
        if (wy <= 0) continue
        const row = yy * srcWidth
        for (let xx = ix0; xx <= ix1; xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx)
          if (wx <= 0) continue
          const w = wx * wy
          sum += src[row + xx] * w
          weight += w
        }
      }
      dst[y * dstWidth + x] = weight > 0 ? sum / weight : 0
    }
  }

  return dst
}

/** distance (source px) -> 8-bit sample. 128 is the edge, >128 inside. */
export function encodeDistance(distance: number, rangePx: number): number {
  const normalized = Math.max(-1, Math.min(1, distance / rangePx))
  return Math.max(0, Math.min(255, Math.round(128 + normalized * 127)))
}

/** 8-bit sample -> distance in source px. Inverse of `encodeDistance`. */
export function decodeDistance(value: number, rangePx: number): number {
  return ((value - 128) / 127) * rangePx
}

/** Quantise a whole field. */
export function encodeField(field: ArrayLike<number>, rangePx: number): Uint8Array {
  const out = new Uint8Array(field.length)
  for (let i = 0; i < field.length; i++) out[i] = encodeDistance(field[i], rangePx)
  return out
}

/** Decode a whole map back to distances. Used by tests and debug tooling. */
export function decodeField(bytes: ArrayLike<number>, rangePx: number): Float32Array {
  const out = new Float32Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) out[i] = decodeDistance(bytes[i], rangePx)
  return out
}

/** Fit `size` to the long edge, keep the aspect ratio, never go below 1 px. */
export function targetDimensions(
  width: number,
  height: number,
  size: number,
): { width: number; height: number } {
  if (width >= height) {
    return { width: size, height: Math.max(1, Math.round((height * size) / width)) }
  }
  return { width: Math.max(1, Math.round((width * size) / height)), height: size }
}

export interface ComputeSdfOptions {
  /** Source alpha, 0..1, `width * height` values. */
  readonly alpha: ArrayLike<number>
  readonly width: number
  readonly height: number
  /** Long edge of the output map. */
  readonly size: number
  /** Clamp range, in SOURCE pixels. */
  readonly rangePx: number
}

export interface SdfResult {
  readonly data: Uint8Array
  readonly field: Float32Array
  readonly width: number
  readonly height: number
  readonly rangePx: number
  readonly sourceWidth: number
  readonly sourceHeight: number
}

/** Full bake: alpha in, quantised SDF map plus sidecar metadata out. */
export function computeSdf({ alpha, width, height, size, rangePx }: ComputeSdfOptions): SdfResult {
  const full = signedDistanceField(alpha, width, height)
  const target = targetDimensions(width, height, size)
  const small = downsampleField(full, width, height, target.width, target.height)
  return {
    data: encodeField(small, rangePx),
    field: small,
    width: target.width,
    height: target.height,
    rangePx,
    sourceWidth: width,
    sourceHeight: height,
  }
}
