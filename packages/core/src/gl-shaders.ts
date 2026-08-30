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
