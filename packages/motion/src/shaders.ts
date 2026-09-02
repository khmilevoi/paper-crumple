/**
 * The 3D sheet program (§3.1). `motion` owns its shader because the pack carries oct-encoded
 * normals, one AO byte per vertex and a per-frame `alphaFloor`, and the fragment shader is
 * written against exactly those attributes. Splitting geometry from material would mean
 * publishing a rigid binary layout contract in v1, designed against a single implementation.
 *
 * Ported unchanged from `paper-crumple-3d/src/material.js:19-110`. What the port changes is
 * outside these strings: the spike's `draw()` opened by clearing the default framebuffer, and
 * §7.3 forbids that — the view performs a scissored clear over its own rect and `DrawScope` has
 * no `clear()` at all.
 */

/** The six debug views (`material.js:14`). Knob *values*, so the space in 'sheet alpha' is legal. */
export const DEBUG_VIEWS = ['composite', 'normals', 'ao', 'uv', 'sheet alpha', 'facing'] as const

/**
 * The attribute layout, which is also the VAO's whole contract (§3.1, §8.8). These four numbers
 * are the `layout(location = N)` declarations in `SHEET_VS`; changing one without the other
 * produces a mesh that draws garbage and no GL error.
 */
export const ATTR = { position: 0, normal: 1, ao: 2, uv: 3 } as const

export const SHEET_VS = `#version 300 es
layout(location = 0) in vec3 aPos;   // normalised sheet space, [-1, 1] per axis at frame 0
layout(location = 1) in vec2 aOct;   // normalized BYTE: oct-encoded normal in [-1, 1]
layout(location = 2) in float aAo;   // normalized UNSIGNED_BYTE
layout(location = 3) in vec2 aUv;
uniform vec4 uSheetPx;   // sheet centre x, y (target px, y up), half width, half height (px)
uniform vec2 uViewPx;    // viewport size
uniform float uDepthPx;  // px of z that map to the whole NDC depth range
out vec2 vUv;
out vec3 vNormal;
out float vAo;
vec3 octDecode(vec2 e) {
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) v.xy = (1.0 - abs(v.yx)) * vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0);
  return normalize(v);
}
void main() {
  vec2 px = uSheetPx.xy + aPos.xy * uSheetPx.zw;
  float zPx = aPos.z * uSheetPx.w;              // z is in sheet-height units
  // Orthographic, camera on +Z looking down -Z: larger z is nearer, so smaller depth.
  gl_Position = vec4(px / uViewPx * 2.0 - 1.0, -zPx / uDepthPx, 1.0);
  vUv = aUv;
  vNormal = octDecode(aOct);
  vAo = aAo;
}`

export const SHEET_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec3 vNormal;
in float vAo;
uniform sampler2D uFront;   // RGBA, straight alpha: sprite over its paper sheet; A = sheet alpha
uniform sampler2D uFibre;   // paper fibre tile: A = high-passed grain, 0.5 neutral
uniform vec4 uUvRect;       // sheet uv -> front texture uv: offset xy, scale zw
uniform vec3 uLight;        // unit vector toward the light, sheet space
uniform float uAlphaFloor;  // compaction: alpha = max(sheet alpha, floor)
uniform int uIdentity;      // 1 at pose 0: shade forced to exactly 1
uniform vec3 uPaperColor;
uniform vec3 uPaperBack;
uniform float uAmbient;     // Lambert floor: what a facet turned away from the light still keeps
uniform float uAoStrength;
uniform float uAoGamma;     // lifts the baked AO's crushed low end, so only real valleys go dark
uniform float uBackShade;   // how much darker the sheet's reverse reads than its front
uniform float uGrain;
uniform float uFibreScale;  // fibre tiles across the sheet
uniform int uDebug;
out vec4 outColor;
void main() {
  vec2 uv = uUvRect.xy + vUv * uUvRect.zw;
  vec4 front = texture(uFront, uv);
  float alpha = max(front.a, uAlphaFloor);
  // Transparent sheet must not write depth, or a margin in front would punch a hole in the paper behind it.
  // Off the identity path (uIdentity == 0, i.e. every shaded pose) BLEND is disabled (see draw()), so any
  // pixel above the cutoff writes its lit colour straight into the framebuffer with no blend against
  // whatever should show through a soft edge; the browser then composites that low-alpha, full-brightness
  // pixel against the page background instead, reading as a grey halo along torn/hull edges and creases.
  // Raising the cutoff to an alpha-test (~0.4) on shaded poses only removes that half-covered band; the
  // identity path keeps 0.002 so pose 0 stays the byte-exact sprite the identity job measures.
  float discardCutoff = uIdentity == 1 ? 0.002 : 0.4;
  if (alpha < discardCutoff) discard;
  float fibre = texture(uFibre, vUv * uFibreScale).a;
  float grainK = 1.0 + (fibre - 0.5) * uGrain;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float lambert = uAmbient + (1.0 - uAmbient) * max(dot(n, uLight), 0.0);
  // The bake's AO is crushed: at the last frame its mean over the sheet is 0.20 and its maximum
  // 0.69, because half the vertices are buried INSIDE the ball and are legitimately black. Used
  // raw that paints the whole visible shell mid-grey. The gamma expands the top of the range --
  // where the outer shell lives -- and leaves the buried, near-zero end dark, which is the
  // near-white-paper-with-dark-valleys reading the reference has.
  float ao = mix(1.0, pow(max(vAo, 0.0), uAoGamma), uAoStrength);
  float shade = uIdentity == 1 ? 1.0 : lambert * ao * (gl_FrontFacing ? 1.0 : uBackShade);
  vec3 paper = uPaperColor * grainK;
  vec3 rgb;
  if (gl_FrontFacing) {
    // Straight alpha: the sheet's own pixels at their coverage, compaction paper under the rest.
    // With front.a == 1 this is front.rgb * 1 + paper * 0, divided by 1: exact, by IEEE rules.
    // Then compaction fades that whole composite to paper, because raising alpha alone leaves an
    // opaque sprite pixel opaque: at uAlphaFloor 1 the ball must be paper on both sides. mix(a, b,
    // 0.0) returns a bitwise, so pose 0 (floor 0) is still the exact sprite.
    rgb = mix((front.rgb * front.a + paper * (alpha - front.a)) / alpha, paper, uAlphaFloor);
  } else {
    rgb = uPaperBack * grainK;
  }
  if (uDebug == 1) { outColor = vec4(n * 0.5 + 0.5, 1.0); return; }
  if (uDebug == 2) { outColor = vec4(vec3(vAo), 1.0); return; }
  if (uDebug == 3) { outColor = vec4(vUv, 0.0, 1.0); return; }
  if (uDebug == 4) { outColor = vec4(vec3(front.a), 1.0); return; }
  if (uDebug == 5) { outColor = gl_FrontFacing ? vec4(0.2, 0.9, 0.3, 1.0) : vec4(0.9, 0.3, 0.2, 1.0); return; }
  outColor = vec4(rgb * shade, alpha);
}`
