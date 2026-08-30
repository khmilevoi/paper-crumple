/**
 * Every GLSL ES 3.00 source in `@paper-crumple/core`, as template literals.
 *
 * They are strings and not `.glsl` files on purpose: `tsdown` bundles TypeScript, a `.glsl` import
 * would need a bundler plugin in every consumer's build, and §14's packaging rules leave no room
 * for one. `gl-shaders.test.ts` asserts the properties a driver would otherwise report as a
 * compile error three layers away from the cause.
 *
 * **Each source starts at the first character of the literal.** A newline before `#version` makes
 * the driver fall back to ES 1.00 and report an error about syntax that is perfectly valid 3.00.
 */

/**
 * The three-vertex fullscreen triangle. No attributes and no buffers: `gl_VertexID` alone,
 * drawn as `drawArrays(TRIANGLES, 0, 3)` with any VAO bound.
 *
 * `0 -> (-1,-1)`, `1 -> (3,-1)`, `2 -> (-1,3)` — one triangle that covers the whole clip square
 * with no diagonal seam, which a two-triangle quad would put through two different interpolators.
 */
export const FULLSCREEN_VS = `#version 300 es
precision highp float;
precision highp int;

void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

/**
 * §8.5.3's probe: recover the byte a normalised `RGBA8` texel was uploaded from.
 *
 * ES 3.0 specifies unorm to float as exactly `c / 255`, so `uint(c * 255.0 + 0.5)` recovers the
 * byte unless a driver is off by more than 0.2 %. The probe checks it rather than assuming it;
 * with it green the `RGBA8UI` staging texture and its `ArrayBufferView` disappear from the runtime
 * and 3.8 MB of heap goes with them.
 */
export const EXACT_BYTE_FETCH_FS = `#version 300 es
precision highp float;
precision highp int;

uniform highp sampler2D uSource;

out uvec4 oColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  oColor = uvec4(texelFetch(uSource, p, 0) * 255.0 + 0.5);
}
`

/** The uniform names `RESAMPLE_FS` declares, in one place so a caller cannot mistype one. */
export const RESAMPLE_UNIFORMS = Object.freeze({
  /** `usampler2D`, the `RGBA8UI` source. Bound to texture unit 0. */
  source: 'uSource',
  /** `ivec4` — the source rect as `x, y, w, h`, in source texels. */
  srcRect: 'uSrcRect',
  /** `ivec2` — `dstW, dstH`. Equals the target's dimensions and the viewport. */
  dst: 'uDstSize',
} as const)

/**
 * §7.4.1's `identityResample`, as a GLSL ES 3.00 fragment shader.
 *
 * **The twin of `resampleAreaExact` in `./resample.ts`, byte-identical by construction.** The
 * axis plan is recomputed per fragment from `srcLen` and `dstLen` rather than uploaded as a
 * weight table, so there is no table and no formula to drift apart. Every step is exact 32-bit
 * integer arithmetic: `highp int` is required to be exactly 32 bits with exact integer operations
 * in GLSL ES 3.00, and `precision highp int` must be declared because the fragment default is
 * `mediump`.
 *
 * - `idiv(n, d)` is `n / d`, which truncates toward zero — and both operands are non-negative
 *   everywhere here by construction, so truncation *is* the floor and the known GLSL/JS
 *   disagreement on negative rounding is out of reach rather than merely documented.
 * - `Sigma q = Q` exactly, by telescoping integer division. There is no correction pass.
 * - The accumulators are `uint`. `Sigma wt = T`, so `Sr <= 255 * 255 * T` and the largest value
 *   any accumulator or `roundDivU` addend reaches is `RESAMPLE_MAX_ACCUMULATOR`, 1 067 458 560 —
 *   inside 32 bits with 4x headroom, independent of the ratio.
 * - **No clamp.** `Sa <= 255 * T => A <= 255`; `Sr <= 255 * Sa => R <= 255`. If this shader needs
 *   a clamp to pass, the shader is wrong, not the reference.
 * - **RGB divides by the unrounded `Sa`, never by `A`.** The normaliser cancels out of
 *   `(Sigma wt*r*a / T) / (Sigma wt*a / T)`, so the un-premultiply is one exact division rather
 *   than a second rounding. The `Sa = 0` branch preserves the matte colour of a fully transparent
 *   region rather than inventing one.
 * - **No flip anywhere.** `oy` is `int(gl_FragCoord.y)`, the source row is `uSrcRect.y + jy`, and
 *   `UNPACK_FLIP_Y_WEBGL` is pinned off — so the reference's row 0 is the texture's row 0 is the
 *   first row `readPixels` returns. A vertically mirrored comparison means the pin was lost.
 * - Identity at ratio 1 is structural: every window is one source texel at weight 128, so
 *   `Sigma wt = T`, `roundDiv(Sa, T) = a` and `roundDiv(T*r*a, T*a) = r`, on every channel
 *   including RGB under zero alpha. There is no fast path here at all.
 */
export const RESAMPLE_FS = `#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D uSource;
uniform ivec4 uSrcRect;
uniform ivec2 uDstSize;

