/**
 * `PAPER_FS`, the whole Pass C fragment shader, ported as one unit (spec 15: "shaders are not
 * additive here"). Source: `paper.js:41-2017` in the spike at
 * `C:/Users/Khmil/JsProjects/odeja/spikes/paper-fold/src/paper.js` — the entire `PAPER_FS`
 * template literal, 1977 lines, byte-for-byte, comments included. That string is the ONLY
 * documentation this repository will ever have of the fold model, the deckle, the crumple
 * mosaic and the border guard; it is preserved whole rather than re-derived.
 *
 * Exactly five edits were applied to the spike's text, and no sixth:
 *
 * 1. **`MAX_FOLDS` becomes a module constant** (`paper.js:44`'s `${MAX_FOLDS}` interpolation is
 *    kept; the value it interpolates now comes from this file's own `export const MAX_FOLDS = 12`
 *    rather than from `poses.js:16`, which does not move here). The edge redesign added four more
 *    interpolations by the SAME mechanism and no new one — `MID_SCALLOP`, `MID_SMOOTH_COEF`,
 *    `MID_LOW_ANGULAR` / `MID_HIGH_ANGULAR` and `CHEW_REACH` now come from `edge-derive.ts`, which
 *    is where the CPU side of the tear budget reads them, and the emitted text is the literals
 *    that were there.
 * 2. **`vUv` becomes `gl_FragCoord`** (`paper.js:46`'s `in vec2 vUv;` deleted, `:1451`'s
 *    `vec2 uv = vUv;` replaced with `gl_FragCoord.xy / uFrontSize`, `uFrontSize` added): core's
 *    `FULLSCREEN_VS` emits no varying.
 * 3. **`uImage` becomes an unpadded integer artwork read with `texelFetch`** (`paper.js:49`'s
 *    `uniform sampler2D uImage;` becomes `highp usampler2D`, `uArtworkRect` added, `:1464`'s
 *    `texture(uImage, uv)` replaced with a `texelFetch` against `gl_FragCoord` minus the rect
 *    origin, and `precision highp int;` added beside `precision highp float;`): spec 7.4.1, spec
 *    8.5.
 * 4. **The two RGBA tile samplers become four `R8` ones** (`paper.js:106-107`'s `uCrumpleTex` /
 *    `uFibreTex` become `uCrumpleR` / `uCrumpleG` / `uCrumpleA` / `uFibreA`; the four sampling
 *    sites at `:1301-1302`, `:1321`, `:1563`, `:1643-1648`, `:1704-1705` follow; `scUv` is
 *    hoisted once at `:1643` rather than repeated three times): spec 14, spec 14.1 (`uCrumpleR` /
 *    `uCrumpleG` hold the PREMULTIPLIED normal; `crumple.b` and `fibre.rgb` were never sampled).
 * 5. **Nothing else.** Every debug branch, `uDebug`, the fold uniforms and the whole fold loop
 *    (even though the front build passes `uFoldCount = 0`), and the shadow path (even though the
 *    front build passes `uShadow = 0`) are kept whole. A line deleted now cannot be added back by
 *    a later plan without re-deriving it.
 *
 * The performance programme's P6a then made three more edits, each identical at the RGBA8 byte
 * level by derivation (the block above `main()` carries the proof,
 * `paper-shader-early-out.gl.test.ts` the byte-for-byte evidence):
 *
 * 6. **Two early-outs at the top of `main()`**, under the front build's uniform guard
 *    (`frontFastPath()`): an opaque artwork texel the tear's floor already covers writes
 *    `vec4(img.rgb, 1.0)`; an empty texel further outside the noise-free scrap than any edge term
 *    can reach writes `vec4(0.0)`. `#define PAPER_EARLY_OUT 0` compiles them out (tests only).
 * 7. **The drop-shadow base is skipped at `uShadow == 0.0`** (and `uShadowBlur > 0.0`, which is
 *    what keeps `shadowA` finite): `sa` is exactly `0.0` on that path, as `shadowA * 0.0` was.
 * 8. **Three helpers split out of `scrapBase`, `noiseGate` and `tearOf`** (`scrapUnguarded`,
 *    `gateReach`, `tearFloor`), so the early-outs evaluate the same arithmetic the full path does;
 *    and `img`, `nUv` and `wear` moved to the top of `main()` — `wear` because `creaseNet` takes
 *    `fwidth`, which has to stay in uniform control flow ahead of any per-fragment `return`.
 *    Nothing else moved.
 *
 * P7 (the first-load freeze) made one more, and it deletes no line either:
 *
 * 9. **`#define PAPER_FRONT_BUILD 1` compiles the front build's dead paths out.** Every program
 *    this package links serves `renderFront`, which fixes `uFoldCount = 0`, `uShadow = 0`,
 *    `uCrumpleFill = 0` and `uDebug = 0` (spec 8.6, `paper-renderer.ts`) — so the fold loops, the
 *    flap shadow, the crumple mosaic, the ball compaction, the drop shadow's fold cut and ball
 *    term, and the debug views are never executed, but ANGLE's HLSL compiler (fxc) still compiled
 *    them: 42–48 s cold on an Intel Iris Xe (D3D11), of which the crumple block alone was ~80 %.
 *    The `#if !PAPER_FRONT_BUILD` guards below leave the text whole and hand fxc only what the
 *    front build can reach; the identity proof is the P7 block above `main()`, the evidence is
 *    `paper-shader-early-out.gl.test.ts` (byte-for-byte against `PAPER_FRONT_BUILD 0`, which is
 *    the whole program of edits 1–8 and what a later draw path would link).
 */

import {
  CHEW_REACH,
  MID_HIGH_ANGULAR,
  MID_LOW_ANGULAR,
  MID_SCALLOP,
  MID_SMOOTH_COEF,
} from './edge-derive.js'

/** `poses.js:16`. `build()` renders pose 0, whose fold list is empty; the fold table itself is
 * not this plan's — only the constant the shader's `#define` interpolates is. */
export const MAX_FOLDS = 12

/** `paper.js:28`. Reference px one tile of the crumple photograph spans on a flat sheet
 * (hull-mode relief, `uSheetTile`). */
export const SHEET_TILE_PX = 1100

/** Reference px one tile of the fibre photograph spans (`paper.js:1523`'s literal `300.0`,
 * `:1704-1705`'s literal `120.0` / `60.0`) — the fibre-tile analogue of `SHEET_TILE_PX`. Not a
 * spike export: the spike leaves this one inline. A later task imports it to keep the tile's
 * reference scale in one place. */
export const FIBRE_TILE_PX = 300

/** `paper.js:13`, verbatim. The eight debug views `uDebug` selects between. */
export const DEBUG_MODES: readonly string[] = [
  'composite',
  'raw SDF',
  'loose SDF',
  'paper mask',
  'fold regions',
  'fold depth',
  'artwork only',
  'paper field',
]

/**
 * A number as GLSL float text: `1` becomes `1.0`, `1.6` stays `1.6`.
 *
 * GLSL has no implicit int-to-float conversion in an expression like `-bite * 1`, so a coefficient
 * that happens to be integral has to carry its point. Every interpolation below goes through this,
 * so the emitted text is exactly the literal it replaced. Exported so the test that pins the
 * interpolation can format the expected text the same way rather than hard-coding a `.0`.
 */
export function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : `${n}`
}

