---
'@paper-crumple/core': minor
---

The GL foundation: the concrete `GlContext` behind `@paper-crumple/core/unstable`.

`createGlContext` wraps a WebGL2 context with §7.3's attribute bag, reads `caps` — `floatRT`,
`maxTextureSize` and `timer` — once, and pins the ambient state that silently corrupts a byte:
`DITHER` off, `UNPACK_COLORSPACE_CONVERSION_WEBGL` set to `NONE`, `UNPACK_FLIP_Y_WEBGL` not
inherited, blending, scissoring, depth and the two coverage modes off, and the whole colour mask
open. `program`, `texture` and `target` return a `GlError` rather than throwing; textures are
immutable single-level storage in one of six formats and never `SRGB8_ALPHA8`.

The **outermost** `scope()` saves and restores **exactly** what §5.1 enumerates and no more — a
scope entered while another is live on the same context restores nothing at its own exit, the way
§7.3's nested `batch` is a no-op rather than a double save — so a slot that leaves `DEPTH_TEST` on
cannot reach the next outermost scope, and a slot that binds on a texture unit other than the
active one still leaks, which is what "exactly" costs and is documented rather than quietly
widened. `DrawScope` has no `clear()` and no route to the canvas: the view performs a scissored
clear over its own rect and a slot never chooses its destination.

`gl.exactByteFetch` is probed once at creation — a 256×1 `RGBA8` upload recovered through
`uint(texelFetch(…) * 255.0 + 0.5)` into an `RGBA8UI` target and read back. With it true a slot
drops the `RGBA8UI` staging texture and its `ArrayBufferView`, 3.8 MB of heap; the `usampler2D`
form stays the normative definition and the fallback, so a false costs speed and never
correctness.

The two scratch pools are two because their sizing laws differ: Pool A is sized by `maxSize` and
refuses to grow past §8.1's budget, Pool B is sized by the source, holds one slot keyed by sprite,
and starts its idle interval only when the artwork slot stops holding that sprite — so a
re-source never falls through to a re-load.

And the GLSL ES 3.00 twin of `identityResample`, with `precision highp int` declared, its axis
plan recomputed per fragment rather than uploaded, and no clamp anywhere. A level-2 suite on
headless Chromium under SwiftShader asserts it byte-identical to the TypeScript reference across
998→384, 951→384, 4096→64, 3→2, an exact 2×, a magnification and ratio 1, from raw-byte fixtures
and never a PNG.