out uvec4 oColor;

const int Q = 128;
const uint T = 16384u;

// The exact floor for n >= 0, d >= 1. Both operands are non-negative everywhere below.
int idiv(int n, int d) {
  return n / d;
}

// Round-half-up, for n >= 0, d >= 1. The only rounding in the algorithm, four times per texel.
uint roundDivU(uint n, uint d) {
  return (n + (d >> 1u)) / d;
}

void main() {
  int ox = int(gl_FragCoord.x);
  int oy = int(gl_FragCoord.y);

  int srcW = uSrcRect.z;
  int srcH = uSrcRect.w;
  int dstW = uDstSize.x;
  int dstH = uDstSize.y;

  // Step 1, per axis, in units of 1/dstLen.
  int loX = ox * srcW;
  int hiX = loX + srcW;
  int j0X = idiv(loX, dstW);
  int j1X = min(srcW, idiv(hiX + dstW - 1, dstW));

  int loY = oy * srcH;
  int hiY = loY + srcH;
  int j0Y = idiv(loY, dstH);
  int j1Y = min(srcH, idiv(hiY + dstH - 1, dstH));

  uint sr = 0u;
  uint sg = 0u;
  uint sb = 0u;
  uint sa = 0u;
  uint ur = 0u;
  uint ug = 0u;
  uint ub = 0u;

  // Step 2, weights by telescoping integer division. cum is non-decreasing so q >= 0, and
  // cum(j1-1) = Q, so the weights of one window sum to exactly Q with no correction pass.
  int prevY = 0;
  for (int jy = j0Y; jy < j1Y; jy++) {
    int eY = min(max((jy + 1) * dstH, loY), hiY) - loY;
    int cumY = idiv(Q * eY, srcH);
    int qy = cumY - prevY;
    prevY = cumY;

    int prevX = 0;
    for (int jx = j0X; jx < j1X; jx++) {
      int eX = min(max((jx + 1) * dstW, loX), hiX) - loX;
      int cumX = idiv(Q * eX, srcW);
      int qx = cumX - prevX;
      prevX = cumX;

      // Step 3, accumulate with wt = q_x * q_y into seven exact accumulators.
      uint wt = uint(qy * qx);
      uvec4 t = texelFetch(uSource, ivec2(uSrcRect.x + jx, uSrcRect.y + jy), 0);
      sr += wt * t.r * t.a;
      sg += wt * t.g * t.a;
      sb += wt * t.b * t.a;
      sa += wt * t.a;
      ur += wt * t.r;
      ug += wt * t.g;
      ub += wt * t.b;
    }
  }

  // Step 4, the only place rounding appears. RGB divides by the unrounded Sa, never by A.
  uint a = roundDivU(sa, T);
  uint r = sa > 0u ? roundDivU(sr, sa) : roundDivU(ur, T);
  uint g = sa > 0u ? roundDivU(sg, sa) : roundDivU(ug, T);
  uint b = sa > 0u ? roundDivU(sb, sa) : roundDivU(ub, T);

  // Step 5, no clamp. It would never fire and must not be written as a safety net.
  oColor = uvec4(r, g, b, a);
}
`