export const PAPER_FS = `#version 300 es
precision highp float;
precision highp int;

#define MAX_FOLDS ${MAX_FOLDS}
// P6a: 1 compiles the front-build early-outs in (see the block above main()), 0 compiles them
// out. The GL identity test flips it to 0 through a string replace; it is not a knob or a uniform.
#define PAPER_EARLY_OUT 1
// P7: 1 compiles out every path the front build's fixed uniforms (uFoldCount 0, uShadow 0,
// uCrumpleFill 0, uDebug 0) make unreachable — see the P7 block above main() — so the D3D11
// backend's HLSL compile is seconds rather than the better part of a minute. 0 is the whole
// program, which the identity test links to compare against; it is not a knob or a uniform.
#define PAPER_FRONT_BUILD 1

uniform vec2 uFrontSize;  // front-pass render target size, px
out vec4 outColor;

uniform highp usampler2D uImage;
uniform vec4 uArtworkRect;   // (x, y, w, h) in front texels
uniform sampler2D uSdfTight;
uniform sampler2D uSdfLoose;
uniform vec2 uDecodeTight;   // texel -> working-texture pixels
uniform vec2 uDecodeLoose;
uniform vec4 uTightUv;       // (scale.xy, offset.xy) into the tight field's uv space

uniform float uAspect;       // image width / height
uniform float uPlanePx;      // pixels per unit of the centred working space (= image height)
uniform float uAaPx;         // one rendered pixel, in source pixels
// Working pixels per REFERENCE pixel: uPlanePx / 1000. Every knob measured in px is quoted
// against a 1000 px-tall sprite and multiplied by this on the way in, and the few pixel-space
// constants left in here are multiplied by it too. Without that a wardrobe thumbnail — which is
// the main thing this effect is for — gets a tear three times coarser relative to the garment
// than the full-size render does, which at 320 px chews holes through the backing.
uniform float uPxScale;

// --- backing ---------------------------------------------------------------
// Every "px" below is a WORKING-TEXTURE pixel. The knob it comes from is quoted in reference
// pixels and has already been multiplied by uPxScale on the JS side.
// W, working px: how far the paper reaches past the artwork. The ONE value that decides whether
// there is a border at all — every border-only decoration rides edgeK(), which reads this and
// nothing else (design 2026-09-05 §6, §7).
uniform float uEdgeWidth;
// Working px added to the contour source, in scrapUnguarded's 'd +=', tearFloor's floor and
// farOutside's floor test. NOT the same number as uEdgeWidth, and deliberately so.
//
// CORRECTION TO THE SPEC (design 2026-09-05 §6's table, controller ruling R12). That table gives
// the single thickness uniform this pair replaces the value W in all four cells. It is wrong, and
// this is the plan's sixth correction to the spec.
// The bias is what pushes the contour source outward from the artwork's own silhouette, so it is
// W only when the source IS that silhouette — i.e. under 'edgeShape: 'torn'', where the renderer
// binds the artwork's tight/loose pair. Under 'edgeShape: 'smooth'' the renderer binds the hull
// polygon's own field to both, and that polygon ALREADY sits at W(1 +/- v); biasing it again by W
// would put the sheet out at 2W. The tear floor 'tight + 0.4 * uBaseBias' is the same bias in
// disguise — under 'smooth', 'tight' IS the polygon field, so a non-zero floor would inflate the
// contour by 0.4 W. So: 0 under 'smooth', W under 'torn'. Do not "restore" the spec's version.
uniform float uBaseBias;
uniform float uTearFreq;     // low-octave facets per image width
uniform float uTearAmp;      // low octave, source px
uniform float uMidAmp;       // mid octave (scallops and bites), source px
uniform float uChew;         // high octave (pixel-level teeth), source px
uniform float uTearAngular;  // 0 = smooth (bilinear) tear contour, 1 = piecewise-linear, sharp corners
uniform float uFiberDens;    // 0..1 how much of the contour carries the short fibre fringe
uniform float uFiberLen;     // fringe hair length, source px; the rare strands are 4x this
uniform float uGrain;
uniform float uDeckleWidth;  // nominal width of the torn band, source px
uniform float uDeckleLight;  // how far toward white the band goes
uniform float uDeckleTex;    // fibrous texture inside the band
uniform float uTearShadow;   // dark line where the raised core shades the sheet, just inside the band
uniform float uCreases;      // pale hairline wear across the face of the sheet
uniform vec3 uPaperColor;
uniform float uShadow;
uniform float uShadowBlur;   // source px
uniform vec2 uShadowOffset;  // uv
uniform float uSeed;

// --- folds -----------------------------------------------------------------
uniform vec3 uFolds[MAX_FOLDS];       // (n.x, n.y, c): the half-plane dot(p,n) > c folds over
uniform float uFoldJitter[MAX_FOLDS]; // radians the flap is rotated by as it lands
uniform int uFoldCount;
uniform float uCreaseDark;
uniform float uCreaseWidth;   // source px
uniform vec3 uPaperBack;      // reverse of the sheet — lighter than the front
uniform float uFacetStrength;
uniform vec2 uLightDir;       // cos/sin of the light angle
uniform float uDepthDark;
uniform float uSlack;         // plane units a flap may overhang a later fold line by
uniform float uFlapReach;     // source px a flap can reach past the sheet's envelope
uniform float uCrumpleFill;   // 0..1; how far into the crumple this pose is
uniform vec2 uCrumpleDepth;   // stacked sheets where the mosaic starts / is fully on
uniform float uCrumpleCells;  // cells per unit of the working space
uniform sampler2D uCrumpleR; // baked crushed-paper tile: RGB normal, A high-passed detail
uniform sampler2D uCrumpleG; // baked crushed-paper tile: RGB normal, A high-passed detail
uniform sampler2D uCrumpleA; // baked crushed-paper tile: RGB normal, A high-passed detail
uniform sampler2D uFibreA;   // baked paper-grain tile:   RGB normal, A high-passed detail
// crumple.b and fibre.rgb were never sampled; uCrumpleR and uCrumpleG hold the PREMULTIPLIED normal (spec 14.1).
uniform float uPhotoCrumple;   // how much of the crumple's relief comes from the photograph
uniform float uPhotoFibre;     // how much of the surface grain comes from the photograph
uniform float uBallR;          // the ball's nominal radius, in plane units (from the fold polygon)
uniform float uCrumpleBite;   // how far a rim plate sticks out or sits back, as a fraction of uBallR

// --- edge finish -------------------------------------------------------------
// 0 = clean: a plain cut. No deckle band, no fibres, no tear shadow.
// 1 = paper: the deckle band, the fibre fringe and the tear shadow (design 2026-09-05 §2.3).
// The CONTOUR is not encoded here at all: it is expressed by which textures the renderer binds
// (design §6), so this shader never asks where its base field came from.
uniform int uEdgeFinish;
uniform int uEdgeNone;
// There is no separate polygon-field sampler any more. Under 'edgeShape: 'smooth'' the renderer
// binds the polygon's own field to uSdfTight AND uSdfLoose, which is what makes scrapUnguarded
// return max(pf, pf) + 0 = pf; a third slot carrying the same texture had no reader left and was
// deleted with samplePaper (design 2026-09-05 §6). Bind the polygon to the two uSdf* slots.
uniform float uSheetCrumple;     // amplitude of the flat sheet's own relief, 0..1
uniform float uSheetTile;        // working px per tile of the crumple photograph on the sheet

uniform int uDebug;

const float FIBER_SPACING = 3.2;   // reference px between rare strands' lattice cells; x14 in use
const float FRINGE_SPACING = 1.7;  // reference px between fringe hairs (lattice cell along the tear)
const float FRINGE_WIDTH = 0.8;    // reference px, width of one fringe hair before antialiasing
const float STRAND_MULT = 4.0;     // the rare long strands are this many fringe lengths long
const float FACET_TILT = 1.15;    // how steeply a fold normal is read as a facet slope
// Sub-facet crinkle depth inside the ball's plates. Deliberately NOT tied to uCreases: that knob
// is the handling wear on a flat sheet, which the reference keeps almost invisible, while a
// crushed sheet is crinkled everywhere — visibly, but never dominantly. One knob cannot be both.
const float CRINKLE_AMT = 0.05;

// Width ramps the loose envelope, angular shaping and coarse tear octaves down to the PNG
// silhouette. Fine paper finish uses edgeDetailK instead and survives zero blank spacing.
const float EDGE_K_PX = 6.0;
float edgeK() { return smoothstep(0.0, EDGE_K_PX * uPxScale, uEdgeWidth); }
// Paper finish has its own physical thickness even when blank paper spacing is zero.
// Keep the old width ramp for the loose envelope and coarse contour shaping.
float edgeDetailK() { return uEdgeFinish == 1 ? 1.0 : edgeK(); }

// Ball compaction, in ball radii (uBallR == 1). See the "ball compaction" block in main.
//   BALL_GROW  radius the hole-filling body has grown to by fill 1 — past the plate outline
//              (1.3 R at most, 1.67 in the frontier's own ragged units), which is what actually
//              bounds the body by then. At 1.6 the frontier still dipped inside the outline and a
//              sprite with a gap in its sheet (the trench, the sneakers) kept 1-2 px holes there.
//   BALL_FAR   where the outer fade starts at fill 0+ — off the sprite entirely, so the early
//              poses are untouched; it sweeps in to the shell outline as the fill reaches 1.
//   BALL_SOFT  width of that fade at fill 0, shrinking to one rendered pixel at fill 1.
const float BALL_GROW = 2.0;
const float BALL_FAR = 4.0;
const float BALL_SOFT = 0.6;

// Sampling uses textureLod so that the reflected lookups inside the fold loop, which run
// under non-uniform control flow, stay well defined. There are no mip levels anyway.
// uTightUv maps this shader's padded-texture uv into the tight field's own uv. Identity for a
// runtime field; for a pre-baked one it undoes the padding the engine added.
//
// Outside the field's own rectangle the distance is EXTRAPOLATED, not clamped. A baked field
// covers only the artwork's bounding box, so its most negative value is however far the corner
// of that box is from the sprite — maybe 100 px. Clamping to that leaves the region beyond it
// reading as "100 px outside" all the way to infinity, and the pass B blur, which reaches
// further than that, then has nothing pulling the loose envelope back in: the backing balloons
// over the whole canvas. Since an SDF grows linearly, subtracting the distance to the box is
// the right correction and costs two instructions.
float sampleTight(vec2 uv) {
  vec2 p = uv * uTightUv.xy + uTightUv.zw;
  vec2 inside = clamp(p, 0.0, 1.0);
  float d = textureLod(uSdfTight, inside, 0.0).r * uDecodeTight.x + uDecodeTight.y;
  vec2 pxPerUv = vec2(uPlanePx * uAspect / uTightUv.x, uPlanePx / uTightUv.y);
  return d - length((p - inside) * pxPerUv);
}
float sampleLoose(vec2 uv) { return textureLod(uSdfLoose, uv, 0.0).r * uDecodeLoose.x + uDecodeLoose.y; }

// Hash of an integer cell index.
//
// The mod is load-bearing. The pixel-level octave runs at ~450 cycles across the sprite, and
// with the seed folded into the domain the raw cell indices reach several thousand; a
// multiply-and-fract hash on numbers that size runs out of float32 mantissa and collapses to
// a handful of distinct values, which is why the teeth were missing entirely at first. Wrapping
// the index keeps the hash in its precise range. The noise then tiles every 289 cells — about
// 600 px at the teeth octave and several sprite widths at the tear octave, so it never shows.
float hash21(vec2 c) {
  vec3 p3 = fract(vec3(mod(c, 289.0).xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Value noise with LINEAR interpolation, on purpose. The isocontour of a bilinear patch is a
// hyperbola, which over one cell reads as a straight facet with a sharp kink at the cell
// corner — the long straight tear edges of hand-torn paper. The usual smoothstep
// interpolation gives C1 contours, i.e. blobby lobes, which is the wrong material.
float noiseLinear(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float noiseSmooth(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Rotates a noise domain off-axis.
 *
 * Every octave gets its own angle, and none of them is a multiple of 90 degrees. Value noise
 * lives on an axis-aligned lattice, and a contour threaded through a high-contrast lattice
 * follows the cell edges — which at the pixel octave came out as visible axis-aligned
 * staircases along the tear. Rotating each octave hides the lattice, and the straight facets
 * then come from the low octave's cell SIZE, which is where they should come from.
 */
vec2 rot2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

// Value noise with TRIANGULATED linear interpolation: every lattice cell is split along its
// diagonal and each triangle carries the plane through its three corner values. The function is
// exactly linear inside a triangle, so its isocontour there is a straight SEGMENT — and the sum
// with a distance field (which is locally linear too, with unit gradient) is still linear, so
// the displaced tear contour runs dead straight across a triangle and turns sharply where it
// crosses into the next one. That is the difference between a bilinear patch, whose xy term
// bends every contour into a hyperbola (the rolling scallops the earlier build had), and the
// long straight runs with hard corners that hand-torn paper actually shows. Same corner values
// as noiseLinear, so the two can be mixed without the features moving.
float noiseTri(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  if (f.x + f.y < 1.0) return a + (b - a) * f.x + (c - a) * f.y;
  return d + (c - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
}

// Two octaves, counter-rotated. The second is weighted low and exists only to break the
// regularity of the first one's grid, not to curve the facets.
float tearFbm(vec2 p) {
  return noiseLinear(rot2(p, 0.51)) * 0.86 + noiseLinear(rot2(p * 2.17, -0.94) + 11.3) * 0.14;
}

// The same two lattices, triangulated. The second octave carries more weight here than in the
// smooth version: with straight runs the eye wants a second, shorter corner scale (30-60 px) on
// top of the 100 px one, and at 0.14 it read as one long polygon.
float tearFbmTri(vec2 p) {
  return noiseTri(rot2(p, 0.51)) * 0.76 + noiseTri(rot2(p * 2.17, -0.94) + 11.3) * 0.24;
}

/**
 * The low octave that owns the silhouette, with the smooth-to-angular mix. Contrasted only
 * mildly — pushed further it clips into plateaus and the contour traces lattice edges. Shared
 * by tearOf and paperFieldFast so a mirrored flap's edge is the same tear as the sheet's.
 */
float tearLow(vec2 nUv) {
  vec2 q = nUv * uTearFreq + uSeed;
  float n = uTearAngular <= 0.0 ? tearFbm(q)
          : uTearAngular >= 1.0 ? tearFbmTri(q)
          : mix(tearFbm(q), tearFbmTri(q), uTearAngular);
  // Contrast rises with the angular blend. A piecewise-linear octave at the smooth version's
  // contrast has corners of 170 degrees, which the eye reads as smooth; steeper transitions
  // between the plateaus are what make the corners corners. The plateaus themselves follow
  // the (polygonised) base.
  float contrast = mix(1.5, 2.6, uTearAngular);
  return clamp((n * 2.0 - 1.0) * contrast - 0.1, -1.0, 1.0);
}

// The centred, isotropic working space the fold lines live in. One unit == uPlanePx pixels.
vec2 toPlane(vec2 uv) { return (uv - 0.5) * vec2(uAspect, 1.0); }
vec2 toUv(vec2 p) { return p / vec2(uAspect, 1.0) + 0.5; }

/**
 * The noise-free scrap field, in source pixels. > 0 is paper.
 *
 * A union of the tight field and the pushed-out blurred one. Being a union is what makes the
 * result usable as a base:
 *
 *   - it always CONTAINS the contour source dilated by uBaseBias, so under 'edgeShape: 'torn''
 *     there is a continuous margin of paper all the way round the artwork, and
 *   - the blurred envelope can only ever ADD to that, filling concavities and throwing out
 *     the empty wedges, never eating into a sleeve.
 *
 * Under 'edgeShape: 'smooth'' the renderer binds the polygon's own field to BOTH uSdfTight and
 * uSdfLoose and uploads uBaseBias = 0, so this collapses to max(pf, pf) + 0 = pf — the polygon
 * field itself, border guard and all (design 2026-09-05 §6). There is no mode int for that; it
 * is expressed entirely by the binding.
 *
 * Thresholded at zero this is a single connected blob. Everything the noise does downstream
 * is a bounded perturbation of THIS contour, which is what keeps the scrap in one piece.
 */
// The scrap before its border guard, plus the tight sample it started from. Split out of
// scrapBase (P6a) so the far-outside early-out evaluates the very same arithmetic it reasons
// about; scrapBase is this minus the guard, operation for operation as before.
float scrapUnguarded(vec2 uv, out float tight) {
  tight = sampleTight(uv);
  // Design 2026-09-05 §6.1 item 2: the outward push that used to be added to the loose sample
  // here is gone. The loose field's own reach is what the redesign budgets, and re-inflating it
  // by a fraction of the blur sigma made "how far does the sheet reach" unanswerable.
  float d = max(tight, sampleLoose(uv));
  // The loose envelope collapses onto the tight field as the edge width goes to zero: a blurred
  // SDF is HIGHER than the tight one inside every concavity, so max(tight, loose) still bridges
  // the gap between two sleeves on its own. The blend is skipped at k == 1 so the default render
  // stays bit-identical.
  float k = edgeK();
  if (k < 1.0) d = tight + (d - tight) * k;
  d += uBaseBias;
  return d;
}
float scrapBase(vec2 uv) {
  float tight;
  float d = scrapUnguarded(uv, tight);
  // The padded texture is finite, so refuse to paint paper on its very border where the
  // field is clamped and meaningless.
  vec2 q = abs(uv - 0.5);
  return d - smoothstep(0.482, 0.5, max(q.x, q.y)) * 1e4;
}

/**
 * The noise-free base sheet field, for the consumers that want it WITHOUT the tear: the drop
 * shadow and the 'paper field' debug view. The visible mask goes through paperField and the fold
 * loop through paperFieldFast; all three bottom out in the same scrapBase.
 *
 * Which contour it describes is decided by the BINDING (design 2026-09-05 §6): the artwork's
 * tight/loose pair under 'edgeShape: 'torn'', the polygon's own field bound to BOTH uSdf* slots
 * under 'edgeShape: 'smooth''. The fold, crumple and compaction code never asks which.
 */
float baseField(vec2 uv) {
  return scrapBase(uv);
}

/**
 * How far out from the base contour the noise is allowed to build, in source pixels, and the
 * falloff that enforces it.
 *
 * This gate is what keeps the scrap connected. Without it the low octave alone crosses the
 * threshold far outside the sprite and spawns detached blobs of paper with nothing joining
 * them to the scrap — they read as dirt. With it, material can only ever appear inside a band
 * hugging a contour that is already one connected piece. Note the asymmetry: the gate is 1
 * on the inside, so the tear can still bite deep INWARD at full amplitude; it only limits
 * outward creation. The outward reach of the scrap comes from the blurred envelope instead.
 */
// The gate's reach on its own (P6a): the far-outside early-out needs exactly the number the gate
// clamps against, so both read it from here.
float gateReach() {
  float k = edgeK();
  // Design 2026-09-05 §6.1 item 3: the low octave's looseness factor is gone here too, so this
  // reach is the amplitude Task 3's 'tearAmpsFor' actually budgeted for. Removing a factor in
  // [0, 1] can only GROW the reach, which is the safe direction — see the P7 proof block.
  float reach = uBaseBias + (uTearAmp * k) * 0.6 + (uMidAmp * k);
  // At uBaseBias 0 with no octaves the reach is exactly zero and smoothstep(0, 0, x) is undefined
  // — on D3D it came out as NaN, which leaked through the mask into the alpha of every pixel
  // outside the artwork. The floor is far below any bias that draws a border, so it changes
  // nothing else.
  return max(reach, 0.01);
}
float noiseGate(float base) {
  float reach = gateReach();
  return smoothstep(-reach, -reach * 0.15, base);
}

// The tear's floor (P6a): tearOf never returns less than this, in source px — see its last two
// lines. The deep-inside early-out rests on that being an exact lower bound of paperField.
// uBaseBias, not uEdgeWidth: this floor is the outward bias in disguise (see uBaseBias). Under
// 'edgeShape: 'smooth'' sampleTight IS the polygon field, which already sits at W(1 +/- v), so a
// floor of 0.4 * W there would inflate the contour by 0.4 W. At uBaseBias 0 the floor is exactly
// the contour source, which is what a polygon contour wants.
float tearFloor(vec2 uv) { return sampleTight(uv) + uBaseBias * 0.4; }

// Lattice of the angular base: cells per tear-frequency cell, and the lattice's rotation off
// the image axes (so its three edge directions never line up with the sprite's).
const float ANG_FREQ = 1.2;
// Smooth-mode scallop amplitude per unit of uMidAmp: 26 px of notch depth is 4.7 px of scallop.
// Declared in edge-derive.ts (which derives 'MID_LOW_SMOOTH' from it) and interpolated here,
// so it exists once.
const float MID_SCALLOP = ${glslFloat(MID_SCALLOP)};
const float ANG_ROT = 0.37;

/**
 * The scrap base POLYGONISED: scrapBase sampled at the corners of a coarse rotated lattice and
 * interpolated piecewise-linearly over each triangle, blended toward the smooth field by
 * (1 - uTearAngular).
 *
 * This is what actually buys the straight runs. Adding a piecewise-linear noise to a smooth
 * distance field is not enough: the field's own gradient is 1 everywhere and the noise's is a
 * few tenths, so the contour of the sum still bends with the field — it follows the garment's
 * curvature with kinks on it, and reads as scallops. Hand-torn paper does the opposite: the
 * tear runs straight across whatever the print underneath is doing and turns at a corner. A
 * linear function has a straight zero set, so sampling the field at the lattice corners and
 * interpolating linearly inside each triangle gives a contour that is a POLYLINE with its
 * vertices on the triangle edges — anchored to the garment at ~70 px intervals and dead
 * straight between them. The tear noise on top is triangulated too, so the sum stays piecewise
 * linear on the union of the lattices: more corners, still straight between them.
 *
 * Also returns the gradient DIRECTION of the triangle's plane, which is free, so the edge frame
 * (fibres, band, shadow) can face the actual run rather than the smooth field's normal.
 *
 * The blend rides the edge-width ramp: at edge width 0 the base is the artwork's own outline and
 * polygonising THAT would cut the corners off the garment.
 *
 * THE ONE INVARIANT THAT IS NOT VISIBLE LOCALLY (design 2026-09-05 §6, Task 6 owns the line).
 * This block is gated on 'uTearAngular * edgeK()', an ANGULARITY, not on an amplitude — so
 * zeroing uTearAmp / uMidAmp / uChew under 'edgeShape: 'smooth'' does NOT switch it off. Left on,
 * it would polygonise the polygon's own field on a uPlanePx / (uTearFreq * ANG_FREQ) lattice
 * (~93 texels at the defaults), and since the interpolant of a convex SDF exceeds it outside every
 * reflex vertex, every concavity of the hull would be chamfered at an 80 % blend. Today's 'hull'
 * never entered here at all. THE RENDERER MUST UPLOAD uTearAngular = 0 UNDER 'smooth'; every other
 * "the octaves are off" invariant is checkable from inside this file, and this one is not.
 */
vec2 angCornerUv(vec2 c, float F) {
  return rot2((c - uSeed * 1.7) / F, -ANG_ROT) / vec2(uAspect, 1.0);
}

float baseAngular(vec2 uv, float base, out vec2 gradDir) {
  gradDir = vec2(0.0);
  float ang = uTearAngular * edgeK();
  if (ang <= 0.0) return base;
  vec2 nUv = uv * vec2(uAspect, 1.0);
  float F = uTearFreq * ANG_FREQ;
  vec2 q = rot2(nUv, ANG_ROT) * F + uSeed * 1.7;
  vec2 i = floor(q);
  vec2 f = fract(q);
  float v;
  vec2 g;
  if (f.x + f.y < 1.0) {
    float a = scrapBase(angCornerUv(i, F));
    float b = scrapBase(angCornerUv(i + vec2(1.0, 0.0), F));
    float c = scrapBase(angCornerUv(i + vec2(0.0, 1.0), F));
    v = a + (b - a) * f.x + (c - a) * f.y;
    g = vec2(b - a, c - a);
  } else {
    float d = scrapBase(angCornerUv(i + vec2(1.0, 1.0), F));
    float b = scrapBase(angCornerUv(i + vec2(1.0, 0.0), F));
    float c = scrapBase(angCornerUv(i + vec2(0.0, 1.0), F));
    v = d + (c - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
    g = vec2(d - c, d - b);
  }
  // Gradient in lattice units, rotated back into the image frame (uniform scale drops out).
  g = rot2(g, -ANG_ROT);
  float l = length(g);
  gradDir = (l > 1e-6) ? g / l : vec2(0.0);
  return mix(base, v, ang);
}

/**
 * Signed "paper-ness" of the torn scrap, in source pixels. > 0 is paper.
 *
 * Returns the field WITH the pixel-teeth octave, and writes the field without it to 'shaped'.
 * Both are wanted — the teeth decide the silhouette, the smooth version is what the fibers are
 * anchored to — and computing them in one call rather than two halves the octave count, which
 * at four noise lattices over the whole canvas is the single biggest cost in this shader.
 */
float tearOf(vec2 uv, float base, float baseAng, out float shaped) {
  // The seed is applied per octave, at that octave's own scale, rather than folded into the
  // domain before the frequency multiply — that would push the top octave's cell indices into
  // the thousands and cost it its precision.
  vec2 nUv = uv * vec2(uAspect, 1.0);
  // Every amplitude is scaled by the edge-width ramp. Written as (uX * k) so that at k == 1 the
  // arithmetic is the same sequence of operations as before, i.e. bit-identical.
  float k = edgeK();
  float tearAmp = uTearAmp * k;
  float midAmp = uMidAmp * k;
  float chew = uChew * edgeDetailK();

  // Low: the long run. A real tear goes a long way before it turns, so this is the octave that
  // owns the silhouette. Piecewise linear at uTearAngular 1 (straight runs, sharp corners),
  // bilinear at 0 (the old rolling scallops); see noiseTri.
  float low = tearLow(nUv);
  // Mid: 35-60 px scallops. Long-wavelength and low-amplitude on purpose — the macro photos
  // show a calm outline that runs a long way before it turns, with occasional angular kinks,
  // not a leafy one. Turning the amplitude up or the wavelength down is what made the earlier
  // silhouette spiky. Fine detail belongs to the teeth and to the deckle band, not to the
  // outline. Triangulated along with the low octave, so it adds small kinks rather than bumps.
  //
  // In ANGULAR mode the mid octave is something else: sparse V-shaped notches. The reference
  // outline is calm for a long way and then takes a sharp bite 20-50 px deep — a V, not a
  // scallop. A triangulated noise on a ~45 px lattice, thresholded so only its peaks survive,
  // is a scatter of sharp-tipped pyramids; where one crosses the contour the contour takes a V
  // out of the paper (mostly) or a tab of it (rarely, from a second lattice). Piecewise linear
  // throughout, so the notch has straight sides. uMidAmp is the notch depth here.
  //
  // uMidAmp is quoted as a notch depth (26 px by default). The smooth scallops were tuned at
  // 4.5 px, so the smooth term is scaled by MID_SCALLOP to keep the old look at tearAngular 0.
  vec2 midQ = rot2(nUv * uTearFreq * 1.8, 1.13) + uSeed * 3.1;
  // edge-derive.ts's 'MID_LOW_SMOOTH' is this same product, computed there from the same two
  // constants.
  float midSmooth = (noiseLinear(midQ) * 2.0 - 1.0) * ${glslFloat(MID_SMOOTH_COEF)} * MID_SCALLOP;
  float mid = midSmooth;
  if (uTearAngular > 0.0) {
    vec2 nq = rot2(nUv * uTearFreq * 2.5, -0.71) + uSeed * 2.3;
    float bite = max(noiseTri(nq) - 0.56, 0.0) / 0.44;
    vec2 tq = rot2(nUv * uTearFreq * 2.1, 2.05) + uSeed * 4.9;
    float tab = max(noiseTri(tq) - 0.74, 0.0) / 0.26;
    // Depth in units of uMidAmp; the smooth version's scallops are only 1.25 units wide.
    // 'MID_LOW_ANGULAR' and 'MID_HIGH_ANGULAR', from edge-derive.ts, which budgets the amplitudes
    // this expression spends.
    float midAng = -bite * ${glslFloat(MID_LOW_ANGULAR)} + tab * ${glslFloat(MID_HIGH_ANGULAR)};
    mid = mix(midSmooth, midAng, uTearAngular);
  }
  // High: 1-3 px teeth. Two counter-rotated lattices, because one at this frequency reads as a
  // regular comb however it is rotated. SMOOTH interpolation here, unlike every other octave:
  // the linear patch's contour is a straight segment that runs along a cell edge, and at a
  // 2-3 px cell with an amplitude of the same order that is a visible axis-aligned staircase —
  // the blocky rectangular intrusions the earlier build had. At this scale nobody can see the
  // difference between a straight facet and a curved one, so C1 costs nothing and buys the
  // staircase away.
  float high =
    (noiseSmooth(rot2(nUv * uTearFreq * 22.0, 0.62) + uSeed * 7.3) * 2.0 - 1.0) * 0.62 +
    (noiseSmooth(rot2(nUv * uTearFreq * 34.0, -1.31) + uSeed * 5.7) * 2.0 - 1.0) * 0.38;

  // Low and mid shape the contour; both are gated by distance so they cannot build material
  // out in open space.
  // The gate stays on the SMOOTH base: it is a connectivity guard, and the polygonised field
  // can only ever sit within one lattice cell of the smooth one.
  // Design 2026-09-05 §6.1 item 3: the low octave carried a looseness factor here. It is
  // gone — the amplitude the CPU budgets in 'tearAmpsFor' is the amplitude the shader applies,
  // which is what makes "the inward reach is W(1 - v)" a measurable claim at all.
  shaped = baseAng + (low * tearAmp + mid * midAmp) * noiseGate(base);

  // The teeth are applied last and confined to a narrow band around the contour they are
  // chewing. Isotropic teeth at this amplitude flip isolated pixels over the threshold out in
  // the middle of nowhere, which shows up as scattered specks of dirt; restricted to a band a
  // couple of teeth wide, they can only ever nibble an edge that already exists.
  //
  // And they run in PATCHES. Chewing every millimetre of the contour is a saw, and a saw reads
  // as a clean cut with noise added to it rather than as a tear: the reference's silhouette runs
  // two or three hundred pixels perfectly smooth and then breaks up for fifty. Same argument as
  // the fringe, which is patchy for the same reason. The clump lattice is deliberately coarse —
  // about 180 reference px — so a clean run lasts long enough to be read as clean.
  // 'CHEW_REACH', from edge-derive.ts; the second use of it is farOutside's own 'teeth'.
  float teeth = chew * ${glslFloat(CHEW_REACH)};
  float band = 1.0 - smoothstep(0.0, max(teeth * 1.8, 0.5), abs(shaped));
  float toothClump = smoothstep(0.30, 0.66, noiseSmooth(nUv * 5.5 + uSeed * 2.7));
  float d = shaped + high * teeth * band * toothClump;

  // Floor: whatever the tear does, the paper still covers the contour source dilated by a
  // quarter of the outward bias. A 42 px inward bite is deeper than the margin in places, and
  // without this the tear occasionally cuts back past the artwork's own edge and exposes it.
  // 0.4 of the bias rather than the earlier quarter: the V notches bite deeper than the
  // old scallops did, and where they hit the floor the band needs a few pixels of sheet under
  // it or the core rim becomes an outline drawn straight onto the print.
  float floorD = tearFloor(uv);
  shaped = max(shaped, floorD);
  return max(d, floorD);
}

/**
 * Local edge direction. Central differences on the field the contour actually follows.
 *
 * It has to be scrapBase, not the blurred field alone. Where the tight band wins — around a
 * sleeve, a cuff, anything thin — the blurred field's gradient points somewhere else entirely,
 * so fibers oriented by it ran at an angle to the contour or flat along it, and a crest lying
 * parallel to the contour a few px out is a DETACHED streak. That was the whole speck problem.
 * Four taps, no derivatives, so this is safe under non-uniform control flow.
 */
vec2 edgeNormal(vec2 uv) {
  vec2 e = vec2(2.0 / (uPlanePx * uAspect), 2.0 / uPlanePx);
  vec2 g = vec2(
    scrapBase(uv + vec2(e.x, 0.0)) - scrapBase(uv - vec2(e.x, 0.0)),
    scrapBase(uv + vec2(0.0, e.y)) - scrapBase(uv - vec2(0.0, e.y))
  );
  float l = length(g);
  return (l > 1e-5) ? g / l : vec2(0.0, 1.0);
}

/**
 * Fibers: the paper hairs along the tear, returned as a COVERAGE (alpha) in 0..1 rather than
 * as material. A hair is not more paper: it is a thread of the exposed core with light coming
 * through beside it, so the composite draws it in the core's colour over the background with
 * this alpha. Three families, matching what the macro photographs show:
 *
 *   fringe A, B — DENSE and short (1-4 px), along the ENTIRE contour: two ridge lattices at the
 *                 hair spacing, offset from each other, so hairs land every couple of pixels but
 *                 never on a regular comb. Each hair leaves the contour along the outward
 *                 normal with a slight lean, partly transparent, lighter than the sheet.
 *   strands     — a few much longer hairs, rare and widely spaced, on a lattice fourteen times
 *                 coarser.
 *
 * Each hair's identity is looked up at the FOOT of the perpendicular from this point to the
 * contour, and the lookup is a 2D noise sampled AT that foot point. Both halves of that matter:
 *
 *   - Projecting to the foot is what keeps a hair attached. The only thing that varies as you
 *     walk outward is then the length taper, which decays monotonically, so a hair can never
 *     reappear past a gap. Sampling at the fragment itself let the ridge rise again further
 *     out and left detached tufts scattered along the edge like dirt.
 *   - Sampling the foot as a 2D POINT, rather than as its distance along the contour, is what
 *     survives a corner. With a 1D arc-length parameter the tangent swings through 90 degrees
 *     over a couple of pixels of contour, the parameter races, and every convex tip of the
 *     scrap fired off a twenty-ray sunburst like a dandelion clock. A 2D lookup at a corner is
 *     very nearly constant, which is what a real corner does: one blunt tuft.
 *
 * The lean is applied by sliding the foot along the tangent in proportion to the distance out,
 * so the same crest is found a little further along the contour the further out we look — a
 * straight hair leaning over, still rooted where it started.
 *
 * Hair width is held to about one reference pixel and never below one RENDERED pixel: a hair
 * thinner than a pixel is a shimmer at thumbnail size. When the width has to be raised to the
 * pixel the alpha is lowered by the same ratio, so the fringe integrates to the same coverage
 * and a thumbnail gets a soft haze where the hero gets hairs — which is what a fuzzy edge
 * looks like from far away.
 */
float hairFamily(vec2 q, float S, float t, float len, float w, float wantW, float lenPow) {
  // A hair is the crest of a ridged noise along the contour: 1 - |2n - 1| peaks in a sharp cusp
  // wherever n crosses one half — about every other cell, irregularly. Smooth value noise moves
  // by roughly half its range per cell, so a crest of width w spans about w / (2 S) of the
  // ridge's unit range.
  float ridge = 1.0 - abs(2.0 * noiseSmooth(q) - 1.0);
  float thr = clamp(w / (2.0 * S), 0.04, 1.0);
  float hair = smoothstep(1.0 - thr * 1.3, 1.0 - thr * 0.5, ridge);
  // Per-hair length and opacity from two more lattices at the same spacing.
  float lenN = noiseSmooth(q + 71.3);
  float L = len * mix(0.3, 1.0, pow(lenN, lenPow));
  float tip = 1.0 - smoothstep(L * 0.45, L, t);
  float alphaN = 0.35 + 0.45 * noiseSmooth(q * 0.7 + 13.7);
  return hair * (wantW / w) * tip * alphaN;
}

float fringeTerm(vec2 pPx, float shaped, float chewed, vec2 g, float k) {
  float dens = uFiberDens * k;
  float len = uFiberLen * k;
  float strandLen = len * STRAND_MULT;
  // t: distance outward from the TRUE contour (with the teeth), so a hair roots exactly on it.
  float t = -chewed;
  if (dens <= 0.0 || len <= 0.0 || t < -uAaPx || t > strandLen * 1.05) return 0.0;
  vec2 tang = vec2(-g.y, g.x);
  // Identity foot from the field WITHOUT the teeth, so it does not jitter tooth by tooth.
  vec2 foot0 = pPx - g * shaped + uSeed * 37.0;
  float S = FRINGE_SPACING * uPxScale;
  // Per-hair lean: coherent over a few hairs, so neighbours lean roughly together like combed
  // fibre rather than crossing each other.
  float tiltN = noiseSmooth(foot0 / (S * 3.5) + 41.0) - 0.5;
  vec2 foot = foot0 + tang * max(t, 0.0) * tiltN * 1.1;
  float wantW = FRINGE_WIDTH * uPxScale;
  float w = max(wantW, uAaPx);

  float fringe = 0.0;
  if (t <= len * 1.05) {
    float a = hairFamily(foot / S, S, t, len, w, wantW, 2.0);
    float b = hairFamily(rot2(foot, 0.9) / S + 200.0, S, t, len, w, wantW, 2.0);
    fringe = max(a, b);
  }
  // The strands: one lattice, fourteen hair spacings coarse, on the uncombed foot (a long hair
  // that leaned would sweep across its neighbours). Kept to the same width; longer, fainter.
  float strand = hairFamily(foot0 / (S * 14.0) + 21.0, S * 14.0, t, strandLen, w, wantW, 1.0) * 0.8;

  // Density: a slow clump lattice decides which stretches of the contour carry hair, and the
  // knob moves the threshold. At 1 the fringe is (nearly) continuous, at 0.5 patchy.
  float clump = noiseSmooth(foot0 / (45.0 * uPxScale) + 5.0);
  float present = smoothstep(0.78 - dens * 0.78, 0.98 - dens * 0.78, clump);
  return max(fringe, strand) * present;
}

/**
 * The full paper field, plus the things the composite wants out of the same taps: the fringe
 * coverage (drawn as translucent hair in the core colour) and which way the contour faces
 * (nrm). They are out parameters rather than separate calls because edgeNormal costs four
 * scrapBase taps, and the deckle band, the fibers and the tear shadow all need that answer.
 */
float paperField(vec2 uv, out float fringe, out vec2 nrm) {
  float base = scrapBase(uv);
  vec2 angDir;
  float baseAng = baseAngular(uv, base, angDir);
  // The fibers are anchored to the field WITHOUT the teeth but WITH the tear — that is the
  // contour they actually grow from. Anchoring them to the noise-free base instead put strands
  // wherever the base contour happened to run, which after a 42 px tear displacement is often
  // deep inside the paper (invisible) or out in open space (a detached streak). That was where
  // the last of the floating debris came from.
  float shaped;
  float chewed = tearOf(uv, base, baseAng, shaped);

  nrm = vec2(0.0, 1.0);
  fringe = 0.0;
  // edgeNormal is four more scrapBase taps, i.e. eight texture fetches, and the only things
  // that want it — the fibers, the deckle band, the tear shadow — live within a band of the
  // contour. Paying for it over the whole canvas cost about a millisecond a pose for nothing.
  // Only textureLod is used underneath, so this is safe under non-uniform control flow.
  //
  // The outer test is uEdgeFinish, and it is a separate, UNIFORM branch rather than a '&&' with
  // the band test (design 2026-09-05 §6): under 'edgeFinish: 'clean'' there is no fringe, no
  // band and no tear shadow, so the whole frame — four extra scrapBase taps and the reach that
  // bounds them — is skipped for every fragment at once, and every line that touches a finish
  // decoration provably sits under a uEdgeFinish test.
  float k = edgeDetailK();
  if (uEdgeFinish == 1) {
    float reach = max(uFiberLen * STRAND_MULT * k, (uDeckleWidth * k) * 3.0) + 4.0;
    if (abs(shaped) < reach) {
      // The smooth field's normal, tilted toward the run's own direction by the angular blend, so
      // the frame follows the polyline rather than the garment underneath it.
      vec2 nS = edgeNormal(uv);
      float ang = uTearAngular * edgeK();
      vec2 n = (ang > 0.0 && dot(angDir, angDir) > 0.5) ? normalize(mix(nS, angDir, ang)) : nS;
      nrm = n;
      vec2 pPx = uv * vec2(uAspect, 1.0) * uPlanePx;
      fringe = fringeTerm(pPx, shaped, chewed, n, k);
    }
  }
  return chewed;
}

/**
 * The cheap mask the fold loop uses. Twelve folds mean up to twelve of these per fragment
 * (twice over, counting the flap shadow), so it keeps the low octave — which decides the
 * shape — and drops the mid and high ones, which decide detail nobody can resolve through a
 * mirrored, rotated flap.
 */
float paperFieldFast(vec2 uv) {
  float base = scrapBase(uv);
  vec2 angDir;
  float baseAng = baseAngular(uv, base, angDir);
  vec2 nUv = uv * vec2(uAspect, 1.0);
  float low = tearLow(nUv);
  // Design 2026-09-05 §6.1 item 3: the looseness factor is gone here too, so the cheap mask and
  // the full field agree on the low octave's amplitude as they must.
  return baseAng + low * (uTearAmp * edgeK()) * noiseGate(base);
}

/** Reflection of p across the line dot(p,n) = c. */
vec2 reflectFold(vec2 p, vec3 fold) {
  return p - 2.0 * (dot(p, fold.xy) - fold.z) * fold.xy;
}

vec2 rotate(vec2 v, float angle) {
  float cs = cos(angle);
  float sn = sin(angle);
  return vec2(v.x * cs - v.y * sn, v.x * sn + v.y * cs);
}

/**
 * True when q was still part of the sheet when fold at that index was made.
 *
 * The slack matters here too, and for a different reason than in survivesAfter. Each fold in
 * this model mirrors the base sheet; a real fold lifts the whole stack, flaps included. Letting
 * a later fold source a little material from what earlier folds already moved is the cheapest
 * stand-in for that, and it is what closes the last gaps of bare artwork in the finished ball.
 */
bool survivesBefore(vec2 q, int before, float slack) {
  for (int j = 0; j < MAX_FOLDS; j++) {
    if (j >= before) break;
    if (dot(q, uFolds[j].xy) - uFolds[j].z > slack) return false;
  }
  return true;
}

/**
 * True when a flap that landed at step 'after' is still there once the later folds have been
 * made — with slack.
 *
 * The slack is the second half of what turns folding into crumpling. A stack of paper does
 * not fold along one shared line: the upper layers bunch and overhang the ones beneath. Give
 * each layer a little room past every subsequent fold line and its mirrored torn edge pokes
 * out beyond the ball's flat facets, which is exactly the jutting corners in the reference.
 * With slack at zero every flap is clipped exactly and the silhouette is a clean polygon.
 */
bool survivesAfter(vec2 p, int after, float slack) {
  for (int j = 0; j < MAX_FOLDS; j++) {
    if (j >= uFoldCount) break;
    if (j <= after) continue;
    if (dot(p, uFolds[j].xy) - uFolds[j].z > slack) return false;
  }
  return true;
}

/** Deterministic per-layer value in [0,1]. */
float layerHash(int i) {
  return fract(sin(float(i) * 12.9898 + 4.1414) * 43758.5453);
}

/** How far past the fold polygon p sits. <= 0 is inside the core of the ball. */
float polyOver(vec2 p) {
  float over = -1e9;
  for (int j = 0; j < MAX_FOLDS; j++) {
    if (j >= uFoldCount) break;
    over = max(over, dot(p, uFolds[j].xy) - uFolds[j].z);
  }
  return over;
}

/**
 * The same polygon with its corners rounded off by r.
 *
 * A ball of crumpled paper is ROUND. The fold model's intersection of half-planes is not: it is
 * a convex polygon with hard vertices and long straight sides, and using it directly as the
 * ball's outline is most of why the finished pose reads as a broken tile rather than as
 * something that has been screwed up in a fist. Offsetting it per cell adds lumps but cannot
 * remove a 200 px straight edge.
 *
 * The standard rounded-convex trick: push every half-plane out by r, take the Euclidean norm of
 * the positive parts instead of their max, and pull the result back in by r. Away from a corner
 * exactly one term is positive and this is identical to polyOver; at a corner two are, and the
 * norm traces a quarter-circle of radius r between the two edges.
 */
float polyRound(vec2 p, float r) {
  float over = -1e9;
  float acc = 0.0;
  for (int j = 0; j < MAX_FOLDS; j++) {
    if (j >= uFoldCount) break;
    float d = dot(p, uFolds[j].xy) - uFolds[j].z + r;
    over = max(over, d);
    float p0 = max(d, 0.0);
    acc += p0 * p0;
  }
  return (over > 0.0 ? sqrt(acc) : over) - r;
}

/**
 * Coverage by the topmost flap at plane point p, plus how many flaps are stacked here.
 *
 * The forward map for fold i is: mirror across the line, then rotate by uFoldJitter[i] about
 * the line's closest point to the origin. That rotation is why this reads as crumpling
 * rather than folding: an exact mirror always lands a flap inside the previous silhouette,
 * so nothing can ever stick out, whereas a few degrees of slop makes flaps overshoot and
 * poke out as the sharp points the reference is full of.
 *
 * So the test here inverts that map — unrotate, then mirror — and asks whether the source
 * point is real paper that had not already been folded away.
 */
float flapCoverage(vec2 p, out float creaseDist, out float layers, out vec2 facetN, out int top) {
  creaseDist = 1e9;
  layers = 0.0;
  facetN = vec2(0.0);
  top = -1;
  float cover = 0.0;

  // How generous the source tests are, graded by depth into the ball.
  //
  // Deep inside, be generous: the body of a crumpled ball is a stack many layers thick and is
  // never see-through, but this shader only ever mirrors the base sheet, so strict tests leave
  // transparent gaps wherever a mirrored torn edge happens to land. Out in the overhang band,
  // be strict: that ragged mirrored contour IS the ball's spiky silhouette, and slack out
  // there fills the band into a clean polygon and throws the points away.
  float srcSlack = uSlack * 2.5 * (1.0 - smoothstep(-uSlack * 0.5, uSlack * 0.6, polyOver(p)));
  for (int i = MAX_FOLDS - 1; i >= 0; i--) {
    if (i >= uFoldCount) continue;
    // This layer's room to overhang the folds that came after it.
    if (!survivesAfter(p, i, uSlack * (0.3 + 0.7 * layerHash(i)))) continue;
    vec3 fold = uFolds[i];
    vec2 pivot = fold.xy * fold.z;
    vec2 q = reflectFold(pivot + rotate(p - pivot, -uFoldJitter[i]), fold);
    // The source must lie in the half that folded over, and must have survived until then.
    if (dot(q, fold.xy) - fold.z <= -srcSlack * 0.25) continue;
    if (!survivesBefore(q, i, srcSlack)) continue;
    // The flap's outer contour is the mirrored torn edge — ragged for free, softened by
    // exactly one rendered pixel so it does not alias.
    float c = smoothstep(-uAaPx, uAaPx, paperFieldFast(toUv(q)));
    if (c > 0.01) {
      layers += c;
      if (cover < 0.01) {
        cover = c;
        creaseDist = abs(dot(p, fold.xy) - fold.z) * uPlanePx;
        facetN = fold.xy;
        top = i;
      }
    }
  }
  return cover;
}

/**
 * One flat brightness per region, from the fold that produced it. The fold normal is read as
 * a facet slope and lit by a fixed direction — fake, flat, hard-edged, and exactly what turns
 * a pile of overlapping flaps into the reference's low-poly facet mosaic. Stacked layers
 * darken, which is what gives the ball its deep crevices.
 */
float facetShade(vec2 n, float layers) {
  vec3 normal = normalize(vec3(n * FACET_TILT, 1.0));
  vec3 light = normalize(vec3(uLightDir * 0.8, 0.62));
  float lambert = dot(normal, light) * 0.5 + 0.5;
  // NARROW. A flap in target-fold-mid.png is an almost uniform light plane with a soft gradient;
  // the old band (0.66-1.08 at the shipped strength) made adjacent flaps read as painted
  // facets. The darkness under the stack is left to the flap shadows now, so the depth term is
  // a small residual.
  float shade = mix(1.0 - uFacetStrength * 0.2, 1.0 + uFacetStrength * 0.05, lambert);
  shade *= 1.0 - uDepthDark * 0.6 * clamp((layers - 1.0) * 0.3, 0.0, 1.0);
  return max(shade, 0.05);
}

/**
 * Sub-facet crinkle: the fine crease network that covers every plate of a crushed sheet.
 *
 * This is the dominant material cue in reference/target-crumple-ball.png, and without it a facet
 * mosaic reads as moulded plastic however carefully its plates are shaded. The shape is specific:
 * SHORT straight segments meeting at vertices, which is a Voronoi boundary. A fine ridged noise
 * — the obvious cheap answer, and the one tried first — gives long parallel streaks that cross
 * the whole scrap and dash where the crest dips, and reads as machine stitching.
 *
 * Three things decide whether it reads as crumpled paper or as cracked mud, and the first two
 * were wrong in the first build:
 *
 *   - It must be ORIENTED PER PLATE. One global lattice covers the whole ball in equiaxed
 *     hexagons of identical size, which is craquelure — the reptile-skin look. Rotating and
 *     squashing the domain by a hash of the plate's own id gives every plate its own crinkle
 *     direction, and the discontinuity at the plate boundary is welcome: there is already a
 *     hard crease drawn there.
 *   - The primitive must be a LINE, not a cell boundary. Two rebuilds went into this. A Voronoi
 *     boundary set is a CLOSED tessellation: every cell is walled on every side, and a plate
 *     covered in closed rings reads as cracked mud, or — once the crests are shaded — as quilted
 *     leather. Thinning the boundaries by a per-boundary hash makes it sparser but not different
 *     in kind, because what survives is still arcs of rings. Real creases are straight lines that
 *     CROSS a plate and cross each other, so the primitive is a thresholded ridged noise: three
 *     families at per-plate angles, with only the top of each ridge kept, which leaves three or
 *     four creases running right across a plate and plenty of undisturbed sheet between them.
 *   - It must be patchy on top of that: uniform coverage reads as a texture map laid over the
 *     ball rather than as damage done to it.
 *   - It is a change of TONE, not a set of lines. Anything strong enough to read as drawn
 *     linework is craquelure again, so the whole term lands at a few percent.
 *
 * The width comes from the uniforms for the same reason crumpleShade's does — the whole block
 * sits behind a non-uniform gate, so fwidth is illegal here.
 */
float crinkleLines(vec2 q, vec2 cell, float bw) {
  float ang = hash21(cell + 4.9) * 3.14159;
  float dens = 2.6 + 3.0 * hash21(cell + 8.3);
  vec2 base = rot2(q * dens + hash21(cell + 71.2) * 37.0, ang);
  // One rendered pixel measured in ridge height. A ridged value noise 1 - |2n - 1| moves at
  // roughly 2 per domain unit, and one rendered pixel is bw * dens of that domain.
  float u = max(2.0 * bw * dens, 1e-4);
  float acc = 0.0;
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    vec2 x = rot2(base, 1.02 * fk) * vec2(1.0, 0.42) + fk * 13.7;
    float r = 1.0 - abs(2.0 * noiseSmooth(x) - 1.0);
    // Only the very top of each ridge survives, which is what makes the creases SPARSE: a plate
    // carries three or four that run right across it, not a hatch over the whole of it.
    float crest = smoothstep(1.0 - 3.0 * u, 1.0 - 0.8 * u, r);
    float shoulder = smoothstep(1.0 - 9.0 * u, 1.0 - 3.0 * u, r);
    acc += crest - (shoulder - crest) * 0.5;
  }
  float smoothPatch = smoothstep(0.30, 0.72, noiseSmooth(q * 1.7 + 61.0));
  return acc * (0.35 + 0.65 * smoothPatch) * 0.45;
}

/**
 * The lobe field: a smooth low-frequency height over the ball, about one lobe per three cells.
 *
 * This is the fix for the deepest of the mosaic problems. A random normal per cell is
 * UNCORRELATED with its neighbours, so nothing in the image says there is one body under the
 * plates: the mosaic renders as separate pieces lying next to each other however well each one
 * is shaded. Sampling a shared smooth field at each facet own centroid makes neighbouring
 * plates take neighbouring values, so the tone FLOWS across the ball, quantised per facet,
 * which is what a faceted continuous surface looks like.
 */
float lobeHeight(vec2 c) { return noiseSmooth(c * 0.34 + 7.0); }

/**
 * The mass octave, about one lump per seven cells — two or three across the whole ball.
 *
 * This is what a crumpled ball is at the largest scale: a cluster of big lumps with real gulfs
 * between them, not a convex blob with a wobble on it. It exists because DEPTH OF A GULF IS
 * BOUGHT WITH WAVELENGTH, NOT AMPLITUDE. The connectivity budget for a continuous offset on a
 * unit-gradient distance field is a slope, and for a smoothstep-interpolated noise of wavelength
 * L and unit range the peak slope of an offset of amplitude A is about 3A/L, so staying under it
 * means A <~ L/4. The three-cell lobe therefore affords about 0.8 of a cell and no more — which
 * is what the outline was already using — while a seven-cell mass affords 1.8, and that is the
 * difference between a dimple and a gulf.
 */
float massHeight(vec2 c) { return noiseSmooth(c * 0.17 + 47.0); }

vec2 massGrad(vec2 c) {
  float e = 1.2;
  float h0 = massHeight(c);
  return vec2(massHeight(c + vec2(e, 0.0)) - h0, massHeight(c + vec2(0.0, e)) - h0) / e;
}

vec2 lobeGrad(vec2 c) {
  float e = 0.35;
  float h0 = lobeHeight(c);
  return vec2(lobeHeight(c + vec2(e, 0.0)) - h0, lobeHeight(c + vec2(0.0, e)) - h0) / e;
}

/**
 * Shared crease lines: long straight folds that tip the sheet one way on one side of the line
 * and the other way on the other.
 *
 * A Voronoi boundary SEPARATES two cells. A fold in a sheet is something two facets BOTH belong
 * to, and the optical signature of that is a tone step that stays coherent along the whole line
 * and continues collinearly through a vertex. A chain of bisectors can do neither. These lines
 * cut straight across the mosaic and are what the long edges in the reference actually are.
 *
 * This is not the rejected "use more fold lines" option: nothing here occludes or cuts anything,
 * the lines only tilt the shading normal. They ARE the pose own fold lines, which is free and
 * makes the last step of the sequence more continuous still, because the creases of pose 4 stay
 * the creases of pose 5.
 *
 * The step across a line is antialiased over about a rendered pixel, derived from the uniforms:
 * the whole crumple block sits behind a non-uniform gate, so fwidth is illegal here.
 */
vec2 creaseTilt(vec2 p) {
  vec2 tilt = vec2(0.0);
  float aa = max(uAaPx / uPlanePx, 1e-5);
  for (int i = 0; i < MAX_FOLDS; i++) {
    if (i >= uFoldCount) break;
    vec3 L = uFolds[i];
    float side = clamp((dot(p, L.xy) - L.z) / (aa * 1.6), -1.0, 1.0);
    // The ridge dies out along its own length, so a fold is a feature of part of the ball
    // rather than a stripe across the whole of it.
    float along = dot(p, vec2(-L.y, L.x));
    float mid = (hash21(vec2(float(i), 3.0)) - 0.5) * 0.5;
    float rate = (2.6 + 3.4 * hash21(vec2(float(i), 9.0))) * uCrumpleCells * 0.10;
    float t = (along - mid) * rate;
    float env = exp2(-t * t);
    // Signed, so the set is a mix of mountain folds and valley folds.
    float amp = (hash21(vec2(float(i), 17.0)) * 2.0 - 1.0) * 0.62;
    tilt += side * amp * L.xy * env;
  }
  return tilt;
}

// ---------------------------------------------------------------------------------------------
// Phase C: the ball as a sheet of PLATES.
//
// The Phase A/B mosaic was a flat Voronoi with an invented normal per cell, and the finding
// was that it rendered pieces lying next to each other. What the reference shows is one sheet
// with large flat-ish plates (a quarter to a third of the ball radius), some of them broken
// into two to four sub-plates, meeting along boundaries that are HARD in half the cases (a
// sharp crease with a thin dark valley) and SOFT in the other half (the normal turns over a
// few px and no line is drawn). The darkness lives in the valleys and under overhanging plates,
// the albedo is near white, and the silhouette is polygonal: rim plates stick out or sit back,
// with sharp corners where two of them meet.
//
// Plates live in PLANE units (uCrumpleCells per unit), so they do not move between poses; the
// outline lives in the ball frame (uBallR) and is a function of angle only, which is what keeps
// the finished ball one connected blob with no holes whatever the per-plate offsets do.
// ---------------------------------------------------------------------------------------------

const float PLATE_ANISO = 0.86;   // constant linear squash of the plate lattice, 1.16:1
const float PLATE_ROT = 0.55;
const float PLATE_JIT = 0.45;     // per-plate random tilt on top of the shared body curvature
const float SUB_FRACTION = 0.4;   // share of plates broken into sub-plates
const float SUB_FREQ = 1.7;       // sub-plate lattice, in parent cells: two to four sub-plates
const float SUB_DEV = 0.16;       // sub-plate tilt deviation from the parent
const float BALL_AX = 1.1;        // ball frame aspect: the finished ball is not a circle

/** Plane -> plate lattice. One constant linear map plus a warp well under a third of a cell. */
vec2 plateDomain(vec2 p) {
  vec2 q = rot2(p, PLATE_ROT);
  q.y *= PLATE_ANISO;
  q = rot2(q, -PLATE_ROT) * uCrumpleCells;
  vec2 w = vec2(noiseSmooth(q * 0.23 + 4.0), noiseSmooth(q * 0.21 + 19.0)) - 0.5;
  return q + w * 0.4;
}

/** Lattice -> plane, ignoring the warp. Only used to find which way a rim plate faces. */
vec2 plateToPlane(vec2 q) {
  vec2 r = rot2(q / max(uCrumpleCells, 1e-3), PLATE_ROT);
  r.y /= PLATE_ANISO;
  return rot2(r, -PLATE_ROT);
}

vec2 seedOf(vec2 cell, float salt) {
  return cell + vec2(hash21(cell + salt), hash21(cell + salt + vec2(37.0, 17.0)));
}

/** Nearest and second-nearest seeds. F2 - F1 is twice the distance to the cell boundary. */
void voronoi2(vec2 q, float salt, out vec2 c1, out vec2 c2, out float f1, out float f2) {
  vec2 cell = floor(q);
  vec2 f = fract(q);
  c1 = cell;
  c2 = cell;
  f1 = 1e9;
  f2 = 1e9;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 s = vec2(hash21(cell + g + salt), hash21(cell + g + salt + vec2(37.0, 17.0)));
      float d = length(g + s - f);
      if (d < f1) { f2 = f1; c2 = c1; f1 = d; c1 = cell + g; }
      else if (d < f2) { f2 = d; c2 = cell + g; }
    }
  }
}

/** A hash of an UNORDERED pair of cells, so both sides of a boundary agree on its character. */
float pairHash(vec2 a, vec2 b, float salt) {
  return hash21((a + b) * 3.1 + abs(a - b) * 1.7 + salt);
}

/**
 * The tilt of one plate: the shared body curvature sampled at the plate's own seed, plus a
 * seeded random. The shared part is what keeps neighbouring plates reading as one surface; the
 * random part is what makes them plates rather than a smooth dome.
 */
vec2 plateTilt(vec2 cell, float salt) {
  vec2 s = seedOf(cell, salt);
  vec2 low = massGrad(s) * 1.6 + lobeGrad(s) * 0.6;
  vec2 rnd = (vec2(hash21(cell + salt + 3.7), hash21(cell + salt + 91.3)) - 0.5) * 2.0 * PLATE_JIT;
  return low + rnd;
}

// The ball frame: centred, rotated by the seed, squashed to BALL_AX, in units of uBallR.
float ballRot() { return uSeed * 0.9; }
vec2 toBall(vec2 p) {
  vec2 b = rot2(p, ballRot()) * vec2(1.0 / BALL_AX, BALL_AX);
  return b / max(uBallR, 1e-4);
}
vec2 fromBall(vec2 b) {
  return rot2(b * uBallR * vec2(BALL_AX, 1.0 / BALL_AX), -ballRot());
}

/**
 * How far out one rim plate's side or corner sits ALONG THE RAY in direction dir: a convex corner
 * (two half-planes) whose vertex lies at distance R1 along the plate's direction s, opening by
 * half-angle phi; phi = 0 is a flat side. The ray always meets the corner because s is held
 * within 45 degrees of dir, so the denominator is safely positive.
 */
float cornerR(vec2 dir, vec2 s, float R1, float phi) {
  vec2 n1 = rot2(s, phi);
  vec2 n2 = rot2(s, -phi);
  return R1 * cos(phi) / max(max(dot(dir, n1), dot(dir, n2)), 0.3);
}

float plateBite(vec2 cell, float amp) { return (hash21(cell + 55.0) - 0.5) * 2.0 * amp; }

/**
 * The ball's outline, in ball units, negative inside: |b| minus an outline RADIUS that is a
 * function of the angle alone.
 *
 * That form is the whole guarantee. Whatever the radius does around the circle — steps between
 * plates, corners, notches, a lump — the region {|b| < r(angle)} is star-shaped from the centre,
 * i.e. ONE component and NO holes, and its antialiased edge has a unit gradient. The Phase A
 * shell was a step on a per-cell constant offset and threw isolated pixels for lack of this;
 * blending two plates' chord DISTANCES (the first Phase C attempt) let the average dip inside
 * along a bisector where neither chord did, and grew 1 px hairs off the rim.
 *
 * The plate that owns a direction is the one the lattice puts at the rim in that direction —
 * see rimRadius for the lookup and its soft blend between plates, which is what keeps the step
 * between two rim plates a short slanted edge rather than a radial cliff, and keeps a sliver of a
 * third cell grazing the rim from reaching its own full offset.
 */
/**
 * The outline radius the rim plates around lattice point q put on the ray dir, as a SOFT-MIN over
 * the nine neighbouring cells: every cell's side or corner weighted by exp(-(F - F1) / sigma).
 * Away from a boundary that is the nearest plate's radius exactly; within ~0.15 cell of one it
 * blends to the neighbour's, and at a Voronoi vertex all three blend — which is the case the
 * two-plate blend could not handle: the SECOND-nearest plate switches there and the outline
 * jumped, leaving one pixel of a 1 px spike behind on the jeans. The V notch on some boundaries
 * fades out toward a vertex for the same reason (F3 - F2 -> 0).
 */
float rimRadius(vec2 q, vec2 dir, float amp, float reach) {
  vec2 cell = floor(q);
  vec2 f = fract(q);
  float ds[9];
  float rs[9];
  float f1 = 1e9;
  float f2 = 1e9;
  float f3 = 1e9;
  vec2 c1 = cell;
  vec2 c2 = cell;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 c = cell + g;
      vec2 sd = vec2(hash21(c), hash21(c + vec2(37.0, 17.0)));
      float d = length(g + sd - f);
      if (d < f1) { f3 = f2; f2 = f1; c2 = c1; f1 = d; c1 = c; }
      else if (d < f2) { f3 = f2; f2 = d; c2 = c; }
      else if (d < f3) { f3 = d; }
      // About half the rim plates are flat sides, the rest are corners that poke out. The
      // corners stay blunt (under 32 degrees of half-angle): a sharper corner recedes too far
      // at its sector's edges and its neighbours stand out of the ball as needles.
      float kc = hash21(c + 66.0);
      float phi = kc < 0.45 ? 0.0 : mix(0.15, 0.55, (kc - 0.45) / 0.55);
      vec2 sc = toBall(plateToPlane(c + sd));
      sc = (dot(sc, sc) > 1e-6) ? normalize(sc) : dir;
      // A plate that sits well off its direction would let its side swing far out at the
      // sector's edge; hold the direction within 45 degrees of the sample ray.
      sc = normalize(mix(dir, sc, 0.5));
      int k = (j + 1) * 3 + (i + 1);
      ds[k] = d;
      // A side seen obliquely runs out to 1.5 R and more; capped at 12% over the plate's own
      // vertex radius, or a sliver of such a plate grazing the rim is a 1 px hair off the ball.
      float R1 = 1.0 + plateBite(c, amp);
      float rc = min(cornerR(dir, sc, R1, phi), R1 * 1.12);
      rs[k] = rc * reach + (1.0 - reach);
    }
  }
  // Weights RELATIVE to the nearest seed. With absolute weights every term is below 1e-6
  // whenever the nearest seed is more than ~0.8 cell away, a floor on the denominator then
  // replaced it, and the ratio collapsed toward zero — one pixel of hole on a radial line.
  const float SIGMA = 0.08;
  float num = 0.0;
  float den = 0.0;
  for (int k = 0; k < 9; k++) {
    float w = exp(-(ds[k] - f1) / SIGMA);
    num += w * rs[k];
    den += w;
  }
  float rOut = num / den;
  float key = pairHash(c1, c2, 23.0);
  if (key > 0.7) {
    // A rounded V: a sharp tip pinches to under a pixel and reads as a one-pixel hole.
    rOut -= (0.035 + 0.05 * fract(key * 9.0)) * reach * (1.0 - smoothstep(0.0, 0.35, f2 - f1)) *
            smoothstep(0.0, 0.15, f3 - f2);
  }
  return rOut;
}

/** The outline radius in one direction: two rim lookups (see outlineD) plus the slow lump. */
float outlineR(vec2 dir, float amp, float reach) {
  // Once at radius 1 to learn how far out the outline sits in this direction, then again AT that
  // radius (continuous in the angle) so the outline's corners fall on the boundaries the shading
  // draws there. The first lookup is per tap on purpose: shared between the three taps, its own
  // step between two plates moved all three second lookups at once and the trench grew a speck.
  float r1 = rimRadius(plateDomain(fromBall(dir)), dir, amp, reach);
  float rOut = rimRadius(plateDomain(fromBall(dir * clamp(r1, 0.7, 1.3))), dir, amp, reach);
  // A slow lump around the circle on top of the plates, so the ball is not a circle with plates
  // on it but a lumpy mass; a function of angle, like everything else here.
  rOut += (noiseSmooth(dir * 1.7 + uSeed * 0.3 + 5.0) - 0.5) * 0.14 * reach;
  return clamp(rOut, 0.7, 1.3);
}

float outlineD(vec2 b, float reach) {
  float r = length(b);
  vec2 dir = (r > 1e-5) ? b / r : vec2(1.0, 0.0);
  float amp = uCrumpleBite * reach;
  // Averaged over three directions one rendered pixel of arc apart. A star-shaped region is one
  // piece by construction, but its RASTER is not: a concave wedge or a convex tip narrower than
  // a pixel leaves a single pixel below the threshold with all four neighbours above it, or the
  // other way round, and the ball job counts those as a hole or a speck. Blurring the radius
  // over a pixel of angle leaves nothing narrower than that to sample.
  float dTheta = 1.2 * uAaPx / max(r * uBallR * uPlanePx, 1.0);
  float rOut = (outlineR(rot2(dir, -dTheta), amp, reach) + outlineR(dir, amp, reach) +
                outlineR(rot2(dir, dTheta), amp, reach)) / 3.0;
  return r - rOut;
}

/**
 * The plate shading, as a brightness FACTOR on the paper. A linear lambert over a narrow range,
 * and every bit of darkness reserved for the valleys: thin lines on hard creases, AO wedges
 * under overhanging plates (tapered along the boundary so they read as pockets rather than as
 * outlines), a faint terminator, and the fine crinkle and photographed tooth at low contrast.
 *
 * k is how far into the crumple the pose is (0 at pose 2, 1 at the ball) and it scales the
 * RELIEF, not an opacity: exactly 1.0 at k = 0, so the stacked flaps of the early poses are
 * flat paper, and the plates then come in as the sheet is crushed harder — tilt and the hard
 * creases first, the sub-plates and the AO pockets later. A cross-fade between a flat flap and
 * a finished plate was tried first and read as a watermark laid over the paper.
 */
float crumpleShade(vec2 p, vec2 q, vec2 b, float k) {
  float kTilt = mix(0.35, 1.0, k);
  float kLine = smoothstep(0.1, 0.8, k);
  float kSub = smoothstep(0.3, 1.0, k);
  float kAo = smoothstep(0.25, 1.0, k);
  vec3 light = normalize(vec3(uLightDir * 0.8, 0.62));
  float pxPerCell = uPlanePx / max(uCrumpleCells, 1e-3);
  float aaPx = max(uAaPx, 0.75);

  vec2 c1;
  vec2 c2;
  float f1;
  float f2;
  voronoi2(q, 0.0, c1, c2, f1, f2);
  float dC = 0.5 * (f2 - f1) * pxPerCell;
  vec2 t1 = plateTilt(c1, 0.0);
  float key = pairHash(c1, c2, 17.0);
  float keyB = pairHash(c1, c2, 43.0);
  float keyC = pairHash(c1, c2, 71.0);
  // The neighbour's tilt is six noise taps and is only wanted within reach of the boundary — the
  // widest soft fold or AO wedge is 14 px.
  bool nearEdge = dC < 14.0 * uPxScale;
  vec2 t2 = nearEdge ? plateTilt(c2, 0.0) : t1;
  float taper = nearEdge ? smoothstep(0.25, 0.7, noiseSmooth(q * 1.4 + keyB * 40.0)) : 0.0;

  vec2 tilt = t1;
  float line = 0.0;
  float ao = 0.0;
  vec2 cellId = c1;

  // Sub-plates: a finer lattice, offset per parent, whose cells inherit the parent's tilt plus a
  // small deviation. Its boundaries only count inside a subdivided parent — if the fine bisector
  // were outside the parent the coarse boundary would be nearer and take over below.
  if (kSub > 0.001 && hash21(c1 + 9.1) < SUB_FRACTION) {
    vec2 qf = q * SUB_FREQ + hash21(c1 + 2.2) * 11.0;
    vec2 g1;
    vec2 g2;
    float h1;
    float h2;
    voronoi2(qf, 5.0, g1, g2, h1, h2);
    float dF = 0.5 * (h2 - h1) * pxPerCell / SUB_FREQ;
    vec2 salt = c1 * 0.37;
    vec2 dev1 = (vec2(hash21(g1 + salt + 1.3), hash21(g1 + salt + 8.9)) - 0.5) * 2.0 * SUB_DEV;
    vec2 dev2 = (vec2(hash21(g2 + salt + 1.3), hash21(g2 + salt + 8.9)) - 0.5) * 2.0 * SUB_DEV;
    float skey = pairHash(g1, g2, 29.0);
    dev1 *= kSub;
    dev2 *= kSub;
    if (skey < 0.5) {
      float w = mix(6.0, 12.0, fract(skey * 7.0)) * uPxScale;
      tilt = t1 + mix(0.5 * (dev1 + dev2), dev1, smoothstep(0.0, w, dF));
    } else {
      tilt = t1 + dev1;
      float lw = max(1.2 * uPxScale, aaPx);
      line = (1.0 - smoothstep(0.0, lw, dF)) * (0.15 + 0.3 * fract(skey * 13.0)) *
             clamp(length(dev1 - dev2) * 3.0, 0.3, 1.0) * kSub;
      float lower = hash21(g2 + salt + 77.0) - hash21(g1 + salt + 77.0);
      if (lower > 0.0) {
        float aw = mix(4.0, 9.0, fract(skey * 5.0)) * uPxScale;
        ao = (1.0 - smoothstep(0.0, aw, dF)) * lower * 0.7 * taper * kSub;
      }
    }
    cellId = c1 * 3.0 + g1 * 0.5 + 100.0;
  }

  // The coarse boundary. Soft: the normal turns over 6-12 px and nothing is drawn. Hard: a sharp
  // break, a thin valley line, and an AO wedge on whichever side the pair hash puts underneath.
  if (key < 0.55) {
    float w = mix(6.0, 12.0, keyB) * uPxScale;
    tilt = mix(0.5 * (tilt + t2), tilt, smoothstep(0.0, w, dC));
  } else {
    float lw = max(1.4 * uPxScale, aaPx);
    float angle = clamp(length(t1 - t2) * 1.6, 0.35, 1.0);
    line = max(line, (1.0 - smoothstep(0.0, lw, dC)) * (0.35 + 0.5 * keyB) * angle * kLine);
    float lower = hash21(c2 + 77.0) - hash21(c1 + 77.0);
    if (lower > 0.0) {
      float aw = mix(8.0, 20.0, keyC) * uPxScale;
      ao = max(ao, (1.0 - smoothstep(0.0, aw, dC)) * lower * 1.2 * taper * kAo);
    }
  }
  // Near the rim, a plate that sits back sits UNDER the neighbour that sticks out: the same
  // offsets the outline is built from, read for the plate at p itself, so the wedge is continuous
  // in p (reading it off the rim lookup striped wherever a boundary ran along the rim).
  float rimK = smoothstep(0.5, 0.85, length(b));
  if (rimK > 0.0 && nearEdge) {
    float step = plateBite(c2, 1.0) - plateBite(c1, 1.0);
    if (step > 0.0) ao = max(ao, (1.0 - smoothstep(0.0, 14.0 * uPxScale, dC)) * step * 0.9 * rimK * kAo);
  }

  // The photographed crease network, in the ball frame, as a SUPPORTING normal only. At the
  // Phase B weight it was the whole relief and the surface read as foil.
  vec2 ballUv = b * 0.55 + 0.5;
  vec2 photoRG = vec2(texture(uCrumpleR, ballUv).r, texture(uCrumpleG, ballUv).r);
  vec2 photoTilt = (photoRG * 2.0 - 1.0) * uPhotoCrumple * 0.6 * k;
  // The pose's own fold lines keep tilting the sheet, so the creases of pose 4 stay the creases
  // of pose 5.
  vec2 fold = creaseTilt(p) * 0.6;
  vec3 n = normalize(vec3((tilt + fold) * FACET_TILT * kTilt + photoTilt, 1.0));
  // Relative to the flat sheet (flat is a reserved word, like patch), so the factor is exactly 1
  // where nothing tilts. The band sits BELOW 1: a plate facing the light reaches the paper's own
  // white and no further, everything else is a little darker, and the top is clamped — the lit
  // plates blew out to a white hole in the middle of the ball otherwise.
  float lam = (dot(n, light) - light.z) * 0.5;
  float shade = 1.0 + (-0.04 + lam * (0.5 + 0.6 * uFacetStrength)) * mix(0.15, 1.0, k);
  shade *= 1.0 - line * 0.65;
  shade *= 1.0 - clamp(ao, 0.0, 1.0) * (0.5 + 0.4 * uDepthDark);
  // A terminator, faint: the reference is a sheet crushed flat, not a sphere.
  float across = dot(b, -uLightDir);
  shade *= mix(1.0 + 0.01 * k, 1.0 - 0.05 * k, smoothstep(-1.0, 1.0, across));
  // Fine crinkle inside the plates, and the photograph's own tooth, both at low contrast.
  float bw = max(2.0 * uCrumpleCells * uAaPx / uPlanePx, 1e-4);
  shade *= 1.0 + crinkleLines(q, cellId, bw) * CRINKLE_AMT * k;
  shade *= 1.0 + (texture(uCrumpleA, ballUv).r - 0.5) * uPhotoCrumple * 0.25 * k;
  return clamp(shade, 0.05, 1.0);
}

/**
 * Crisp creases on the reverse. Fold j creases the layer on top here only if that layer was
 * already lying there when the fold was made (j > top) or it is the layer's own folded edge
 * (j == top); a flap that landed later covers the crease. At the line: a ~1 px bright crest on
 * the side the light reaches and a 1-2 px soft dark line on the other, both from the sign of
 * uLightDir against the fold normal, plus a faint line whatever the light does. Subtle on a
 * single flap, stronger as layers stack.
 */
float foldCreases(vec2 p, int top, float layers) {
  float m = 1.0;
  float w = max(uCreaseWidth, 1.0);
  float aa = max(uAaPx, 1.0);
  float strength = uCreaseDark * (0.6 + 0.4 * clamp((layers - 1.0) * 0.5, 0.0, 1.0));
  for (int j = 0; j < MAX_FOLDS; j++) {
    if (j >= uFoldCount) break;
    if (j < top) continue;
    vec3 L = uFolds[j];
    float t = -(dot(p, L.xy) - L.z) * uPlanePx;
    if (t < -aa || t > w + 2.0 * aa) continue;
    float lit = dot(L.xy, uLightDir);
    float edge = 1.0 - smoothstep(0.0, aa, abs(t - 0.5 * aa));
    float inner = smoothstep(0.0, aa, t - 0.5 * aa) * (1.0 - smoothstep(aa, w + aa, t));
    float crest = (lit > 0.0) ? edge * lit : inner * (-lit) * 0.5;
    float dark = (lit > 0.0) ? inner * lit : edge * (-lit);
    m *= (1.0 + crest * 0.22 * strength) * (1.0 - (dark + edge * 0.3) * 0.5 * strength);
  }
  return m;
}

/**
 * Soft coverage of one flap at pp, every edge widened to a penumbra: the later fold lines that
 * cut it (with its slack), the source half-plane, the earlier cuts its source mirrors, and the
 * mirrored sheet contour. Product of the terms, so a corner is soft on both sides.
 */
float softLayer(int i, vec2 pp, float pen, float penPx, float srcSlack) {
  float cov = 1.0;
  float sl = uSlack * (0.3 + 0.7 * layerHash(i));
  for (int j = 0; j < MAX_FOLDS; j++) {
    if (j >= uFoldCount) break;
    if (j <= i) continue;
    cov *= 1.0 - smoothstep(-pen, pen, dot(pp, uFolds[j].xy) - uFolds[j].z - sl);
  }
  if (cov < 0.01) return 0.0;
  vec3 fold = uFolds[i];
  vec2 pivot = fold.xy * fold.z;
  vec2 q = reflectFold(pivot + rotate(pp - pivot, -uFoldJitter[i]), fold);
  cov *= smoothstep(-pen, pen, dot(q, fold.xy) - fold.z + srcSlack * 0.25);
  for (int j = 0; j < MAX_FOLDS; j++) {
    if (j >= i) break;
    cov *= 1.0 - smoothstep(-pen, pen, dot(q, uFolds[j].xy) - uFolds[j].z - srcSlack);
  }
  if (cov < 0.01) return 0.0;
  return cov * smoothstep(-penPx, penPx, paperFieldFast(toUv(q)));
}

/**
 * The shadow the flaps above the visible layer throw onto it. A flap high in the stack is
 * further from what lies beneath, so its shadow is offset further and its penumbra is wider —
 * about 2 px at the first fold, 8 px deep in the stack. Union over the layers above the visible one (top).
 */
float flapShadowAt(vec2 p, int top) {
  float sh = 0.0;
  vec2 dir = vec2(-uShadowOffset.x * uAspect, -uShadowOffset.y);
  dir = (dot(dir, dir) > 1e-12) ? normalize(dir) : vec2(0.7, -0.7);
  // The source slack flapCoverage grades by depth into the ball, taken once at p rather than
  // once per layer at the offset point: the offsets are under 9 px and this was twelve dot
  // products per layer.
  float srcSlack = uSlack * 2.5 * (1.0 - smoothstep(-uSlack * 0.5, uSlack * 0.6, polyOver(p)));
  for (int i = MAX_FOLDS - 1; i >= 0; i--) {
    if (i >= uFoldCount || i <= top) continue;
    float depth = float(i) / float(MAX_FOLDS - 1);
    float offPx = mix(3.0, 9.0, depth) * uPxScale;
    float penPx = mix(2.0, 8.0, depth) * uPxScale;
    vec2 pp = p + dir * offPx / uPlanePx;
    sh = max(sh, softLayer(i, pp, penPx / uPlanePx, penPx, srcSlack));
    if (sh > 0.99) break;
  }
  return sh;
}

/**
 * Signed crease network: straight ridge lines across the face of a sheet.
 *
 * The domain is strongly ANISOTROPIC, which is the whole trick. Isotropic ridged noise has
 * curved crests, and broad curved arcs across a sheet read as smudges rather than as creases.
 * Compressing one axis ~12x makes the noise vary quickly across a crease and slowly along it,
 * so its crests run nearly straight for a long way. Three families at unrelated angles, so it
 * does not read as hatching.
 *
 * The return is SIGNED, and that is what makes it read as paper rather than as scratches. A
 * real crease is a bright folded crest with the sheet falling away into shadow on either side
 * of it; a purely additive term is a network of white lines drawn on a flat surface. The narrow
 * core is the crest and the wider halo minus that core is the shoulder, at 0.6 of the weight.
 *
 * Widths are normalised by each ridge's own screen-space gradient, so every crease comes out
 * about the same rendered width wherever the underlying noise happens to be steep or flat. A
 * fixed threshold leaves broad pale bands where the noise is flat, and those are smudges again.
 * fwidth is legal here only because every call site is under uniform control flow.
 */
float creaseNet(vec2 nUv, float scale, float seed) {
  vec2 c1 = rot2(nUv, 0.42) * vec2(9.5, 0.8) * scale + seed;
  vec2 c2 = rot2(nUv, 1.71) * vec2(12.0, 0.7) * scale + seed * 2.0;
  vec2 c3 = rot2(nUv, -0.95) * vec2(7.6, 0.9) * scale + seed * 3.0;
  float w1 = 1.0 - abs(2.0 * noiseSmooth(c1) - 1.0);
  float w2 = 1.0 - abs(2.0 * noiseSmooth(c2) - 1.0);
  float w3 = 1.0 - abs(2.0 * noiseSmooth(c3) - 1.0);
  float g1 = max(fwidth(w1) * 1.1, 1e-5);
  float g2 = max(fwidth(w2) * 1.1, 1e-5);
  float g3 = max(fwidth(w3) * 1.1, 1e-5);
  float core = max(max(1.0 - smoothstep(0.0, g1, 1.0 - w1),
                       1.0 - smoothstep(0.0, g2, 1.0 - w2)),
                   1.0 - smoothstep(0.0, g3, 1.0 - w3));
  float halo = max(max(1.0 - smoothstep(0.0, g1 * 4.0, 1.0 - w1),
                       1.0 - smoothstep(0.0, g2 * 4.0, 1.0 - w2)),
                   1.0 - smoothstep(0.0, g3 * 4.0, 1.0 - w3));
  return core - (halo - core) * 0.6;
}

vec3 fieldViz(float d) {
  vec3 base = mix(vec3(0.85, 0.34, 0.26), vec3(0.32, 0.78, 0.55), step(0.0, d));
  base *= 0.5 + 0.5 * abs(sin(d * 0.22));
  base = mix(base, vec3(1.0), 1.0 - smoothstep(0.0, 1.6, abs(d)));
  return base;
}

// =============================================================================================
// P6a — the front build's early-outs.
//
// Two classes of fragment have an answer before paperField runs, and this block proves it from
// the code below rather than from the picture: the answer is identical to the full path's at the
// RGBA8 byte level the front is written in (and bit-identical wherever a step says so; the two
// places that are only ulp-identical under a lerp lowering of mix are called out). Everything
// here is uniform-only arithmetic plus the one or two field fetches a predicate needs. A fragment
// that fails a predicate simply takes the full path, so every threshold errs towards the full
// path.
//
// THE GUARD, frontFastPath(): uShadow == 0.0 (with uShadowBlur > 0.0, so the shadow term the
// full path multiplies by uShadow is a finite number — step 4 in main), uFoldCount == 0,
// uCrumpleFill == 0.0 and uDebug == 0: the uniforms paper-renderer.ts's renderFront fixes at the
// front build ('uniform1f(loc('shadow'), 0)', 'uniform1i(loc('foldCount'), 0)',
// 'uniform1f(loc('crumpleFill'), 0)', 'uniform1i(loc('debug'), 0)'). Reading main() top to
// bottom under them: the fold loop runs 0 times, so remaining = 1.0; flapPossible and
// shadowPossible are false, so flap = layers = 0.0, top = -1, flapShadow = 0.0;
// 'front *= 1.0 - 0.0 * 0.7 * 0.0' is 'front *= 1.0'; the crumple block is skipped
// ('uCrumpleFill > 0.0' is false), so bodyIn = 0.0, bodyOut = 1.0 and crumple = shell = body =
// 0.0; backAmt = 0.0; a = baseA = sheetCov; premul = back * 0.0 + front * sheetCov * 1.0, where
// back is finite (facetShade normalises (0, 0, 1); foldCreases returns 1.0 at uFoldCount 0);
// 'a *= 1.0', 'premul *= 1.0'; sa = 0.0 (step 4); outA = sheetCov; rgb = premul / outA when
// outA > 1e-4, else vec3(0.0); and uDebug == 0 writes vec4(rgb, outA).
// At uShadowBlur == 0.0 — the shadowBlur knob's minimum — the guard is false and the early-outs
// are disabled: a performance cliff on that one setting, not a correctness one.
//
// (a) DEEP INSIDE — img.a == 1.0 and deepInside(uv). With img.a == 1.0 (255 / 255.0 exactly):
//   - sheetCov = max(paperMask, 1.0) = 1.0: paperMask = sheetA + fringe * (1.0 - sheetA) lies in
//     [0, 1], because smoothstep's t*t*(3-2t) at t <= 1 rounds to at most 1.0 and fringeTerm is a
//     product of coverages in [0, 1];
//   - front = mix(sheet, img.rgb, 1.0) = sheet * 0.0 + img.rgb * 1.0 = img.rgb under the spec's
//     definition of mix, and within an ulp of it under a lerp lowering (x + (y - x) * 1.0); sheet
//     is finite (every noise is a fract/dot of finite inputs, relief normalises a vector with
//     z = 1.0, tearShade is an exp of a non-positive number). An ulp does not survive the RGBA8
//     write: img.rgb is k / 255, and k / 255 within an ulp still quantises to the byte k;
//   - the premultiplied re-blend is skipped ('sheetCov < 1.0' is false);
//   - the deckle band's blend weight carries (1.0 - img.a) = 0.0, so front is unchanged (to the
//     same ulp under a lerp lowering, i.e. at the byte level) whether or not that branch runs
//     (core is finite: both smoothsteps in it have edge0 < edge1);
//   - the hair blend is the ONLY remaining write to front, and it runs only if fringe > 0.0.
//   So a = 1.0, premul = img.rgb, outA = 1.0, rgb = img.rgb / 1.0, and the full path writes
//   vec4(img.rgb, 1.0) — this early-out, identical at the RGBA8 byte level — unless fringe > 0.0
//   and sheetA < 1.0. Under uEdgeFinish == 0
//   paperField never enters the fringe block, so fringe = 0.0 outright. Under uEdgeFinish == 1
//   fringeTerm returns 0.0 whenever
//   't < -uAaPx' with t = -chewed, i.e. whenever chewed > uAaPx, and tearOf's last line makes
//   chewed = max(d, floorD) >= floorD = tearFloor(uv) exactly (max returns one of its operands).
//   deepInside() therefore asks tearFloor(uv) > uAaPx + one tight-field texel: the expression
//   the full path itself evaluates, plus a texel of margin for any contraction or reassociation
//   difference between the two call sites. There is no second shape for a polygon contour any
//   more: every cell goes through scrapBase, so deepInside is this one test in all four cells.
//   A texel with 0 < img.a < 1 never takes (a).
//
// (b) FAR OUTSIDE — img.a == 0.0 and farOutside(uv, aa). With img.a == 0.0: sheetCov =
//   max(paperMask, 0.0) = paperMask; front = mix(sheet, img.rgb, 0.0) = sheet, and the
//   premultiplied re-blend is skipped ('img.a > 0.0' is false). If paperMask == 0.0 then
//   a = 0.0, premul = back * 0.0 + front * 0.0 * 1.0 = 0.0, outA = 0.0, rgb = vec3(0.0) (the
//   'outA > 1e-4' test fails) and the full path writes vec4(0.0) — this early-out. paperMask
//   is 0.0 exactly when sheetA == 0.0 (field <= -aa: smoothstep's clamp lands t on 0.0) and
//   fringe == 0.0.
//   ONE path, all four cells (design 2026-09-05 §6): there is no mode int and no samplePaper
//   branch here any more. Under 'edgeShape: 'smooth'' the renderer binds the polygon field to
//   uSdfTight AND uSdfLoose with uBaseBias = 0, so scrapUnguarded returns max(pf, pf) + 0 = pf and
//   every line below reads as a statement about the polygon's own field; under 'edgeFinish:
//   'clean'' fringe is 0.0 outright and step 5's strandLen term is slack, not load-bearing.
//   Let u = scrapUnguarded(uv, tight) and base = scrapBase(uv) = u - guard <= u.
//   tearOf builds, with k = edgeK():
//     shaped = baseAng + (low * tearAmp + mid * midAmp) * noiseGate(base)
//     shaped = max(shaped, floorD)
//     chewed = max(shaped + high * teeth * band * toothClump, floorD)
//   and paperField returns chewed; below k == 1 main then mixes it with the alpha distance.
//   1. noiseGate(base) is exactly 0.0 once base <= -gateReach() (smoothstep clamps t to 0.0), so
//      the low and mid octaves add (finite) * 0.0 = 0.0 and shaped = baseAng.
//   2. baseAng = mix(base, v, ang), ang = uTearAngular * k in [0, 1], v the barycentric
//      interpolation of scrapBase at the three corners of the angular lattice triangle around uv
//      (cell = uPlanePx / (uTearFreq * ANG_FREQ) source px on a side). scrapUnguarded is a max
//      of two bilinearly sampled 1-Lipschitz fields (a signed distance and its blur) plus a
//      constant, and a bilinear sample is a convex combination of the four texels around the
//      point, so for any two points |F(c) - F(p)| <= |c - p| + 2*sqrt(2)*h + s (h the texel, s
//      the quantisation step): the texels around c and p are within sqrt(2)*h of them. The
//      barycentric-weighted distance from an interior point to a triangle's corners is at most
//      cell / sqrt(2) (its maximum sits at the hypotenuse's midpoint), and the guard only ever
//      lowers a corner, so v <= u + cell / sqrt(2) + slop, where slop covers the 2*sqrt(2)
//      texels of the coarser field, one tight texel more for the jump flood's own error, and one
//      quantisation step (R16F: 1 px below 2048 px; byte mode: uDecode.x / 255). So
//      baseAng <= max(base, v) <= u + cell / sqrt(2) + slop; when ang <= 0.0 baseAngular returns
//      base and the cell term is 0.
//   3. floorD = tearFloor(uv) = tight + 0.4 * uBaseBias <= u - 0.6 * uBaseBias <= u, since
//      max(tight, ...) >= tight and uBaseBias >= 0. At uBaseBias == 0 (the polygon contour) the
//      two ends meet — floorD = tight <= u — and the bound still holds. farOutside tests it
//      explicitly all the same.
//   4. band = 1.0 - smoothstep(0.0, max(teeth * 1.8, 0.5), abs(shaped)) is exactly 0.0 once
//      abs(shaped) >= 1.8 * teeth (teeth = 1.6 * uChew * k), so the teeth add (finite) * 0.0 and
//      chewed = max(shaped, floorD) = shaped.
//   5. sheetA == 0.0 needs field <= -aa. fringe == 0.0 holds whenever chewed < -1.05 * strandLen
//      (fringeTerm's 't > strandLen * 1.05' return, strandLen = STRAND_MULT * uFiberLen * k),
//      whether or not paperField's 'abs(shaped) < reach' block runs. Below k == 1 the field is
//      mix(-max(aa, 0.5), chewed, k), a convex blend of two values at most -aa - slop: at most
//      -aa + 1 ulp after rounding, so sheetA is 0.0 or of the order of 1e-8, the alpha byte is 0
//      either way, and the identity there is at the RGBA8 byte level.
//   farOutside therefore asks u < -max(gateReach(), cell / sqrt(2) + slop + 2 * teeth
//   + 1.05 * strandLen + aa): the first operand is step 1, the second steps 2-5 (a sum where a
//   max would do — the surplus is margin). The gate's reach is NOT added to the edge terms: past
//   -gateReach() the octaves it gates are exactly zero, so the tear amplitudes cannot move the
//   contour there at all.
//
//   WHY THE EDGE REDESIGN DOES NOT MOVE THIS CONCLUSION, and why no early-out test needs a new
//   tolerance (design 2026-09-05 §6.1). Two terms changed. gateReach lost its looseness factor,
//   so its reach is now 0.6 * tearAmp where it was 0.6 * looseness * tearAmp with looseness in
//   [0, 1]: THE GATE'S REACH ONLY GREW, the outer max() therefore only grew, and farOutside fires
//   strictly LESS often than it did — sound, by the same argument, with margin to spare. And the
//   old thickness uniform became uBaseBias in step 3 and in farOutside's own floor test, which is
//   the same quantity under a new name plus the new 'smooth' case uBaseBias == 0, covered in
//   step 3. Nothing here got tighter, so nothing here needs re-proving downward.
//
// CONTROL FLOW. Both early-outs 'return' under a per-fragment condition, which puts the rest of
// main() in non-uniform control flow for the fragments that stay. The one derivative the front
// build takes is creaseNet's fwidth, so 'wear' is evaluated ABOVE the early-outs, in uniform
// flow as before; the fold loop's fwidth runs 0 times at uFoldCount == 0; and every texture()
// below samples a single-level texture, where the implicit LOD is irrelevant (the deckle band
// already did so under 'deckle > 0.002').
// =============================================================================================
//
// P7 — PAPER_FRONT_BUILD: the paths the front build cannot reach are compiled out.
//
// Under the SAME four uniforms the guard above names (uFoldCount == 0, uShadow == 0.0,
// uCrumpleFill == 0.0, uDebug == 0 — every program this package links is driven by renderFront,
// which fixes them), each '#if !PAPER_FRONT_BUILD' region below is one of three shapes, and the
// value of every variable that survives it is the literal the '#else' or the retained declaration
// carries:
//
//   - a loop over 'i < uFoldCount' runs 0 times: step 1 leaves remaining = 1.0; the drop shadow's
//     fold cut leaves shadowRemaining = 1.0; foldCreases returns m = 1.0, which is what the
//     front build's 'float creaseM = 1.0' declares;
//   - a branch whose condition is false is skipped: flapPossible and shadowPossible are
//     'uFoldCount > 0 && ...', the flap-shadow gate is 'uShadow > 0.0 && ...', the crumple
//     block's gate and the compaction's 'uCrumpleFill > 0.0' are false, the ball shadow's
//     'uShadow > 0.0 && uCrumpleFill > 0.0' is false, and every 'uDebug == n' is false — so flap =
//     layers = 0.0, top = -1, flapShadow = 0.0, shell = body = 0.0 and bodyOut = 1.0 stay at
//     their declared initialisers, exactly as the front build declares them;
//   - a statement compiled out whole is 'front *= 1.0 - flapShadow * 0.7 * uShadow', which at
//     flapShadow == 0.0 and uShadow == 0.0 is 'front *= 1.0 - 0.0', a multiplication by exactly
//     1.0 — the identity for every float, NaN and infinities included.
//
// Every expression that consumed one of those values is kept verbatim, so the front build
// evaluates the same operation sequence on the same operands; what changes is only that fxc now
// sees a literal where it saw a uniform-derived value, and may fold 'x * 1.0', 'x + 0.0' or
// 'back * 0.0 + y'. The first two are exact for every operand but the sign of a zero, and no
// consumer can observe that sign: baseA = sheetCov * 1.0 is never -0.0 (sheetCov is a max of
// coverages that are +0.0 or positive), and the only reads of 'a' and 'premul' are the
// 'outA > 1e-4' test and the division under it. The third needs 'back' finite, which the P6a
// block established above ('back is finite'): then back * 0.0 is a signed zero and adding it to
// front * baseA * 1.0 returns that product exactly. The drop-shadow step keeps its full text
// minus the two false branches, so at uShadowBlur == 0.0 it still evaluates the same undefined
// smoothstep the whole program does, whatever that yields. The debug views return before the
// composite and are simply absent. The evidence is paper-shader-early-out.gl.test.ts, which
// renders the same requests through this program and through the whole one and compares bytes.
// =============================================================================================
float fieldTexelPx(vec2 pxPerUv, ivec2 texels) {
  return max(pxPerUv.x / float(texels.x), pxPerUv.y / float(texels.y));
}
float tightTexelPx() {
  vec2 pxPerUv = vec2(uPlanePx * uAspect / uTightUv.x, uPlanePx / uTightUv.y);
  return fieldTexelPx(pxPerUv, textureSize(uSdfTight, 0));
}
float looseTexelPx() {
  return fieldTexelPx(vec2(uPlanePx * uAspect, uPlanePx), textureSize(uSdfLoose, 0));
}
bool frontFastPath() {
  return uShadow == 0.0 && uShadowBlur > 0.0 && uFoldCount == 0 && uCrumpleFill == 0.0 &&
         uDebug == 0;
}

bool deepInside(vec2 uv) {
  return tearFloor(uv) > uAaPx + tightTexelPx();
}

bool farOutside(vec2 uv, float aa) {
  float tight;
  float u = scrapUnguarded(uv, tight);
  float k = edgeK();
  float hTight = tightTexelPx();
  float slop = 3.0 * max(hTight, looseTexelPx()) + hTight +
               max(2.0, max(uDecodeTight.x, uDecodeLoose.x) / 255.0);
  float ang = uTearAngular * k;
  float cell = (ang > 0.0) ? uPlanePx / max(uTearFreq * ANG_FREQ, 1e-4) : 0.0;
  // cell / sqrt(2): the furthest a triangle's corners can be, barycentrically weighted, from a
  // point inside it (proof block, step 2).
  float angTerm = cell * 0.70710678;
  // 'CHEW_REACH' again, the second of its two uses (the first is tearOf's own 'teeth').
  float teeth = (uChew * edgeDetailK()) * ${glslFloat(CHEW_REACH)};
  float strandLen = (uFiberLen * edgeDetailK()) * STRAND_MULT;
  float edge = angTerm + slop + 2.0 * teeth + strandLen * 1.05 + aa;
  return u < -max(gateReach(), edge) && tight + uBaseBias * 0.4 < -edge;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uFrontSize;
  vec2 p = toPlane(uv);
  vec2 nUv = uv * vec2(uAspect, 1.0);

  // Hard edge. The antialiasing width comes from uAaPx, not from fwidth of the field: the
  // field carries 1 px teeth, so its own derivative would blur exactly the detail the
  // reference is crispest about. The fibres no longer widen this ramp: they are composited
  // separately as translucent hair (see fringeTerm), so the sheet's own edge stays crisp under
  // the fuzz, which is what the macro photographs show.
  float aa = uAaPx * 0.6;
  // The artwork, sampled at this fragment's own position. No transform. Ever. (Read ahead of
  // the paper field since P6a: the early-outs key on its alpha, and the fetch is pure.)
  ivec2 aPix = ivec2(floor(gl_FragCoord.xy - uArtworkRect.xy));
  vec4 img = (aPix.x < 0 || aPix.y < 0 ||
              aPix.x >= int(uArtworkRect.z) || aPix.y >= int(uArtworkRect.w))
    ? vec4(0.0)
    : vec4(texelFetch(uImage, aPix, 0)) / 255.0;

  // Pale hairline wear across the face of the sheet. Ridged noise raised to a high power gives
  // thin bright lines; at a low amplitude they cost nothing and are most of what makes the
  // backing read as a physical object that has been handled.
  //
  // The domain is strongly ANISOTROPIC, which is the whole trick. An isotropic ridged noise has
  // curved crests, and broad curved arcs across a sheet read as smudges, not as creases — that
  // was the earlier build's worst surface artefact. Compressing one axis and stretching the
  // other by 12x makes the noise vary quickly across the crease and slowly along it, so its
  // crests run nearly straight for a long way, which is what handling creases actually look
  // like in the collage reference. Three families at unrelated angles, so it does not read as
  // hatching either.
  // Two scales, because they do two different jobs. 'wear' is the handling crease — a long
  // straight line every few hundred pixels, the mark of a sheet that has been picked up. It
  // belongs on flat paper and it is what stops the backing reading as a flat fill.
  //
  // The same construction at a finer scale was tried for the crumple and does NOT work: an
  // anisotropic ridge network run fine enough to be crumple is a set of long parallel streaks
  // that cross the whole scrap and break into dashes where the crest dips under its threshold.
  // It reads as machine stitching. Crumple creases are SHORT segments meeting at vertices, which
  // is a Voronoi boundary, not a ridge — see crinkleLines below.
  //
  // Evaluated here, ahead of the early-outs, since P6a: creaseNet takes fwidth, and a derivative
  // is only defined in uniform control flow — every fragment of the quad has to compute it,
  // including the ones that return early just below.
  float wear = 0.0;
  if (uCreases > 0.0) wear = creaseNet(nUv, 1.0, uSeed);

#if PAPER_EARLY_OUT
  // --- 0. the front build's early-outs (P6a; the proof is the block above main) -------------
  if (frontFastPath()) {
    if (img.a == 1.0) {
      if (deepInside(uv)) { outColor = vec4(img.rgb, 1.0); return; } // P6a early-out (a)
    } else if (img.a == 0.0) {
      if (farOutside(uv, aa)) { outColor = vec4(0.0); return; } // P6a early-out (b)
    }
  }
#endif

  float fringe = 0.0;
  vec2 edgeN = vec2(0.0, 1.0);
  float field = paperField(uv, fringe, edgeN);
  // Below the top of the edge-width ramp the field is blended toward the artwork's OWN alpha,
  // read as a distance the way the baker reads it: coverage - 0.5 is the signed distance of a
  // straight edge from the pixel centre. The distance field is sampled from a texture coarser
  // than the image, so along a thin strap or at a sharp concave corner it sits a fraction of a
  // pixel off the true edge, and at thickness 0 that showed as a scatter of paper-coloured
  // pixels just outside the artwork. The alpha distance is scaled so that alpha 0 and 1 land
  // exactly at the ends of the aa ramp — at 1:1 the ramp is 0.6 px wide and an unscaled -0.5
  // is INSIDE it, i.e. two percent of paper over the whole empty canvas — so at k == 0 the
  // mask is smoothstep(0, 1, alpha): 1 on every opaque pixel, 0 on every empty one, an S-curve
  // through the antialiased edge, and nothing else. The blend is skipped at k == 1 so the
  // default render stays bit-identical.
  //
  // Clean zero-width edges retain the legacy alpha transition. Paper finish keeps the field;
  // explicit 'none' bypasses the transition below to preserve fractional PNG coverage exactly.
  float edgeRamp = edgeDetailK();
  if (edgeRamp < 1.0) field = mix((img.a - 0.5) * 2.0 * max(aa, 0.5), field, edgeRamp);
  float sheetA = uEdgeNone == 1 ? img.a : smoothstep(-aa, aa, field);
  // The fringe hairs lie OUTSIDE the sheet's own edge and are translucent, so they go over the
  // background with their own alpha rather than into the field: a hair is not more paper, it is
  // a thread of the core with light coming through beside it. With no hair in the pixel this is
  // exactly sheetA, so the old path is untouched.
  float paperMask = sheetA + fringe * (1.0 - sheetA);
  // Coverage of the sheet at this position: the torn scrap, and always at least the artwork.
  float sheetCov = max(paperMask, img.a);

  // --- 1. has this position been folded away? ------------------------------
  // Uniform control flow, so fwidth is legal here: one rendered pixel of antialiasing gives
  // the fold line the mechanically straight edge the whole illusion rests on.
  float remaining = 1.0;
#if !PAPER_FRONT_BUILD
  for (int i = 0; i < MAX_FOLDS; i++) {
    if (i >= uFoldCount) break;
    float s = dot(p, uFolds[i].xy) - uFolds[i].z;
    float w = max(fwidth(s), 1e-6) * 0.5;
    remaining = min(remaining, 1.0 - smoothstep(-w, w, s));
  }
#endif

  // --- 2. is a flap lying on top of it? ------------------------------------
  // Twelve folds means up to twelve mask samples, so the loop is gated hard, twice.
  //
  // survivesAfter(p, -1, uSlack) is the strong gate: no layer gets more slack than uSlack, so
  // a point outside every fold line by more than that cannot host any flap at all. By the
  // last pose that prunes the work down to the ball and its overhangs, which is a few percent
  // of the canvas. Without it this shader spends its whole budget on empty margin.
  //
  // The envelope test is the weak gate, and earns its keep at the early poses when the fold
  // polygon still covers most of the sheet.
  //
  // Note that neither gate is 'remaining': a flap with slack lives past the fold lines that
  // cut the sheet under it, and those overhangs are the ball's protruding points.
  // Under 'edgeShape: 'smooth'' uSdfLoose is the polygon's own field (the renderer binds it to
  // both slots, design 2026-09-05 §6), so this one expression is the polygon's envelope there:
  // nothing reaches past it but the jitter arc and the slack, which is what uFlapReach is set to.
#if !PAPER_FRONT_BUILD
  float envelope = sampleLoose(uv);
  bool flapPossible =
    uFoldCount > 0 &&
    survivesAfter(p, -1, uSlack) &&
    envelope > -uFlapReach;
#endif

  float creaseDist = 1e9;
  float layers = 0.0;
  vec2 facetN = vec2(0.0);
  float flap = 0.0;
  int top = -1;
#if !PAPER_FRONT_BUILD
  if (flapPossible) {
    flap = flapCoverage(p, creaseDist, layers, facetN, top);
  }
#endif

  // The shadow the flaps above the visible layer throw onto it — the remaining sheet or a flap
  // lower in the stack. Soft, offset and widened by how high the caster sits; see flapShadowAt.
  // Its own gate is the flap gate widened by the furthest the shadow reaches, so a flap just
  // past the last fold line can still shade the sheet next to it.
  float flapShadow = 0.0;
#if !PAPER_FRONT_BUILD
  float shadowReach = 18.0 * uPxScale;
  bool shadowPossible =
    uFoldCount > 0 &&
    survivesAfter(p, -1, uSlack + shadowReach / uPlanePx) &&
    envelope > -(uFlapReach + shadowReach);
  // Skipped once the crumple is complete: by then the plates have replaced the flaps, the
  // shadow's residual is 0, and this loop was the single most expensive thing in the last pose.
  if (uShadow > 0.0 && shadowPossible && top < uFoldCount - 1 && uCrumpleFill < 0.999) {
    flapShadow = flapShadowAt(p, top);
  }
#endif

  // --- 3. shading ----------------------------------------------------------
  // (nUv and the handling wear are computed at the top of main since P6a.)
  // Paper tooth. Weighted toward the fine octave: a heavy low octave reads as coloured
  // mottling rather than as a surface. Both octaves are kept above two pixels per cell — a
  // finer lattice than that is one independent hash per pixel, which is television snow rather
  // than paper and which shimmers the moment the sprite is drawn at thumbnail size.
  // Real paper grain, from a macro photograph of a torn sheet, at about 300 reference px per tile
  // so the tooth stays the same physical size whatever the sprite's resolution is. The procedural
  // pair it replaces is kept behind the knob: two octaves of value noise are a plausible tooth but
  // they have no fibre in them, and fibre is what the eye reads as paper.
  float grainProc =
    noiseSmooth(rot2(nUv * 480.0 * uPxScale, 0.4)) * 0.85 +
    noiseSmooth(rot2(nUv * 165.0 * uPxScale, -1.1)) * 0.15;
  float grainPhoto = texture(uFibreA, nUv * uPlanePx / (300.0 * uPxScale)).r;
  float grain = mix(grainProc, grainPhoto, uPhotoFibre);
  float grainFactor = 1.0 + (grain - 0.5) * uGrain;

  // --- 3a'. the edge frame: exposed-core band width and the tear shadow -----------------------
  // Everything about the torn rim is measured in the contour's own frame — distance across it
  // (the field itself) and a foot point on it — and two of its terms have to be known before
  // the sheet colour is fixed: the band's local width, and the shadow that band throws.
  //
  // The core band's width varies strongly along the contour, 0.3x to 2x nominal on the slow
  // lattice, and its INNER boundary is torn too: the top layer of the sheet peels back a
  // different distance every few pixels, so a second, fast lattice sampled at the foot point
  // raggeds the boundary at a 4-9 px wavelength. At constant width the band reads as a drawn
  // stroke, and with a smooth inner edge as a vignette; the ragged boundary is what makes it
  // read as a layer that has been pulled away.
  float deckleK = edgeDetailK();
  // Finish-only: a clean cut has no core band and throws no tear shadow (design 2026-09-05 §2.3).
  float deckleWidth = (uEdgeFinish == 1) ? uDeckleWidth * deckleK : 0.0;
  vec2 pPx = nUv * uPlanePx;
  vec2 tang = vec2(-edgeN.y, edgeN.x);
  vec2 footD = pPx - edgeN * field;
  float bandWidth = 0.0;
  float bandCore = 0.0; // the band width without the fine rag; the shadow follows this one
  if (deckleWidth > 0.0) {
    float widthNoise = noiseSmooth(rot2(nUv * uTearFreq * 0.7, 0.33) + uSeed * 4.7);
    // Squared, so the band spends most of its length narrow and occasionally blooms wide.
    bandWidth = deckleWidth * (0.3 + 1.7 * widthNoise * widthNoise);
    float rag = noiseSmooth(footD / (11.0 * uPxScale) + 3.0);
    bandWidth *= 0.6 + 0.8 * rag;
    bandCore = bandWidth;
    bandWidth *= 0.85 + 0.3 * noiseSmooth(footD / (4.5 * uPxScale) + 77.0);
  }
  // The tear shadow. The raised fibrous core stands a little proud of the sheet, and in the
  // macro photographs the sheet just inside it carries a thin dark line — strongest right at
  // the band's inner boundary, gone within two or three pixels. Lit: the side of the rim that
  // faces away from the light is shaded harder, but never to zero, since most of it is
  // occlusion rather than cast shadow. It belongs to the SHEET, so it is applied before the
  // print is composited and gated by (1 - alpha) on top of that: nothing of it may reach an
  // opaque artwork pixel, and at alpha 1 the multiplier is exactly 1.
  float tearShade = 0.0;
  if (uEdgeFinish == 1 && uTearShadow > 0.0 && deckleK > 0.0) {
    float inner = bandWidth;
    float soft = max(2.4 * uPxScale, 0.5);
    float rise = smoothstep(inner - 1.5 * uPxScale, inner + 0.5 * uPxScale, field);
    float fall = exp(-max(field - inner, 0.0) / soft);
    float lit = 0.45 + 0.55 * clamp(dot(-edgeN, uLightDir) * 0.5 + 0.5, 0.0, 1.0);
    tearShade = uTearShadow * rise * fall * lit * deckleK * (1.0 - img.a);
  }

  // Hull-mode sheet relief: the crumple photograph's normal, relit by the scene light at a very
  // low amplitude, uniform over the whole sheet and in the SHEET frame (not the ball frame the
  // crumple pass samples it in). A cut sheet lying on a table is not flat — it carries the soft
  // large-scale undulation of paper that has been handled — and without it the hull's flat fill
  // reads as a vector shape. Exactly 1.0 at amplitude 0, which is what torn mode passes, so that
  // mode is untouched. Uniform control flow, so the texture fetch is legal here.
  float relief = 1.0;
  if (uSheetCrumple > 0.0) {
    vec2 scUv = nUv * uPlanePx / max(uSheetTile, 1.0);
    vec2 scRG = vec2(texture(uCrumpleR, scUv).r, texture(uCrumpleG, scUv).r);
    float scA = texture(uCrumpleA, scUv).r;
    vec3 sn = normalize(vec3((scRG * 2.0 - 1.0) * uSheetCrumple * 0.4, 1.0));
    vec3 sLight = normalize(vec3(uLightDir * 0.8, 0.62));
    relief = dot(sn, sLight) / sLight.z;
    relief *= 1.0 + (scA - 0.5) * uSheetCrumple * 0.3;
  }

  // Handling wear belongs to the SHEET, so it is applied before the artwork is composited over
  // it. Applied afterwards it draws straight lines across the garment, which reads as a scratched
  // photograph rather than as a print lying on creased paper. The tear shadow rides here for the
  // same reason; it is exactly 0 under uEdgeFinish == 0 and at alpha 1.
  vec3 sheet = uPaperColor * grainFactor * relief * (1.0 + wear * uCreases) * (1.0 - tearShade);
  // The print lies on the sheet. Where the sheet covers the whole pixel that is a plain mix —
  // and it is kept as exactly that expression, because it is what every opaque artwork pixel
  // goes through. Where the sheet itself is only partly here (its torn edge, or at thickness 0
  // the artwork's own antialiased edge) the paper can only tint the part of the pixel it covers
  // beyond the print: a straight mix put a paper-coloured fringe round a cutout that had no
  // paper margin at all.
  vec3 front = mix(sheet, img.rgb, img.a);
  // (With no print in the pixel the expression reduces to 'sheet' anyway; skipping it keeps the
  // scrap's own torn edge on the exact old path.)
  if (sheetCov < 1.0 && img.a > 0.0 && sheetCov > 1e-4) {
    front = (img.rgb * img.a + sheet * max(sheetCov - img.a, 0.0)) / sheetCov;
  }

  // --- 3a. the exposed core band --------------------------------------------
  // A torn edge is a BAND, not a contour. The sheet has thinned along the break and its white
  // core is exposed, which is why every torn scrap in the collage reference carries a pale rim
  // and the blade-cut ones do not. This is what makes an edge read as torn rather than as a
  // wiggly cut, and it is the single strongest cue on the whole silhouette.
  //
  // Its width and its ragged inner boundary are computed in the edge frame above. The band
  // rides the edge-width ramp twice: its width, and its blend — the width alone bottoms out at
  // the 0.5 px floor below, which would still paint a faint white rim on the artwork's own
  // antialiased edge at a thickness of half a pixel. And it is gated by (1 - alpha): the core
  // is the paper BEYOND the print, so it may never reach an opaque artwork pixel — the earlier
  // build let it, wherever the tear bit deep, and that was the one thing that touched artwork.
  vec3 coreCol = mix(uPaperColor, vec3(1.0), uDeckleLight);
  if (bandWidth > 0.0) {
    // Half the width is band proper, the other half is the torn transition into the face.
    float deckle = 1.0 - smoothstep(bandWidth * 0.62, max(bandWidth, 0.5), field);
    if (deckle > 0.002) {
      // Fibrous texture. Two things were wrong in the first build and both mattered. First, the
      // frequency: 900 and 2100 cycles across the sprite are finer than one rendered pixel, so
      // every pixel drew an independent hash value and the band came out as salt and pepper —
      // dirt, not paper. Everything here stays at two rendered pixels per cell or coarser, and
      // fades out entirely where the sprite is drawn too small to resolve it. Second, the
      // direction: the exposed core is a mat of fibres that have been PULLED, and they lie
      // across the tear — along the normal — where the top layer peeled back. So the domain is
      // the local frame (distance along the contour, distance across it, both from the SDF
      // gradient), with ridged noise cells four times longer across the tear than along it,
      // and only the crests kept, which gives short bright streaks running out toward the edge.
      // A coarser felt underneath so the streaks sit on something, and the photographed grain
      // in the same frame for the sub-streak tooth.
      float along = dot(pPx, tang);
      float across = dot(pPx, edgeN);
      float texFade = 1.0 - smoothstep(1.4, 2.8, uAaPx / max(uPxScale, 1e-4));
      float s1 = 1.0 - abs(2.0 * noiseSmooth(vec2(along / (2.7 * uPxScale), across / (11.0 * uPxScale)) + 3.0) - 1.0);
      float s2 = 1.0 - abs(2.0 * noiseSmooth(vec2(along / (4.6 * uPxScale), across / (19.0 * uPxScale)) + 37.0) - 1.0);
      float streak = smoothstep(0.3, 1.0, s1) * 0.6 + smoothstep(0.25, 1.0, s2) * 0.4;
      float feltProc = noiseSmooth(vec2(along / (7.0 * uPxScale), across / (5.0 * uPxScale)) + 23.0);
      float feltPhoto = texture(uFibreA,
        vec2(along / (120.0 * uPxScale), across / (60.0 * uPxScale))).r;
      float felt = mix(feltProc, feltPhoto, uPhotoFibre);
      // The band's colour is near white, so the texture can only be read as the VALLEYS between
      // fibres: the crests go up a little, the gaps between them go down more. A change of
      // tone of a few tens of percent at most.
      float tex = (streak - 0.5) * 0.8 + (felt - 0.5) * 0.5;
      vec3 core = coreCol * (1.0 + tex * uDeckleTex * texFade);
      // Slightly darker toward the inner boundary, where the core dips back under the face.
      core *= 1.0 - 0.06 * uDeckleTex * smoothstep(bandWidth * 0.4, bandWidth, field);
      front = mix(front, core, clamp(deckle, 0.0, 1.0) * deckleK * (1.0 - img.a));
    }
  }
  // The fringe hairs: whatever part of this pixel is hair rather than sheet takes the hair
  // colour — core, a step lighter still, since a single pulled fibre is white against the mat.
  // The weight is the hair's share of the pixel's total coverage, so where the sheet is whole
  // this is exactly zero and the artwork path is untouched.
  if (fringe > 0.0) {
    float hairShare = fringe * (1.0 - sheetA) / max(sheetCov, 1e-4);
    vec3 hairCol = mix(coreCol, vec3(1.0), 0.35) * (0.94 + 0.12 * grain);
    front = mix(front, hairCol, hairShare);
  }
  // The only thing folding is allowed to do to a still-visible pixel: darken it under a flap
  // edge. Geometry never moves. Tied to the shadow knob so that turning shadows off makes the
  // "visible artwork is identical to pose 0" property exact and testable.
#if !PAPER_FRONT_BUILD
  front *= 1.0 - flapShadow * 0.7 * uShadow;
#endif

  // The reverse of the sheet: blank, near-white, never the artwork. The SAME material as the
  // front — paper colour, fibre grain, the slight sheet relief — in both edge modes, so a flap
  // looks the same whichever way the edge was cut. No handling wear, no crumple photograph and
  // no mosaic here: a flap at pose 1 or 2 is clean folded paper, and everything crumpled ramps
  // in with uCrumpleFill below.
  float flapTone = facetShade(facetN, layers);
  // Crisp creases along the fold lines that actually creased this layer, and the shadow of the
  // flaps above it. Both tied to the knobs the identity check switches off.
#if PAPER_FRONT_BUILD
  float creaseM = 1.0; // foldCreases at uFoldCount == 0: the loop runs 0 times and m stays 1.0
#else
  float creaseM = foldCreases(p, top, layers);
#endif
  float shadowM = 1.0 - flapShadow * 0.7 * uShadow;
  vec3 back = uPaperBack * grainFactor * relief * flapTone * creaseM * shadowM;

  // --- 3b. the crumple fill, for the tail of the sequence -------------------
  // Only ever touches 'back'. 'front' — the artwork — is never reached by any of this, so the
  // pixel-identity guarantee holds no matter what uCrumpleFill is set to.
  //
  // THE MOSAIC IS GATED BY FOLD DEPTH, not just by pose. Switching it on for the whole scrap at
  // one pose is a renderer swap, and a renderer swap reads as a rendering error rather than as
  // the next step of the animation — it was the single largest discontinuity in the sequence.
  // Paper does not crumple everywhere at once; it crumples where it has already been folded over
  // several times. So one flap here still reads as one folded flap, three read as crumple, and
  // the mosaic grows outward on its own as the fold count rises.
  //
  // It also makes the pixel-identity guarantee STRUCTURAL rather than incidental. A position
  // where the artwork is still visible has no flap on it, so layers is 0 and this gate is shut.
  // That is what lets the fill be non-zero at poses that still show artwork.
  // Sheets of paper stacked at this position: the base sheet, if the folds have not taken it
  // away, plus every flap lying on top of it. One sheet is flat paper and can still be showing
  // artwork; four is a crumple.
#if !PAPER_FRONT_BUILD
  float stack = remaining + layers;
  // Stacked-sheet count alone cannot separate a single flap lying on sheet the folds have
  // already removed (remaining 0, layers 1) from bare artwork (remaining 1, layers 0): both are
  // a stack of exactly 1.0, and no threshold on stack can tell them apart. Left uncrumpled,
  // those single-flap regions render as raw flap shading in the middle of the finished ball —
  // soft mid-grey blotches that read as stains rather than as paper.
  //
  // (1 - remaining) is the discriminator, and it is the SAME one the shell already uses: a pixel
  // that still shows artwork has remaining == 1, so this term is exactly zero there and the
  // pixel-identity guarantee is untouched.
  //
  // It is gated hard onto the LAST TWO POSES. Weighted by uCrumpleFill^2 instead — which is what
  // it was first written as — it opens the mosaic over every flap from pose 2 onward, and at 30%
  // blend that is a lizard-skin crackle laid over paper that is still supposed to be reading as
  // folding. The poses that show the garment must show flat flaps.
  //
  // smoothstep(0.5, 1.5, layers) was also wrong: it returns 0.5 for a region carrying exactly one
  // flap, which is most of them, and half-blended flap shading under a half-blended mosaic is the
  // soft grey blotching this term exists to remove.
  float flapCore = (1.0 - remaining) * smoothstep(0.15, 0.75, layers) *
                   smoothstep(0.6, 1.0, uCrumpleFill);
  float depthAmt = max(smoothstep(uCrumpleDepth.x, uCrumpleDepth.y, stack), flapCore);
  // How far the rim plates are allowed to stick out at this pose. Squared, so the scrap keeps
  // a clean folded outline while it is still legible and only starts bulging once it is a ball;
  // linear in the fill left a thin band of new paper ringing the scrap three poses early.
  float reach = uCrumpleFill * uCrumpleFill;
  // How much of the mosaic shows on the stacked flaps. Zero through pose 2 (fill 0.2): the poses
  // that still show the garment must show clean flat flaps. Then a linear ramp — 0.31 at pose 3,
  // 0.72 at pose 4, 1 at the ball — so the plates come in progressively rather than switching on.
  float mosaicK = clamp((uCrumpleFill - 0.2) / 0.8, 0.0, 1.0);
  float crumple = 0.0;
#endif
  float shell = 0.0;

  // The sheet's front, where it still lies here. Needed by the compaction gate below as well
  // as by the composite.
  float baseA = sheetCov * remaining;

  // --- 3b'. ball compaction ------------------------------------------------
  // Folding is analytic mirror-occlusion of the base sheet, so a NON-CONVEX source folds into
  // a ball with holes: wherever the mirrored source had no paper — the gap between a sleeve
  // and the torso, the gap between two legs — a flap has a hole in it, and once every layer
  // over a position has one, the ball is see-through there. Thin pieces (a sleeve) also land
  // outside the main mass as detached shards. At the shipped thickness the loose envelope
  // happened to fill those gaps with backing paper and hide all of this; at thickness 0, where
  // the sheet IS the artwork, it is the whole picture.
  //
  // Real paper compresses, so the model gets a BODY: inside the ball frame (p / uBallR, the
  // same frame the crease photograph is sampled in) a ragged blob that is paper regardless of
  // what folded onto it, driven by the fill:
  //   - bodyIn grows from the centre outward and fills holes as it reaches them;
  //   - bodyOut sweeps in from far off the sprite and fades shards away as it passes them.
  // Both converge on the crumple shell's own outline at fill 1, so the finished ball is one
  // connected blob bounded by the outline the shell already draws — not a second silhouette.
  // Growing a RADIUS rather than ramping an opacity is deliberate: a half-strength opacity is a
  // translucent ghost in the middle of the ball, a half-grown body is a smaller solid one.
  //
  // The frontier is the tear's low and mid octaves sampled along the unit circle of the ball
  // frame: periodic in angle by construction, and never a clean circle.
#if !PAPER_FRONT_BUILD
  float ballRamp = uCrumpleFill * uCrumpleFill;
  float bodyIn = 0.0;
#endif
  float bodyOut = 1.0;
  float body = 0.0;
#if !PAPER_FRONT_BUILD
  vec2 b = toBall(p);
  float rB = length(b);
  float aaB = uAaPx / max(uBallR * uPlanePx, 1e-4);
  float rOut = (1.0 - ballRamp) * BALL_FAR;
  float softOut = max(BALL_SOFT * (1.0 - ballRamp), aaB);
  if (uCrumpleFill > 0.0) {
    vec2 c = b / max(rB, 1e-4);
    float lowR = tearFbm(c * 2.4 + uSeed) * 2.0 - 1.0;
    float midR = noiseLinear(rot2(c * 5.2, 1.13) + uSeed * 3.1) * 2.0 - 1.0;
    float rr = rB / (1.0 + lowR * 0.16 + midR * 0.06);
    float rIn = ballRamp * BALL_GROW;
    bodyIn = 1.0 - smoothstep(rIn - aaB, rIn + aaB, rr);
    bodyOut = 1.0 - smoothstep(rOut, rOut + softOut, rr);
  }

  // The gate is spatial as well as by knob: stacked sheet (depthAmt), the growing body, or the
  // ball's own neighbourhood in the ball frame — the outline never reaches past 1.3 radii. Over
  // the empty margin, which at the last pose is most of the canvas, none of this runs. This is
  // why crumpleShade computes its line widths from uniforms instead of with fwidth: derivatives
  // are undefined under a gate like this one.
  // The outline itself is only wanted near the ball AND where the shell could show: over sheet
  // the folds have already taken away, or once the fill has reached 1. At pose 3 the ball frame
  // is larger than the scrap and the outline over the still-visible artwork was dead work worth
  // several milliseconds.
  bool nearBall = rB < 1.4 && (remaining < 0.999 || uCrumpleFill >= 0.999);
  if (uCrumpleFill > 0.0 && (depthAmt > 0.0 || bodyIn > 0.0 || nearBall)) {
    vec2 q = plateDomain(p);
    // The outline, from the rim plates: each sticks out or sits back by its own seeded amount,
    // with sharp corners where two meet and a few V notches. Star-shaped by construction (see
    // outlineD), antialiased over one rendered pixel with a continuous distance, so the finished
    // ball is one blob with no holes and no specks at either edge width.
    float shellShape = 0.0;
    if (nearBall) {
      // The outline never comes inside 0.72 R (1 - bite - lump - notch) or past 1.35 R, so the
      // two rim lookups only run in that band; inside it the shell is simply 1.
      if (rB < 0.72) {
        shellShape = 1.0;
      } else if (rB < 1.35) {
        float oD = outlineD(b, reach);
        shellShape = 1.0 - smoothstep(-aaB, aaB, oD);
      }
    }
    // (1 - remaining) is the other half of the identity guarantee. The shell is the ball's outer
    // surface, so it may only cover sheet the folds have already taken away; ungated it would
    // paint straight over live artwork at any earlier pose. The single exception is the pose
    // where the crumple is COMPLETE: by then the ball has closed over its own core, and the fold
    // model's handful of uncovered pixels deep in the middle would otherwise show through the
    // finished ball as a coloured speck of the garment.
    float closed = max(1.0 - remaining, step(0.999, uCrumpleFill));
    // ...and the sheet has to have been here in the first place, or the outline draws itself in
    // mid-air at the early poses, when the ball frame is far larger than the scrap.
    // ...and, below fill 1, only where the compaction body has actually grown (bodyIn): the
    // outline degenerates to the unit circle at low fill (rimRadius blends toward 1 by reach),
    // so ungated the folded-away sheet came back as a full-size smooth disc at poses 2-3.
    shell = shellShape * closed * sheetCov * max(bodyIn, step(0.999, uCrumpleFill));

    // The ball's mass. While the fill is under 1 it is the shell UNIONED with the rounded fold
    // polygon plus its slack band, which is where every flap overhang lives, so a flap in it
    // stays attached to a solid mass and anything further out — a flap that mirrored past an
    // EARLIER fold line, where the detached shards come from — is outside the body. At fill 1
    // the mass is the plate outline alone: the polygon's straight sides and hard vertices are
    // the one thing a crumpled ball never shows, and everything past the outline is clipped.
    float aaP = uAaPx / uPlanePx;
    float polyIn = 1.0 - smoothstep(-aaP, aaP, polyRound(p, uSlack * 2.5) - uSlack);
    float massShape = max(shellShape, polyIn * (1.0 - step(0.999, uCrumpleFill)));

    // The ball body: that mass, filled in where the sheet never was or has been folded away,
    // as far out as the compaction has grown. (1 - baseA) is the identity guard again —
    // exactly zero wherever the artwork is still showing — with the same final-pose exception
    // the shell has, so the ball closes over its core at fill 1. And the outer fade stops at
    // the mass: nothing inside the ball is ever faded.
    body = massShape * bodyIn * max(1.0 - baseA, step(0.999, uCrumpleFill));
    bodyOut = max(bodyOut, massShape);

    // Sheet the folds have already removed is, by definition, material that is now inside the
    // ball rather than on the front of it: no artwork can be showing there whatever its local
    // layer count is, so the shell takes the mosaic at full pose strength. Everywhere else has
    // to earn it by depth. The body is compacted paper — many layers by definition — so it
    // takes the mosaic the same way.
    crumple = max(depthAmt, max(shell, body));
    if (crumple > 0.0 && mosaicK > 0.0) {
      // The crushed sheet: the plate relief on the paper, with the albedo lifting toward white
      // as the fill rises. The flap's own creases stay (at reduced weight — the plates carry
      // their own), its facet tone and the flap shadows give way to the plates entirely. At mosaicK == 0
      // every factor here is 1 and 'plate' is exactly 'back', so the early poses do not change.
      float shade = crumpleShade(p, q, b, mosaicK);
      vec3 albedo = mix(uPaperBack, mix(uPaperBack, vec3(1.0), 0.3), mosaicK);
      vec3 plate = albedo * grainFactor * mix(relief, 1.0, mosaicK) * shade *
                   mix(flapTone, 1.0, mosaicK) * mix(creaseM, 1.0, 0.5 * mosaicK) *
                   mix(shadowM, 1.0, mosaicK);
      back = mix(back, plate, crumple);
    }
  }
#endif

  // The reverse side — flap, shell or body — lies ON the remaining sheet, so this is a
  // premultiplied "over", not a mix. A mix with alpha = max(sheet, flap) lets the artwork at a
  // position the folds have already taken away bleed into the antialiased edge of the flap
  // lying there: the flap's reverse showed a one-pixel tint of the garment that was no longer
  // under it. Where the sheet is whole (baseA == 1) or nothing lies on it (backAmt == 0) both
  // formulations are the same arithmetic, which is what keeps pose 0 bit-identical.
  float backAmt = max(flap, max(shell, body));
  float a = backAmt + baseA * (1.0 - backAmt);
  vec3 premul = back * backAmt + front * baseA * (1.0 - backAmt);
  // Ball compaction: paper outside the body is faded away by the fill ramp. Exactly 1 while
  // the fill is 0, so the early poses do not pass through this at all.
  a *= bodyOut;
  premul *= bodyOut;

  // --- 4. outer drop shadow ------------------------------------------------
  // P6a (D2): the front build passes uShadow = 0 and the whole of this step used to be dead work
  // — two field fetches per fragment, multiplied by 0.0 at the end. It is
  // skipped exactly when that multiplication is a finite number times 0.0: shadowMask is a
  // smoothstep of dS, which is finite (both base fields are finite samples plus finite uniforms,
  // the border guard included) provided uShadowBlur > 0.0 — at uShadowBlur == 0.0 the smoothstep
  // has edge0 == edge1 and is undefined, so that case keeps today's path, whatever it yields.
  // With shadowA finite and non-negative, shadowA * 0.0 * (1.0 - a) is +0.0 (or -0.0), and
  // a + (+-0.0) == a for every a: sa = 0.0 is the same outA, bit for bit.
  float sa = 0.0;
  if (uShadow != 0.0 || uShadowBlur <= 0.0) {
    // The noise-free base, offset. The shadow is soft enough that the missing tear is
    // invisible, and this costs two samples instead of a nine-tap blur of the real mask.
    vec2 sUv = uv - uShadowOffset;
    float dS = baseField(sUv);
    float shadowMask = smoothstep(-uShadowBlur, uShadowBlur * 0.25, dS);
    // The scrap's shadow follows the scrap, so the folds cut it away too.
    float shadowRemaining = 1.0;
#if !PAPER_FRONT_BUILD
    for (int i = 0; i < MAX_FOLDS; i++) {
      if (i >= uFoldCount) break;
      shadowRemaining = min(shadowRemaining, 1.0 - step(0.0, dot(toPlane(sUv), uFolds[i].xy) - uFolds[i].z));
    }
#endif

    // Once the compaction is under way the shadow follows the ball rather than the sheet: the
    // sheet's shadow is faded out by the same frontier that fades the sheet, and the plate
    // outline's own shadow takes over, fully so at fill 1 — the fold polygon's shadow is smaller
    // than the ball where the rim plates stick out and cut by fold lines the ball no longer has.
    float shadowA = shadowMask * shadowRemaining;
#if !PAPER_FRONT_BUILD
    if (uShadow > 0.0 && uCrumpleFill > 0.0) {
      vec2 bS = toBall(toPlane(sUv));
      float rS = length(bS);
      vec2 cS = bS / max(rS, 1e-4);
      float lowS = tearFbm(cS * 2.4 + uSeed) * 2.0 - 1.0;
      float midS = noiseLinear(rot2(cS * 5.2, 1.13) + uSeed * 3.1) * 2.0 - 1.0;
      float rrS = rS / (1.0 + lowS * 0.16 + midS * 0.06);
      float fadeS = 1.0 - smoothstep(rOut, rOut + softOut, rrS);
      // The ball's own shadow only once the ball is nearly there: before that the sheet's shadow
      // covers it anyway, and the two rim lookups over a 1.6 R disc are not free.
      float ballK = smoothstep(0.7, 1.0, uCrumpleFill);
      float ballS = 0.0;
      if (ballK > 0.0 && rS < 1.6) {
        float oS = outlineD(bS, reach) * uBallR * uPlanePx;
        ballS = smoothstep(-uShadowBlur, uShadowBlur * 0.25, -oS);
      }
      shadowA = max(shadowA * fadeS, ballS * ballK);
    }
#endif

    // A flap can land outside the base scrap and past the fold lines that cut it — that is
    // exactly how the protruding points happen — so the alpha above is the union of what is left
    // of the sheet with the flaps lying over it, not the sheet alone.
    sa = shadowA * uShadow * (1.0 - a);
  }
  float outA = a + sa;
  vec3 rgb = (outA > 1e-4) ? premul / outA : vec3(0.0);

#if !PAPER_FRONT_BUILD
  if (uDebug == 1) { outColor = vec4(fieldViz(sampleTight(uv)), 1.0); return; }
  if (uDebug == 2) { outColor = vec4(fieldViz(sampleLoose(uv)), 1.0); return; }
  if (uDebug == 3) {
    vec3 m = mix(vec3(0.07, 0.07, 0.08), vec3(0.93, 0.9, 0.88), paperMask);
    m = mix(m, vec3(0.15, 0.85, 0.55), img.a * 0.55);
    outColor = vec4(m, 1.0);
    return;
  }
  if (uDebug == 4) {
    vec3 m = vec3(0.09, 0.09, 0.11);
    m = mix(m, vec3(0.55, 0.16, 0.16), paperMask * (1.0 - remaining));  // folded away
    m = mix(m, vec3(0.24, 0.55, 0.92), baseA);                          // remaining, visible
    // backAmt, not flap: the crumple shell covers the sheet too, and this view is what the
    // pixel-identity check reads to decide which pixels are still showing artwork.
    m = mix(m, vec3(0.95, 0.78, 0.25), backAmt);                        // covered
    m = mix(m, vec3(0.36, 0.9, 0.62), max(0.0, backAmt - baseA));       // overhanging the cut
    outColor = vec4(m, 1.0);
    return;
  }
  if (uDebug == 5) {
    // How many sheets of paper are stacked here. This is the quantity the crumple mosaic is
    // gated on, so it is worth being able to look at: the mosaic must grow outward as this
    // grows, and it must be zero everywhere the artwork is still showing.
    //
    // Raw numbers rather than a palette — the verification harness reads this view and
    // histograms it, and a palette would only have to be inverted again.
    outColor = vec4(layers / 8.0, remaining, flap, outA);
    return;
  }
  if (uDebug == 6) {
    // The artwork exactly as the shader sees it — the padded, possibly downscaled RGBA8
    // texture, straight alpha. The verification harness reads this back as the ground truth
    // for "every opaque source pixel comes out unchanged".
    outColor = img;
    return;
  }
  if (uDebug == 7) {
    // The base sheet field the mask, the shadow and the fold loop all read: the noise-free scrap
    // over whatever contour source the renderer bound (design 2026-09-05 §6).
    outColor = vec4(fieldViz(baseField(uv)), 1.0);
    return;
  }
#endif
  outColor = vec4(rgb, outA);
}`

/**
 * Every uniform `PAPER_FS` declares, in declaration order, as a stable key to the GLSL name — so
 * the renderer never writes a raw string and a typo is a compile error rather than a silent
 * `null` location. Carries every uniform, including the ones the front build leaves at 0
 * (`uFoldCount`, `uShadow`) or never varies (`uDebug`).
 */
export const PAPER_UNIFORMS = Object.freeze({
  frontSize: 'uFrontSize',
  image: 'uImage',
  artworkRect: 'uArtworkRect',
  sdfTight: 'uSdfTight',
  sdfLoose: 'uSdfLoose',
  decodeTight: 'uDecodeTight',
  decodeLoose: 'uDecodeLoose',
  tightUv: 'uTightUv',
  aspect: 'uAspect',
  planePx: 'uPlanePx',
  aaPx: 'uAaPx',
  pxScale: 'uPxScale',
  edgeWidth: 'uEdgeWidth',
  baseBias: 'uBaseBias',
  tearFreq: 'uTearFreq',
  tearAmp: 'uTearAmp',
  midAmp: 'uMidAmp',
  chew: 'uChew',
  tearAngular: 'uTearAngular',
  fiberDens: 'uFiberDens',
  fiberLen: 'uFiberLen',
  grain: 'uGrain',
  deckleWidth: 'uDeckleWidth',
  deckleLight: 'uDeckleLight',
  deckleTex: 'uDeckleTex',
  tearShadow: 'uTearShadow',
  creases: 'uCreases',
  paperColor: 'uPaperColor',
  shadow: 'uShadow',
  shadowBlur: 'uShadowBlur',
  shadowOffset: 'uShadowOffset',
  seed: 'uSeed',
  folds: 'uFolds',
  foldJitter: 'uFoldJitter',
  foldCount: 'uFoldCount',
  creaseDark: 'uCreaseDark',
  creaseWidth: 'uCreaseWidth',
  paperBack: 'uPaperBack',
  facetStrength: 'uFacetStrength',
  lightDir: 'uLightDir',
  depthDark: 'uDepthDark',
  slack: 'uSlack',
  flapReach: 'uFlapReach',
  crumpleFill: 'uCrumpleFill',
  crumpleDepth: 'uCrumpleDepth',
  crumpleCells: 'uCrumpleCells',
  crumpleR: 'uCrumpleR',
  crumpleG: 'uCrumpleG',
  crumpleA: 'uCrumpleA',
  fibreA: 'uFibreA',
  photoCrumple: 'uPhotoCrumple',
  photoFibre: 'uPhotoFibre',
  ballR: 'uBallR',
  crumpleBite: 'uCrumpleBite',
  edgeFinish: 'uEdgeFinish',
  edgeNone: 'uEdgeNone',
  sheetCrumple: 'uSheetCrumple',
  sheetTile: 'uSheetTile',
  debug: 'uDebug',
} as const)
