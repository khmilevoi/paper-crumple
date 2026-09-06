/**
 * # The edge redesign's properties, at level 2 (design 2026-09-05 §10)
 *
 * Everything §10 asks for that no earlier task could assert, on the shipped `paperSheet` pipeline
 * rather than on a hand-built scene: the width does not depend on the shape knobs, both contour
 * shapes leave a solid annulus, `edgeWidth 0` collapses onto the artwork and takes the whole edge
 * out of the picture, and `smooth`/`clean` still puts the paper where `develop`'s `hull` put it.
 *
 * ## Units, once, because every number below is in one of two frames
 *
 * Knobs are quoted in **reference px** — `KNOB_REFERENCE_PX` of front height. This fixture's front
 * is 324 texels tall, so one texel is 3.086 reference px. Every tolerance below is a count of
 * TEXELS converted through `refPerTexel`, never a bare reference-px slack: a raster cannot resolve
 * a distance finer than its own texel, and "1 reference px" would be a third of one — unmeetable by
 * construction, and not a statement about the library.
 *
 * ## Two fixtures, and why
 *
 * `logoAlpha` is the fixture for everything about the FRONT — the zero-width collapse and the
 * migration frame — because a rich silhouette with holes, a slot and a detached island is what
 * those claims are worth testing on.
 *
 * It is the wrong fixture for the reach band, and that was measured rather than assumed. On a
 * concave silhouette the sheet closes over the holes and the slot, and a naive contour then reads
 * whatever sliver of a hole rim survives rasterisation as an inward reach — 10.80 reference px
 * against the true 22.09. `exteriorOf` fixes that part. What it cannot fix is that `looseness`'s
 * only remaining role (§6.1: the blurred field fills concavities, `scrapUnguarded`'s
 * `max(tight, loose)`) IS a reach change on a concave fixture, so the logo cannot separate "the
 * width moved" from "a concavity filled". The band sweep therefore runs on a **disc**, where the
 * distance to the artwork is analytic, there is no concavity for `looseness` to fill and no hole to
 * mistake for a contour. Measured on the disc, `looseness` 0 / 0.5 / 1 give the same reach to the
 * last texel — which is exactly what §6.1 claims and what the logo could not have shown.
 *
 * ## The instrument calibrates itself, and there are TWO of them
 *
 * Neither measurement is exact, and both errors are MEASURED in the same run rather than guessed.
 * `edgeVariance 0` clamps `tearAmpsFor`'s budget to zero (`edge-derive.ts`'s "Known boundaries"),
 * so the true band there is the single pair `W +- CHEW_REACH * chew` under `torn` and the single
 * distance `W` under `smooth` — and whatever an instrument reads instead of that is its own error.
 *
 * - The **raster** instrument (`reachOf`, for `torn`) reads coverage off an RGBA8 front whose field
 *   is 8-bit-encoded at `sdfRes`. Measured: 5.11 reference px low, 0.14 high. Its control is taken
 *   at `tearAngular 0`, which is load-bearing — at the shipped `0.8` the control is contaminated by
 *   the very `baseAngular` term the sweep exists to bound, and reads 1.9 reference px lower for
 *   that reason alone.
 * - The **vertex** instrument (`vertexReachOf`, for `smooth`) reads `measureHull` over the traced
 *   polygon against a reproduced CPU field. Its error depends on `angularity`, because the
 *   Douglas-Peucker tolerance does: measured 6.21 reference px at 0, 2.89 at 0.7 and at 1. It gets
 *   its own control at each swept value. Borrowing the raster's number for it, which is what the
 *   first version of this file did, calibrates nothing.
 *
 * Both are then given half a texel on top, and no more.
 *
 * ## The third known boundary
 *
 * `edge-derive.ts` documents two regimes where `W (1 +- v)` is not the law. This file found a third
 * and `edge-derive.ts` now documents that one too: `baseAngular` (`paper-shader.ts`) replaces the
 * base field with its piecewise-linear interpolant on a `tearFreq`-sized lattice, and `tearOf` adds
 * its octaves on top of THAT. The derivation models the octaves and not the interpolant. See
 * `angPullRef` below, and the case that pins it.
 *
 * ## `exact: true` is load-bearing
 *
 * Under `exact: false` the artwork's long side is chosen so artwork + margin fits `maxSize`, so it
 * MOVES when the reserve moves — and §4.2's guard margin does move between `develop` and this
 * branch. §9.1's golden frame would then carry the artwork at two different resolutions and an
 * `artworkRect`-aligned comparison would be comparing two different resamples of the source. Under
 * `exact: true` the artwork IS the source, 1:1 (`sheet.ts`, `aLongSide = sourceLongSide`), on both
 * branches; only the margin, and with it the front, differs.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { GlError, KNOB_REFERENCE_PX, SheetError, isAborted } from '@paper-crumple/core'
import type { Knobs, Rect, Size } from '@paper-crumple/core'
import { CHEW_REACH, tearAmpsFor } from './edge-derive.js'
import { cpuSdfFromAlpha } from './field.js'
import { dimsForLongSide } from './handle.js'
import type { PaperSheetHandle } from './handle.js'
import { measureHull } from './hull.js'
import { HULL_USE_ALPHA } from './hull-shape.js'
import type { PackedHull } from './hull-shape.js'
import { VARIANCE_KNOB, WIDTH_PX_KNOB, defaultsFor } from './paper-knobs.js'
import { optionsFor, paperSheet } from './sheet.js'
import type { PaperSheet } from './sheet.js'
import { discAlpha, logoAlpha, unionAlpha } from './test-fixtures.js'
import { ALL_FOUR_CELLS, SMOOTH_CLEAN, TORN_CLEAN, TORN_PAPER } from './testing/edge-cells.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import type { EdgeSpec } from '@paper-crumple/core/unstable'

// ---------------------------------------------------------------------------------------------
// The helper block (§10's harness). `cell` is the only helper that touches GL; the rest are pure
// over its result.
// ---------------------------------------------------------------------------------------------

/**
 * `W` and `v`, read from the descriptors that declare them rather than written as `47` / `0.53`
 * (ruling R10: the ban is on restating the implementation's inputs, not on pinning its outputs).
 */
const W = Number(WIDTH_PX_KNOB.default)
const V = Number(VARIANCE_KNOB.default)

/** The fixture's own three source parameters — the ones step 6a's capture pinned on `develop`. */
const SRC = 256
const MAX_SIZE = 512
const EXACT = true

/** The rich silhouette: holes, a slot and a detached island (`test-fixtures.ts`). */
const LOGO_ALPHA = logoAlpha(SRC)
/** The convex control. Radius chosen so `W (1 + v)` of paper still fits inside the front margin. */
const DISC_R = 96
const DISC_ALPHA = discAlpha(SRC, SRC, SRC / 2, SRC / 2, DISC_R)

/**
 * The CONCAVE control: two overlapping discs, so the silhouette has two reflex vertices.
 *
 * `baseAngular`'s interpolant is the reason this fixture exists. `paper-shader.ts`'s own header for
 * that block says it: "the interpolant of a convex SDF exceeds it outside every reflex vertex". On
 * the convex disc that term pulls the contour INWARD, which threatens nothing but the width claim;
 * at a reflex vertex it pushes OUTWARD, which threatens §4's reserve — and a reach past the reserve
 * is visible clipping, not a cosmetic difference. A disc cannot see that direction at all.
 *
 * Centres 64 texels apart at radius 56 give an interior angle of ~70 degrees at each reflex vertex,
 * which is the sharpest notch this fixture family reaches (further apart is blunter, closer fills
 * in).
 */
const LOBE_R = 56
const LOBE_A = { x: 96, y: 128 }
const LOBE_B = { x: 160, y: 128 }
const CONCAVE_ALPHA = unionAlpha(
  discAlpha(SRC, SRC, LOBE_A.x, LOBE_A.y, LOBE_R),
  discAlpha(SRC, SRC, LOBE_B.x, LOBE_B.y, LOBE_R),
)

/**
 * The SLIT: the same two discs pulled apart until the exterior between them is a slit rather than
 * a notch, which is the sharpest crease this fixture family can carry (final review, I2).
 *
 * The number that decides how hard `baseAngular` pushes at a reflex vertex is the angle between
 * the two nearest-feature gradients where the CONTOUR crosses the exterior medial ridge, not the
 * angle at the artwork's own corner. Across a ridge whose two gradients differ by `phi`, the base
 * field has a convex kink of slope `sin(phi/2)` on either side, and the interpolant's chord over a
 * lattice cell of side `L` overshoots it by at most `(L/2) sin(phi/2)`, blended at `tearAngular`.
 * So `sin(phi/2)` is the whole geometric factor, and it is what this fixture maximises.
 *
 * On `CONCAVE_ALPHA` (centres 64 apart, radius 56) the paper's own boundary meets the ridge at
 * `(0, sqrt((r + W)^2 - h^2))` and `phi = 2 atan(h / that)` — about 53 degrees, `sin(phi/2) = 0.45`.
 * Here the centres are 132 apart at the same radius: the discs no longer overlap at all (a
 * 20-texel gap, which the paper webs over), the ridge is the whole perpendicular bisector, and at
 * the paper's boundary `phi` is about 136 degrees, `sin(phi/2) = 0.93` — within 7 % of the 180
 * degrees a pair of parallel walls would give, i.e. essentially the review's slit. It is also
 * SUSTAINED: the ridge runs the full height of the front rather than fanning out from a point, so
 * the lattice cannot dodge it by phase.
 */
const SLIT_R = 56
const SLIT_A = { x: 62, y: 128 }
const SLIT_B = { x: 194, y: 128 }
const SLIT_ALPHA = unionAlpha(
  discAlpha(SRC, SRC, SLIT_A.x, SLIT_A.y, SLIT_R),
  discAlpha(SRC, SRC, SLIT_B.x, SLIT_B.y, SLIT_R),
)

/**
 * The discs every analytic fixture is built from, in SOURCE coordinates — the exterior distance to
 * a union of discs is the pointwise minimum of the discs' own, exactly, which is why these three
 * fixtures get an analytic `outsideDistance` and `logoAlpha` gets an EDT.
 */
const LOBES: ReadonlyMap<Float32Array, readonly { x: number; y: number; r: number }[]> = new Map([
  [DISC_ALPHA, [{ x: SRC / 2, y: SRC / 2, r: DISC_R }]],
  [
    CONCAVE_ALPHA,
    [
      { x: LOBE_A.x, y: LOBE_A.y, r: LOBE_R },
      { x: LOBE_B.x, y: LOBE_B.y, r: LOBE_R },
    ],
  ],
  [
    SLIT_ALPHA,
    [
      { x: SLIT_A.x, y: SLIT_A.y, r: SLIT_R },
      { x: SLIT_B.x, y: SLIT_B.y, r: SLIT_R },
    ],
  ],
])

/** The fixture's name, for a cache key and for a measurement row. */
const FIXTURE_NAMES: ReadonlyMap<Float32Array, string> = new Map([
  [DISC_ALPHA, 'disc'],
  [CONCAVE_ALPHA, 'concave'],
  [SLIT_ALPHA, 'slit'],
  [LOGO_ALPHA, 'logo'],
])

// The return type is inferred on purpose, as in `testing/fixture-sources.ts`: an explicit
// `Uint8ClampedArray` annotation widens the buffer parameter to `ArrayBufferLike` and `ImageData`
// then refuses it.
function bytesFor(alpha: Float32Array) {
  const out = new Uint8ClampedArray(SRC * SRC * 4)
  for (let i = 0; i < alpha.length; i++) {
    const p = i * 4
    out[p] = 220
    out[p + 1] = 190
    out[p + 2] = 120
    out[p + 3] = Math.round(alpha[i] * 255)
  }
  return out
}

interface Cell {
  readonly front: Uint8Array
  readonly size: Size
  readonly artworkRect: Rect
  /** `null` only for a `loadBaseline` frame, which is bytes on disk and never had a handle. */
  readonly handle: PaperSheetHandle | null
  /** The source plane this cell was built over. */
  readonly alpha: Float32Array
}

let fixture: PaperGlFixture | null = null
const sheets = new Map<string, PaperSheet>()

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  for (const [, sheet] of sheets) sheet.dispose()
  sheets.clear()
  outsideCache.clear()
  fixture?.dispose()
  fixture = null
})

function context() {
  if (fixture === null) {
    fixture = createGlFixture(8, 8)
    expect(
      fixture.gl,
      'no WebGL2 context — check the SwiftShader launch flags (§11)',
    ).not.toBeNull()
  }
  return fixture.ctx
}

/**
 * One sheet per `EdgeSpec`, reused across the knob sweeps below. A knob bag is a per-`source()`
 * input, not a factory one — reusing the sheet is what production does, and mounting eighty of them
 * would spend eighty scratch-pool allocations on nothing.
 */
function sheetFor(spec: EdgeSpec, headroom: number): PaperSheet {
  const key = `${spec.shape}/${spec.finish}/${spec.widthUnit}/${headroom}`
  const known = sheets.get(key)
  if (known !== undefined) return known
  const sheet = paperSheet({ ...optionsFor(spec), overscanHeadroom: headroom })
  expect(sheet.mount(context())).toBeUndefined()
  sheets.set(key, sheet)
  return sheet
}

function readFront(texture: WebGLTexture, w: number, h: number): Uint8Array {
  const ctx = context()
  const out = new Uint8Array(w * h * 4)
  const probe = ctx.gl.createFramebuffer()
  ctx.scope(() => {
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, probe)
    ctx.gl.framebufferTexture2D(
      ctx.gl.READ_FRAMEBUFFER,
      ctx.gl.COLOR_ATTACHMENT0,
      ctx.gl.TEXTURE_2D,
      texture,
      0,
    )
    ctx.gl.readPixels(0, 0, w, h, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
    ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, null)
  })
  ctx.gl.deleteFramebuffer(probe)
  return out
}

/**
 * Mounts (or reuses) a `paperSheet` for `spec`, sources `alpha` under the pinned three parameters,
 * builds one front at the handle's own front size and reads it back.
 *
 * The knob bag goes to BOTH `source()` and `build()`. Under `smooth` the width, the variance,
 * `angularity` and `seed` are hull-tier (§6.3), so a `build()` at a value `source()` did not trace
 * at is a `SourceExpiredError` — the bag has to reach the trace, not only the front.
 *
 * `optionsFor` is how an `EdgeSpec` becomes `PaperSheetOptions`: the field names differ
 * (`shape`/`finish`/`widthUnit` against `edgeShape`/`edgeFinish`/`edgeWidthUnit`) and the two are
 * not assignable (ruling R5).
 *
 * `headroom` is not decoration. `freezeOverscan` takes its reserve from the factory's DEFAULT knob
 * values (§4.4), so any `edgeVariance` above `VARIANCE_KNOB.default` leaves it and `build()`
 * answers "re-add required". The reserve radius a value asks for is `(1 + v) W + F + e`, so against
 * the 83.91 reference px a default sheet froze: `edgeVariance 0.6` asks for **87.2** — that is the
 * first value of the axis case below that gets refused, and the number in its error message — and
 * `edgeVariance 0.8` asks for **96.6**. The axis case therefore mounts its own sheet with headroom,
 * which is what a caller who wants those values has to do too.
 */
async function cell(
  spec: EdgeSpec,
  knobs: Knobs = {},
  alpha = LOGO_ALPHA,
  headroom = 0,
): Promise<Cell> {
  const sheet = sheetFor(spec, headroom)
  const values = { ...defaultsFor(spec), ...knobs }
  const bitmap = await createImageBitmap(new ImageData(bytesFor(alpha), SRC, SRC), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
  const handle = await sheet.source(bitmap, { maxSize: MAX_SIZE, exact: EXACT, knobs: values })
  bitmap.close()
  if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
    // `expect.fail` returns `never`, so this narrows — and it keeps the file inside §10.8's rule
    // that nothing outside `eslint.boundaries.js` throws.
    expect.fail(`source() refused for ${JSON.stringify(spec)}: ${String(handle)}`)
  }
  const front = sheet.build(handle, handle.front, values as never)
  if (front instanceof Error) expect.fail(`build() refused: ${front.message}`)
  const out: Cell = {
    front: readFront(front.texture, front.width, front.height),
    size: { w: front.width, h: front.height },
    artworkRect: front.artwork,
    handle,
    alpha,
  }
  sheet.releaseFront(front)
  return out
}

/** One texel of this front, in reference px — the frame every knob is quoted in. */
const refPerTexel = (size: Size): number => KNOB_REFERENCE_PX / size.h

/** The handle of a cell that was actually built, as opposed to a `loadBaseline` frame. */
function handleOf(r: Cell): PaperSheetHandle {
  if (r.handle === null) expect.fail('this cell came from loadBaseline and has no handle')
  return r.handle
}

/**
 * The artwork's own alpha plane, at an arbitrary resolution, placed exactly where `build()` places
 * the artwork inside the front. Under `exact: true` the artwork IS the source at 1:1, so at
 * `scale === 1` this is the bytes `cell` uploaded; it is resampled only for the field resolution.
 */
function artworkAlphaPlane(
  alpha: Float32Array,
  rect: Rect,
  size: Size,
  w: number,
  h: number,
): Float32Array {
  const plane = new Float32Array(w * h)
  const kx = size.w / w
  const ky = size.h / h
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Texel centre -> front px -> artwork-local px -> source px (1:1 under `exact: true`).
      const sx = (x + 0.5) * kx - rect.x - 0.5
      const sy = (y + 0.5) * ky - rect.y - 0.5
      if (sx < 0 || sy < 0 || sx > rect.w - 1 || sy > rect.h - 1) continue
      const x0 = Math.min(Math.floor(sx), SRC - 2)
      const y0 = Math.min(Math.floor(sy), SRC - 2)
      const fx = sx - x0
      const fy = sy - y0
      const i = y0 * SRC + x0
      plane[y * w + x] =
        (alpha[i] * (1 - fx) + alpha[i + 1] * fx) * (1 - fy) +
        (alpha[i + SRC] * (1 - fx) + alpha[i + SRC + 1] * fx) * fy
    }
  }
  return plane
}

/**
 * How far every point of the front sits OUTSIDE the artwork's alpha, in texels — 0 inside it.
 *
 * On the disc the distance is ANALYTIC, which is the point of using a disc: `cpuSdfFromAlpha` is a
 * Euclidean transform between texel centres over a thresholded plane, and its half-texel
 * quantisation would land inside the tolerance this file is trying to measure. On the logo it is
 * `cpuSdfFromAlpha` (positive inside, so negated and clamped), which is all a free-form silhouette
 * admits. Memoised on the front's geometry: every cell here shares one, and an EDT over 324^2 is
 * not free.
 */
const outsideCache = new Map<string, Float32Array>()
function outsideDistance(r: Cell): Float32Array {
  const kind = FIXTURE_NAMES.get(r.alpha) ?? 'logo'
  const key = `${kind}:${r.size.w}x${r.size.h}@${r.artworkRect.x},${r.artworkRect.y}`
  const known = outsideCache.get(key)
  if (known !== undefined) return known
  const out = new Float32Array(r.size.w * r.size.h)
  const analytic = LOBES.get(r.alpha)
  if (analytic !== undefined) {
    const lobes = analytic.map((l) => ({
      x: r.artworkRect.x + l.x,
      y: r.artworkRect.y + l.y,
      r: l.r,
    }))
    for (let y = 0; y < r.size.h; y++) {
      for (let x = 0; x < r.size.w; x++) {
        let d = Infinity
        for (const l of lobes) d = Math.min(d, Math.hypot(x + 0.5 - l.x, y + 0.5 - l.y) - l.r)
        out[y * r.size.w + x] = Math.max(0, d)
      }
    }
  } else {
    const plane = artworkAlphaPlane(r.alpha, r.artworkRect, r.size, r.size.w, r.size.h)
    const signed = cpuSdfFromAlpha(plane, r.size.w, r.size.h)
    for (let i = 0; i < signed.length; i++) out[i] = Math.max(0, -signed[i])
  }
  outsideCache.set(key, out)
  return out
}

const OPAQUE = 128

/**
 * The texels reachable from the front's border without ever crossing `solid` — the OUTER exterior.
 *
 * Load-bearing, not a convenience: see the header's note on `logoAlpha`'s holes.
 */
function exteriorOf(solid: (i: number) => boolean, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (i: number) => {
    if (seen[i] === 0 && !solid(i)) {
      seen[i] = 1
      stack.push(i)
    }
  }
  for (let x = 0; x < w; x++) {
    push(x)
    push((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    push(y * w)
    push(y * w + w - 1)
  }
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    const x = i % w
    const y = (i - x) / w
    if (x > 0) push(i - 1)
    if (x < w - 1) push(i + 1)
    if (y > 0) push(i - w)
    if (y < h - 1) push(i + w)
  }
  return seen
}

/**
 * The rendered silhouette's own reach past the artwork, in reference px: the smallest and largest
 * distance any texel of the rendered sheet's OUTER boundary sits at from the artwork's alpha.
 *
 * This is the measurement for `torn`, whose contour is the shader's own tear rather than a polygon,
 * and it is also how §9.1's two migration frames are compared.
 */
function reachOf(r: Cell): { min: number; max: number; boxMax: number } {
  const dist = outsideDistance(r)
  const { w, h } = r.size
  const outside = exteriorOf((i) => r.front[i * 4 + 3] >= OPAQUE, w, h)
  // The alpha's own box, in front texels: `signedFieldExtent`'s `raw`, reproduced from the same
  // distance field this file already builds (`dist === 0` is exactly `signed >= 0`).
  let bx0 = Infinity
  let bx1 = -Infinity
  let by0 = Infinity
  let by1 = -Infinity
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (dist[y * w + x] > 0) continue
      if (x < bx0) bx0 = x
      if (x > bx1) bx1 = x
      if (y < by0) by0 = y
      if (y > by1) by1 = y
    }
  }
  let min = Infinity
  let max = -Infinity
  let boxMax = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (r.front[i * 4 + 3] < OPAQUE) continue
      if (!(outside[i - 1] || outside[i + 1] || outside[i - w] || outside[i + w])) continue
      const d = dist[i]
      if (d < min) min = d
      if (d > max) max = d
      // `checkGuardBand` protects the alpha BOX grown per axis by `overscanRadius * k`
      // (`reachRect` / `growBox`, `sheet.ts`), so what actually clips is the Chebyshev excess past
      // that box — not the Euclidean distance to the alpha. On a convex fixture the two agree; in
      // a concavity they do not, and only this one is a statement about the front.
      const beyond = Math.max(bx0 - x, x - bx1, by0 - y, y - by1, 0)
      if (beyond > boxMax) boxMax = beyond
    }
  }
  expect(Number.isFinite(min), 'no outer boundary — the sheet fills the whole front').toBe(true)
  const scale = refPerTexel(r.size)
  return { min: min * scale, max: max * scale, boxMax: boxMax * scale }
}

/**
 * The `smooth` measurement: `measureHull` over the traced polygon, divided by the trace's own texel
 * scale, in reference px.
 *
 * §5.1's repair pass inserts vertices whose mean is `W (1 - v/2)` and a chord reaches further than
 * the vertices it joins, so the band claim is about VERTICES, not about every point of the outline
 * — there is no closed inversion for the mean over the whole contour. Measured on the disc control
 * (`edgeVariance 0`, where the band collapses to the single distance `W`), the RENDERED contour
 * spans 12.50 to 15.53 texels against the 15.23 the vertices sit at: the Douglas-Peucker chords cut
 * up to 2.7 texels inside the circle they approximate. That is why this measurement exists.
 */
function vertexReachOf(
  handle: PaperSheetHandle,
  field: Float32Array,
  dims: Size,
): { min: number; max: number } {
  expect(handle.hull.kind, 'vertexReachOf wants a traced polygon').toBe('polygons')
  const texel = handle.front.w / dims.w
  const k = handle.front.h / KNOB_REFERENCE_PX / texel
  // No `sampleStep`: it only refines `segmentMin`, which this measurement does not read, and the
  // value `source()` traces at is `HULL_SAMPLE_PX / texel` — a private constant in `sheet.ts` that
  // this file has no business mirroring for an argument that changes nothing it looks at.
  const m = measureHull(field, dims.w, dims.h, handle.hull as PackedHull)
  return { min: m.vertexMin / k, max: m.vertexMax / k }
}

/**
 * `paper-shader.ts`'s own `ANG_FREQ`, mirrored here the way ruling R11 mirrors `CHEW_REACH`: it is
 * a GLSL constant inside the shader source string and there is no TS export to import. The two must
 * move together — if `ANG_FREQ` changes in `paper-shader.ts`, this changes with it.
 */
const ANG_FREQ = 1.2

/**
 * The side of the lattice `baseAngular` interpolates the base field on, in REFERENCE px.
 *
 * `paper-shader.ts` writes the cell as `uPlanePx / (uTearFreq * ANG_FREQ)` working px and
 * `uPlanePx` is the front's height, so the front cancels out of the reference-px form entirely and
 * this depends on `tearFreq` alone: 417 reference px at `tearFreq 2`, 93 at the shipped 9 (the
 * figure the shader's own comment quotes), 35 at 24.
 */
const angCellRef = (tearFreq: number): number =>
  KNOB_REFERENCE_PX / (Math.max(tearFreq, 1e-4) * ANG_FREQ)

/**
 * How far `baseAngular` pulls the contour INWARD on a convex arc of radius `rhoRef`, in reference px
 * — **the third known boundary of `edge-derive.ts`**, and the one this task found.
 *
 * `baseAngular` replaces the base field `tight + W` with its piecewise-linear interpolant on that
 * lattice and blends the two with weight `uTearAngular`; `tearOf` then adds its octaves on top of
 * `baseAng`, not on top of `base`. `edge-derive.ts` models the octaves and not this term. On a
 * convex arc the interpolant of a concave function lies below it by the chord sag `L^2 / (8 rho)`,
 * so the contour is pulled in by `ang * L^2 / (8 rho)`: 51 reference px at `tearFreq 2` on this
 * fixture, 2.5 at the shipped 9, 0.4 at 24 — a `1 / tearFreq^2` law, which is why the shipped
 * default is barely touched and the descriptor's minimum is not.
 */
const angPullRef = (tearFreq: number, tearAngular: number, rhoRef: number): number =>
  (tearAngular * angCellRef(tearFreq) ** 2) / (8 * rhoRef)

/** The field dimensions `source()` derives for this handle (`fieldDimsFor` in `sheet.ts`). */
const fieldDims = (handle: PaperSheetHandle): Size =>
  dimsForLongSide(handle.sdfRes, handle.front.w, handle.front.h, 2)

/**
 * The signed field the hull was traced on, REPRODUCED rather than observed.
 *
 * `source()` traces on a read-back of the GPU jump flood and retains it nowhere; its own CPU
 * fallback (`cpuFieldFallback` in `sheet.ts`) builds exactly this — the artwork's alpha drawn into
 * its 1:1 placement at the field's resolution, through `cpuSdfFromAlpha`. The two agree to the
 * flood's own half texel, which is one of the two reasons `vertexReachOf`'s assertions are stated
 * in texels rather than in reference px.
 */
function cpuField(handle: PaperSheetHandle, dims: Size, alpha: Float32Array): Float32Array {
  const rect: Rect = {
    x: handle.marginX,
    y: handle.marginY,
    w: handle.artwork.w,
    h: handle.artwork.h,
  }
  return cpuSdfFromAlpha(
    artworkAlphaPlane(alpha, rect, handle.front, dims.w, dims.h),
    dims.w,
    dims.h,
  )
}

/**
 * The fraction of the band `0 … innerRef` reference px OUTSIDE the artwork's alpha that the front
 * renders fully opaque. A fold needs a solid annulus there, in both contour shapes (§5.1, §8).
 */
function fractionOpaqueWithin(r: Cell, innerRef: number): number {
  const dist = outsideDistance(r)
  const plane = artworkAlphaPlane(r.alpha, r.artworkRect, r.size, r.size.w, r.size.h)
  // The band the ANNULUS is: outside the artwork's outer silhouette, never inside a hole the sheet
  // closed over (see `exteriorOf`).
  const outside = exteriorOf((i) => plane[i] >= 0.5, r.size.w, r.size.h)
  const inner = innerRef / refPerTexel(r.size)
  let total = 0
  let solid = 0
  for (let i = 0; i < dist.length; i++) {
    if (outside[i] === 0) continue
    if (!(dist[i] > 0 && dist[i] <= inner)) continue
    total++
    if (r.front[i * 4 + 3] === 255) solid++
  }
  expect(total, 'the annulus window is empty — the fixture or the width moved').toBeGreaterThan(0)
  return solid / total
}

/**
 * The worst departure of the rendered alpha from the artwork's own alpha, in 1/255, over the texels
 * where the artwork alpha is FLAT — 0 or 1 with the same value on all four neighbours.
 *
 * The transition band is excluded on purpose and it is not slack. The front's coverage is a
 * smoothstep over the tight field (`uAaPx`, `paper-shader.ts`) and that field is built at `sdfRes`
 * — 192 texels here against the artwork's 256 — so on an anti-aliased rim the two disagree by a
 * fraction of a texel's worth of coverage whatever the edge is doing. Measured on this fixture:
 * 25/255 over the whole plane, 0/255 once the rim is excluded. What §7 and §2.5 claim is the strong
 * half — at `edgeWidth 0` the sheet is the artwork and there is no border anywhere — and that claim
 * lives entirely in the flat texels: every one outside the silhouette must read empty and every one
 * inside must read solid.
 */
function silhouetteMatchesAlpha(r: Cell, tolerance: number): number {
  const plane = artworkAlphaPlane(r.alpha, r.artworkRect, r.size, r.size.w, r.size.h)
  const { w, h } = r.size
  let worst = 0
  let flat = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const a = plane[i]
      if (a !== 0 && a !== 1) continue
      if (plane[i - 1] !== a || plane[i + 1] !== a || plane[i - w] !== a || plane[i + w] !== a) {
        continue
      }
      flat++
      worst = Math.max(worst, Math.abs(r.front[i * 4 + 3] - Math.round(a * 255)))
    }
  }
  expect(flat, 'no flat texels — the fixture is not an alpha plane').toBeGreaterThan(0)
  expect(worst, `silhouette departs from the artwork alpha by ${worst}/255`).toBeLessThanOrEqual(
    tolerance,
  )
  return worst
}

/** Any channel of two equally sized fronts differing by more than 2/255. */
function pixelsDiffer(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 2) return true
  return false
}

/**
 * The max absolute channel difference over the two fronts' `artworkRect`-aligned windows,
 * optionally restricted to a mask in artwork-local coordinates.
 */
function alignedOnArtworkRect(a: Cell, b: Cell, mask?: Uint8Array): number {
  const w = Math.min(a.artworkRect.w, b.artworkRect.w)
  const h = Math.min(a.artworkRect.h, b.artworkRect.h)
  let worst = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask !== undefined && mask[y * w + x] === 0) continue
      const pa = ((a.artworkRect.y + y) * a.size.w + a.artworkRect.x + x) * 4
      const pb = ((b.artworkRect.y + y) * b.size.w + b.artworkRect.x + x) * 4
      for (let c = 0; c < 4; c++) {
        worst = Math.max(worst, Math.abs(a.front[pa + c] - b.front[pb + c]))
      }
    }
  }
  return worst
}

/**
 * The artwork's flat-opaque interior, in artwork-local coordinates: alpha 1 with alpha 1 on all
 * four neighbours. This is exactly the region `frontFastPath()`'s deep-inside early-out writes
 * `img.rgb` verbatim into, and therefore the region two frames of the same artwork must agree on
 * byte for byte whatever the edge did (§7.4.2).
 */
function artworkInterior(r: Cell): Uint8Array {
  const { w, h } = r.artworkRect
  const mask = new Uint8Array(w * h)
  const flat = (x: number, y: number) => r.alpha[y * SRC + x] === 1
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!flat(x, y) || !flat(x - 1, y) || !flat(x + 1, y) || !flat(x, y - 1) || !flat(x, y + 1)) {
        continue
      }
      mask[y * w + x] = 1
      count++
    }
  }
  expect(count, 'the artwork has no flat-opaque interior').toBeGreaterThan(1000)
  return mask
}

/** The cartesian product of the named sweeps. */
function cross(o: Record<string, readonly number[]>): readonly Knobs[] {
  let out: Knobs[] = [{}]
  for (const [key, values] of Object.entries(o)) {
    out = out.flatMap((base) => values.map((v) => ({ ...base, [key]: v })))
  }
  return out
}

/**
 * Writes a measurement table where a reader can find it, and logs it.
 *
 * Vitest's browser mode swallows `console.log` under the default reporter — verified, `grep` over a
 * full run finds no trace of it — so a measurement that only logs is a measurement nobody can
 * reproduce. The `console.log` is kept because a non-default reporter does surface it, but the file
 * is what makes the tables real: `packages/paper/src/__screenshots__/<name>.txt`, beside the failure
 * frames Vitest itself writes there and gitignored on the same line. They are the evidence behind
 * this task's report and re-running one `it` regenerates them.
 *
 * A run that cannot write — a fresh clone with no `__screenshots__` directory yet — is not a failing
 * run: these tables are a readout, not a gate, and the assertions above them do not depend on the
 * write succeeding.
 */
async function publish(name: string, rows: readonly string[]): Promise<void> {
  const text = rows.join('\n') + '\n'
  console.log(`[edge-redesign] ${name}, reference px\n${text}`)
  await commands
    .writeFile(`packages/paper/src/__screenshots__/${name}.txt`, text)
    .catch(() => undefined)
}

/**
 * A frame committed under `packages/paper/src/__screenshots__/edge-redesign/`, gzipped and base64'd
 * at capture time — a raw 308x308 RGBA readback is 380 kB and does not belong in the history at
 * that size.
 */
async function loadBaseline(name: string): Promise<Cell> {
  expect(name, 'only one baseline exists').toBe('hull-default')
  const json = (await import('./__screenshots__/edge-redesign/hull-default.json')).default
  const raw = atob(json.gzipBase64)
  const packed = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) packed[i] = raw.charCodeAt(i)
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))
  return {
    front: new Uint8Array(await new Response(stream).arrayBuffer()),
    size: json.size,
    artworkRect: json.artworkRect,
    handle: null,
    alpha: LOGO_ALPHA,
  }
}

// ---------------------------------------------------------------------------------------------
// The properties.
// ---------------------------------------------------------------------------------------------

describe('the width does not depend on the shape knobs (design 2026-09-05 §10)', () => {
  const chewReach = () => CHEW_REACH * Number(defaultsFor(TORN_CLEAN).chew)
  /** The radius of the disc's own PAPER contour, in reference px: the disc plus one width. */
  const DISC_RHO_REF = DISC_R * (KNOB_REFERENCE_PX / 324) + W
  /** `tearFloor = tight + 0.4 * uBaseBias` (`paper-shader.ts`), as a fraction of `W`. */
  const FLOOR_FRACTION = 0.4

  /**
   * The instrument's own error, measured in this run rather than guessed.
   *
   * At `edgeVariance 0` the tear budget clamps to zero (`edge-derive.ts`'s "Known boundaries"), so
   * the true band is exactly `W +- CHEW_REACH * chew` and whatever the raster reads instead of that
   * is its own error: the coverage threshold, the 8-bit distance encode and the field's resolution.
   *
   * **At `tearAngular 0`, and that is load-bearing.** A control taken at the shipped `0.8` is
   * contaminated by `baseAngular` — the very term the sweep is trying to bound — and reads 1.9
   * reference px lower for that reason alone (measured: 37.13 against 39.01). Calibrating on a
   * contaminated control is how the first version of this case came to pass a cell whose contour was
   * sitting on the shader's floor.
   *
   * The control is an ASSERTION as well as a calibration, and it has to be: a defect in the
   * derivation would otherwise widen the control and the tolerance together and the sweep would
   * absorb its own regression. Verified by negative probe (ruling R3's own defect, a literal
   * variance in place of the resolved knob) — it is caught HERE, before the sweep runs.
   */
  async function instrumentError() {
    const c = await cell(TORN_CLEAN, { edgeVariance: 0, tearAngular: 0 }, DISC_ALPHA)
    const control = reachOf(c)
    const bound = 3 * refPerTexel(c.size)
    expect(Math.abs(control.min - (W - chewReach())), 'control min').toBeLessThanOrEqual(bound)
    expect(Math.abs(control.max - (W + chewReach())), 'control max').toBeLessThanOrEqual(bound)
    return {
      lo: Math.max(0, W - chewReach() - control.min),
      hi: Math.max(0, control.max - (W + chewReach())),
      slack: 0.5 * refPerTexel(c.size),
      control,
    }
  }

  it('keeps the reach inside W (1 +- v) across every shape knob', async () => {
    const amps = tearAmpsFor({
      widthRef: W,
      variance: 0,
      tearMix: Number(defaultsFor(TORN_CLEAN).tearMix),
      tearAngular: Number(defaultsFor(TORN_CLEAN).tearAngular),
      chew: Number(defaultsFor(TORN_CLEAN).chew),
    })
    expect(amps, 'the clamp is what makes the control a control').toEqual({ tearAmp: 0, midAmp: 0 })
    const err = await instrumentError()

    const rows: string[] = [
      `control (torn, edgeVariance 0, tearAngular 0) [${err.control.min.toFixed(2)}, ${err.control.max.toFixed(2)}]` +
        ` -> errLo ${err.lo.toFixed(2)} errHi ${err.hi.toFixed(2)} slack ${err.slack.toFixed(2)}`,
    ]

    // `smooth` is measured on VERTICES and calibrates per `angularity`: the Douglas-Peucker
    // tolerance is `toleranceFor(angularity)`, so the vertex instrument is a different one at each
    // value (measured: 6.21 reference px of error at 0, 2.89 at 0.7 and at 1). Borrowing the
    // RASTER's own `errLo` for a measurement that never touches a raster, which is what the first
    // version of this case did, is not a calibration of anything.
    for (const angularity of [0, 0.7, 1]) {
      const control = await cell(SMOOTH_CLEAN, { angularity, edgeVariance: 0 }, DISC_ALPHA)
      const cd = fieldDims(handleOf(control))
      const c = vertexReachOf(handleOf(control), cpuField(handleOf(control), cd, DISC_ALPHA), cd)
      // At `edgeVariance 0` the band `hullBandFor` hands the tracer collapses onto the single
      // distance `W`, so every vertex must sit there.
      const bound = 3 * refPerTexel(control.size)
      expect(Math.abs(c.min - W), `smooth control min @ ${angularity}`).toBeLessThanOrEqual(bound)
      expect(Math.abs(c.max - W), `smooth control max @ ${angularity}`).toBeLessThanOrEqual(bound)
      const lo = Math.max(0, W - c.min)
      const hi = Math.max(0, c.max - W)
      rows.push(
        `control (smooth, edgeVariance 0, angularity ${angularity}) [${c.min.toFixed(2)}, ${c.max.toFixed(2)}]` +
          ` -> errLo ${lo.toFixed(2)} errHi ${hi.toFixed(2)}`,
      )
      const r = await cell(SMOOTH_CLEAN, { angularity }, DISC_ALPHA)
      const rd = fieldDims(handleOf(r))
      const m = vertexReachOf(handleOf(r), cpuField(handleOf(r), rd, DISC_ALPHA), rd)
      const where = `smooth angularity ${angularity}`
      rows.push(`${where} -> [${m.min.toFixed(2)}, ${m.max.toFixed(2)}]`)
      expect(m.min, where).toBeGreaterThanOrEqual(W * (1 - V) - lo - err.slack)
      expect(m.max, where).toBeLessThanOrEqual(W * (1 + V) + hi + err.slack)
    }

    const sweep = cross({
      tearFreq: [2, 9, 24],
      tearAngular: [0, 0.8, 1],
      looseness: [0, 0.5, 1],
      tearMix: [0, 0.6, 1],
    })
    for (const knobs of sweep) {
      const r = await cell(TORN_CLEAN, knobs, DISC_ALPHA)
      const m = reachOf(r)
      const pull = angPullRef(Number(knobs.tearFreq), Number(knobs.tearAngular), DISC_RHO_REF)
      // The law each cell is held to, in reference px:
      //
      //  - `W (1 - v)`, the invariant itself, wherever `baseAngular` cannot move the contour by more
      //    than the raster can resolve — every `tearAngular 0` cell, and every cell whose lattice is
      //    fine enough that the chord sag is under half a texel;
      //  - `W (1 - v) - pull` where that term bites, which is the THIRD known boundary and is not
      //    part of §10's claim. It is asserted rather than skipped so that every cell of the sweep
      //    is still held to a bound, and the boundary itself is pinned by the case below;
      //  - and, under both, the shader's own `tearFloor` — `0.4 W`, less the teeth `chew` puts under
      //    it — which is what actually stops the contour at `tearFreq 2`.
      const floor = FLOOR_FRACTION * W - chewReach()
      const invariant = W * (1 - V)
      const holds = pull <= err.slack
      const low = (holds ? invariant : Math.max(floor, invariant - pull)) - err.lo - err.slack
      const where = `torn ${JSON.stringify(knobs)}`
      rows.push(
        `${where} -> [${m.min.toFixed(2)}, ${m.max.toFixed(2)}] pull ${pull.toFixed(2)}` +
          ` law ${holds ? 'W(1-v)' : 'boundary'} low ${low.toFixed(2)}`,
      )
      expect(m.min, where).toBeGreaterThanOrEqual(low)
      expect(m.max, where).toBeLessThanOrEqual(W * (1 + V) + err.hi + err.slack)
    }

    // measurement, not a gate — the laws above are the gate. Printed so the report's table can be
    // reproduced by re-running this one case.
    await publish('reach-sweep', rows)
    expect(rows).toHaveLength(sweep.length + 7)
  }, 900_000)

  /**
   * **The third known boundary, and the finding this task exists to have produced.**
   *
   * `baseAngular` (`paper-shader.ts`) replaces the base field with its piecewise-linear interpolant
   * on a `KNOB_REFERENCE_PX / (tearFreq * ANG_FREQ)` lattice, blended at weight `uTearAngular`, and
   * `tearOf` then adds its octaves on top of THAT. `edge-derive.ts` does not model the term at all,
   * so `W (1 - v)` is not the law at low `tearFreq` and non-zero `tearAngular`: the contour is
   * pulled inward by the chord sag until the shader's own `tearFloor` catches it.
   *
   * The mechanism is asserted, not only its symptom:
   *
   * 1. at `tearFreq 2` the reach depends on `tearAngular` and on nothing else this case varies — at
   *    `0` the contour is where the control is, at the shipped `0.8` it is on the floor, and the
   *    CEILING comes down with the floor, which noise cannot do (see the assertion's own comment for
   *    why the band also widens, and why that is the interpolant's signature rather than scatter);
   * 2. the swing follows `1 / tearFreq^2`, so the same swing at `tearFreq 24` is an order of
   *    magnitude smaller;
   * 3. the floor is where it stops — pinned from BOTH sides, so halving or removing `tearFloor`
   *    fails this case rather than quietly widening the band.
   */
  it('is pulled to the tear floor by baseAngular at low tearFreq, and stops there', async () => {
    const err = await instrumentError()
    const floor = FLOOR_FRACTION * W - chewReach()
    const at = async (tearFreq: number, tearAngular: number) =>
      reachOf(await cell(TORN_CLEAN, { edgeVariance: 0, tearFreq, tearAngular }, DISC_ALPHA))

    const ang = Number(defaultsFor(TORN_CLEAN).tearAngular)
    const lowFlat = await at(2, 0)
    const lowAngular = await at(2, ang)
    const highFlat = await at(24, 0)
    const highAngular = await at(24, ang)

    // 1. `tearAngular` alone moves it, and at `tearFreq 2` it moves it out of the band entirely.
    expect(
      Math.abs(lowFlat.min - err.control.min),
      'at tearAngular 0 the frequency changes nothing',
    ).toBeLessThanOrEqual(err.slack)
    expect(
      lowAngular.min,
      'the band is breached — this is the boundary, not a defect in the test',
    ).toBeLessThan(W * (1 - V) - err.lo - err.slack)
    // The MAX comes down too, which is the half that rules scatter out: noise widens a band from
    // both ends, and a term that only added noise could not have lowered the ceiling.
    //
    // The band does WIDEN as well — measured, 10.35 reference px at `tearAngular 0` against 23.42 at
    // 0.8 — and that is the interpolant's own signature rather than a contradiction. `baseAngular`
    // is EXACT at the lattice nodes and wrong only between them, so the parts of the contour that
    // land on a node keep their old distance while the parts mid-cell are pulled the full chord sag
    // down. The floor catches the second group and not the first, so the two ends move by different
    // amounts. What is asserted is only the ceiling coming down.
    expect(lowAngular.max, 'the ceiling comes down, which noise cannot do').toBeLessThan(
      lowFlat.max - err.lo,
    )

    // 2. `1 / tearFreq^2`: the same swing twelve times finer is at least ten times smaller.
    const lowDrop = lowFlat.min - lowAngular.min
    const highDrop = Math.abs(highFlat.min - highAngular.min)
    expect(lowDrop, `drop at freq 2 ${lowDrop} against at 24 ${highDrop}`).toBeGreaterThan(
      10 * highDrop,
    )
    expect(angPullRef(2, ang, DISC_RHO_REF) / angPullRef(24, ang, DISC_RHO_REF)).toBeCloseTo(144, 6)

    // 3. It stops ON the floor: not below it, and not above it either.
    expect(lowAngular.min, 'below the floor').toBeGreaterThanOrEqual(floor - err.lo - err.slack)
    expect(lowAngular.min, 'above the floor').toBeLessThanOrEqual(floor + err.hi + err.slack)
  }, 600_000)

  /**
   * `edge-derive.ts`'s FIRST known boundary: below `W v = CHEW_REACH * chew` the tear budget clamps
   * to zero and the lower reach becomes `W - CHEW_REACH * chew`, below the `W (1 - v)` the band
   * identity would give. Its SECOND: past `v > 0.6` the floor `tearFloor = tight + 0.4 W` binds
   * first and the true lower reach is `max(W (1 - v), 0.4 W)`.
   *
   * Both are walked here, at the boundary values themselves and on either side, because
   * `edgeVariance` is not a shape knob and so is absent from the sweep above — neither boundary was
   * otherwise visited.
   */
  it('walks the edgeVariance axis across both of edge-derive.ts own known boundaries', async () => {
    const chew = Number(defaultsFor(TORN_CLEAN).chew)
    const clampBoundary = (CHEW_REACH * chew) / W // 0.0613 at the defaults
    const floorBoundary = 1 - FLOOR_FRACTION // where `W (1 - v)` meets `0.4 W`
    expect(clampBoundary).toBeCloseTo(0.0613, 4)
    expect(floorBoundary).toBeCloseTo(0.6, 12)
    expect(V, 'the shipped variance sits between the two boundaries').toBeGreaterThan(clampBoundary)
    expect(V).toBeLessThan(floorBoundary)

    for (const v of [0, clampBoundary * 0.5, clampBoundary]) {
      const a = tearAmpsFor({
        widthRef: W,
        variance: v,
        tearMix: Number(defaultsFor(TORN_CLEAN).tearMix),
        tearAngular: Number(defaultsFor(TORN_CLEAN).tearAngular),
        chew,
      })
      expect(a.tearAmp, `v ${v}`).toBe(0)
      expect(a.midAmp, `v ${v}`).toBe(0)
      expect(W - CHEW_REACH * chew, `v ${v}`).toBeLessThanOrEqual(W * (1 - v))
    }

    // Above the shipped default the RESERVE is the binding constraint, not the band: `freezeOverscan`
    // froze it at `VARIANCE_KNOB.default`, so these values need a sheet of their own (see `cell`).
    const err = await instrumentError()
    const floor = FLOOR_FRACTION * W - chewReach()
    const pull = angPullRef(
      Number(defaultsFor(TORN_CLEAN).tearFreq),
      Number(defaultsFor(TORN_CLEAN).tearAngular),
      DISC_RHO_REF,
    )
    const rows: string[] = []
    for (const v of [clampBoundary, 0.3, V, floorBoundary, 0.8]) {
      const m = reachOf(await cell(TORN_CLEAN, { edgeVariance: v }, DISC_ALPHA, 0.25))
      rows.push(`edgeVariance ${v.toFixed(4)} -> [${m.min.toFixed(2)}, ${m.max.toFixed(2)}]`)
      // `max(W (1 - v), 0.4 W)` is the law across the whole axis — the identity below 0.6, the floor
      // above it — less the shipped `tearFreq`'s own `baseAngular` allowance, which every one of
      // these cells carries.
      const low = Math.max(floor, W * (1 - v) - pull) - err.lo - err.slack
      expect(m.min, `edgeVariance ${v}`).toBeGreaterThanOrEqual(low)
    }
    await publish('edge-variance-axis', rows)
    expect(rows).toHaveLength(5)
  }, 600_000)

  /**
   * **The outward direction, which a disc cannot see.**
   *
   * The same interpolant that pulls inward on a convex arc pushes OUTWARD at a reflex vertex —
   * `paper-shader.ts`'s own header for `baseAngular` says so: "the interpolant of a convex SDF
   * exceeds it outside every reflex vertex". Inward costs the width claim; outward costs §4's
   * reserve, and a reach past the reserve is visible clipping rather than a cosmetic difference.
   *
   * Only the UPPER bound is asserted, against the sprite's own frozen reserve radius. The inward
   * side of a concave fixture is not a width measurement at all — the sheet closes over the notch —
   * and is left to the disc.
   */
  it('never reaches past the frozen reserve, on a silhouette with reflex vertices', async () => {
    const rows: string[] = []
    const cases: readonly Knobs[] = [
      {},
      { tearFreq: 2 },
      { tearFreq: 24 },
      { tearAngular: 1 },
      { tearMix: 1 },
    ]
    for (const knobs of cases) {
      const r = await cell(TORN_CLEAN, knobs, CONCAVE_ALPHA)
      const m = reachOf(r)
      const reserve = handleOf(r).reserve.radius
      rows.push(
        `concave ${JSON.stringify(knobs)} -> max ${m.max.toFixed(2)} of reserve ${reserve.toFixed(2)}`,
      )
      // The reserve is the paint radius PLUS `EDGE_SLOP_REFERENCE_PX`; the reach has to fit inside
      // the whole of it, which is what `checkGuardBand` protects and what clips when it does not.
      expect(m.max, `concave ${JSON.stringify(knobs)}`).toBeLessThanOrEqual(reserve)
    }

    // ATTRIBUTION. The concave fixture's worst outward reach is larger than the disc's at the same
    // knobs, and without a control that difference cannot be told apart from the noise landing on a
    // different phase against a different silhouette. `baseAngular` is gated on `uTearAngular`, so
    // switching it off while holding everything else fixed isolates it: what survives at
    // `tearAngular 0` is the noise, and what the swing to the shipped 0.8 adds is the interpolant.
    // Doing it on BOTH fixtures separates the reflex-vertex part from the part the disc already
    // shows. Reported, not gated — the bound above is the gate.
    const at = async (alpha: Float32Array, tearAngular: number) =>
      reachOf(await cell(TORN_CLEAN, { tearFreq: 24, tearAngular }, alpha)).max
    const ang = Number(defaultsFor(TORN_CLEAN).tearAngular)
    const concaveFlat = await at(CONCAVE_ALPHA, 0)
    const concaveAngular = await at(CONCAVE_ALPHA, ang)
    const discFlat = await at(DISC_ALPHA, 0)
    const discAngular = await at(DISC_ALPHA, ang)
    rows.push(
      `attribution at tearFreq 24: concave ${concaveFlat.toFixed(2)} -> ${concaveAngular.toFixed(2)}` +
        ` (delta ${(concaveAngular - concaveFlat).toFixed(2)}), disc ${discFlat.toFixed(2)} -> ${discAngular.toFixed(2)}` +
        ` (delta ${(discAngular - discFlat).toFixed(2)}), reflex share ` +
        `${(concaveAngular - concaveFlat - (discAngular - discFlat)).toFixed(2)}`,
    )

    // THE `paper` FINISH, on the same fixture, at the same worst `tearFreq`. Everything above is
    // `torn`/`clean`, and the finish terms are ADDITIVE with no mechanism that could shrink
    // `baseAngular`'s error — so this stacks the worst measured frequency with the one untested
    // cell of §6's table.
    //
    // The honest question is NOT whether the reach grows. It must: a deckle band and a fibre fringe
    // are drawn outside the rim. It is whether it grows FASTER THAN THE RESERVE, which the same
    // finish also raises — `edgeParamsFrom` feeds `4 * fiberLen + deckleWidth` into `freezeOverscan`
    // as `finishTerms`, about 23 reference px at the shipped defaults. So both sides of the
    // comparison move, and only their difference is a safety statement. Compared against THIS
    // sprite's own frozen reserve, never against the `clean` one.
    const paper = await cell(TORN_PAPER, { tearFreq: 24 }, CONCAVE_ALPHA)
    const paperReach = reachOf(paper).max
    const paperReserve = handleOf(paper).reserve.radius
    const cleanReserve = handleOf(await cell(TORN_CLEAN, { tearFreq: 24 }, CONCAVE_ALPHA)).reserve
      .radius
    rows.push(
      `concave torn/paper {"tearFreq":24} -> max ${paperReach.toFixed(2)} of reserve ${paperReserve.toFixed(2)}` +
        ` (margin ${(paperReserve - paperReach).toFixed(2)}; torn/clean margin was ` +
        `${(cleanReserve - concaveAngular).toFixed(2)})`,
    )
    expect(paperReach, 'concave torn/paper at tearFreq 24').toBeLessThanOrEqual(paperReserve)

    await publish('concave-outward-reach', rows)
    expect(rows).toHaveLength(cases.length + 2)
  }, 600_000)

  /**
   * **The outward push across THREE fixtures, six knob rows and three lattice phases.**
   *
   * The case above passes its bound on one fixture at one seed, and that is not enough to call the
   * reserve safe: `baseAngular`'s overshoot at a reflex vertex is a LATTICE-PHASE artefact, so one
   * seed measures one alignment of the lattice against one notch. The phase is `uSeed * 1.7`
   * (`paper-shader.ts`), and `uSeed = (seed % 17) + 0.31 seed` (`paper-renderer.ts`), so seeds
   * 3 / 5 / 13 put the lattice at fractional offsets 0.68 / 0.14 / 0.95 of a cell — three
   * different alignments rather than three different noises.
   *
   * The three fixtures span the geometry the push cares about: `CONCAVE_ALPHA`'s 53-degree crease
   * at the paper's own boundary, `SLIT_ALPHA`'s 136-degree one (see its own note), and `logoAlpha`
   * — real artwork, whose ring, slot and detached island put reflex vertices at the box edge where
   * the exterior medial ridge leaves the bounding box, which is the geometry that can push the
   * sheet past a reserve rather than merely fill a notch.
   *
   * `tearFreq` {2, 9, 24} crossed with `tearAngular` {0.8, 1} covers the lattice from 417 reference
   * px down to 35 at both blends that ship: the overshoot bound `(L/2) sin(phi/2) tearAngular`
   * grows with `L`, while the fraction of the contour that can find a badly phased cell falls with
   * it, so the worst row is not predictable a priori and is measured at every combination.
   *
   * Each cell is held to ITS OWN frozen `reserve.radius` — the sprite's, not the fixture family's
   * — because `source()` freezes the reserve per sprite (§4.4) and a comparison against any other
   * sprite's number is not a safety statement.
   *
   * **TWO measures, and only one of them is §4.** The case above compares the EUCLIDEAN distance
   * from the artwork's alpha against the reserve. That is the right instrument on a convex fixture
   * and the wrong one in a concavity: what `source()` reserves is the alpha BOX grown per axis by
   * `overscanRadius * k` (`reachRect` / `growBox`, `sheet.ts`), and that is what `checkGuardBand`
   * holds inside the front. Paper filling a notch is far from the alpha and nowhere near leaving
   * the box; only paper past the box clips. Both are reported here; the gate is the box.
   *
   * The weaker Euclidean claim does NOT hold, and that is the finding: it fails on the slit at
   * seven of these fifty-four cells. It is asserted from the other side instead — every failure is
   * a slit cell — so a Euclidean overrun appearing on `concave` or on real artwork fails here.
   */
  it('holds the outward reach inside the frozen reserve, across fixtures, lattices and phases', async () => {
    const fixtures = [
      ['concave', CONCAVE_ALPHA],
      ['slit', SLIT_ALPHA],
      ['logo', LOGO_ALPHA],
    ] as const
    const seeds = [3, 5, 13] as const
    const freqs = [2, 9, 24] as const
    const angulars = [0.8, 1] as const

    const rows: string[] = []
    const boxOverruns: string[] = []
    const alphaOverruns: string[] = []
    let worst = { where: '', margin: Infinity, max: 0, reserve: 0 }
    let worstBox = { where: '', margin: Infinity, max: 0, reserve: 0 }
    for (const [name, alpha] of fixtures) {
      for (const tearFreq of freqs) {
        for (const tearAngular of angulars) {
          for (const seed of seeds) {
            const r = await cell(TORN_CLEAN, { tearFreq, tearAngular, seed }, alpha)
            const m = reachOf(r)
            const reserve = handleOf(r).reserve.radius
            const margin = reserve - m.max
            const where = `${name} tearFreq ${tearFreq} tearAngular ${tearAngular} seed ${seed}`
            rows.push(
              `${where} -> max ${m.max.toFixed(2)} of reserve ${reserve.toFixed(2)}` +
                ` margin ${margin.toFixed(2)} (${((margin / reserve) * 100).toFixed(1)} %)` +
                ` | box ${m.boxMax.toFixed(2)} margin ${(reserve - m.boxMax).toFixed(2)}` +
                ` (${(((reserve - m.boxMax) / reserve) * 100).toFixed(1)} %)`,
            )
            const boxMargin = reserve - m.boxMax
            if (margin < worst.margin) worst = { where, margin, max: m.max, reserve }
            if (boxMargin < worstBox.margin) {
              worstBox = { where, margin: boxMargin, max: m.boxMax, reserve }
            }
            if (margin < 0) alphaOverruns.push(where)
            if (boxMargin < 0) boxOverruns.push(where)
          }
        }
      }
    }
    rows.push(
      `WORST alpha-euclidean ${worst.where} -> max ${worst.max.toFixed(2)} of reserve ` +
        `${worst.reserve.toFixed(2)} margin ${worst.margin.toFixed(2)}` +
        ` (${((worst.margin / worst.reserve) * 100).toFixed(1)} %)`,
      `WORST box (the guard band's own measure) ${worstBox.where} -> box ${worstBox.max.toFixed(2)}` +
        ` of reserve ${worstBox.reserve.toFixed(2)} margin ${worstBox.margin.toFixed(2)}` +
        ` (${((worstBox.margin / worstBox.reserve) * 100).toFixed(1)} %)`,
      `alpha-euclidean overruns: ${alphaOverruns.length} of ${rows.length} — ${alphaOverruns.join('; ')}`,
    )
    await publish('reflex-reserve-sweep', rows)
    expect(rows).toHaveLength(fixtures.length * freqs.length * angulars.length * seeds.length + 3)
    // THE GATE. Nothing the sheet paints leaves the reserve the front actually allocates.
    expect(boxOverruns, 'cells whose paint left the reserved box — this one is §4').toEqual([])
    // THE FINDING, from the other side. The Euclidean-from-alpha reading of the same reserve is
    // breached, and only ever inside the slit's own concavity: a breach on `concave` or on real
    // artwork would be a different statement and has to fail here rather than be absorbed.
    expect(
      alphaOverruns.filter((w) => !w.startsWith('slit')),
      'a Euclidean overrun somewhere other than the slit concavity',
    ).toEqual([])
  }, 1_800_000)
})

describe('both contour shapes leave a solid annulus (design 2026-09-05 §5.1, §8)', () => {
  it('leaves a solid annulus in BOTH contour shapes, which is what a fold needs', async () => {
    for (const shape of ['smooth', 'torn'] as const) {
      const r = await cell({ shape, finish: 'paper', widthUnit: 'px' }, {}, DISC_ALPHA)
      // The window stops 2 TEXELS short of the annulus's own edge, expressed in reference px. That
      // is not slack for the test's convenience: the repair guarantees `s <= -(lo - 0.25)` at
      // samples `HULL_SAMPLE_PX / texel` apart and the field is 1-Lipschitz, so the dip between
      // samples is at most `sampleStep/2`, and rasterisation and the JFA each add half a texel
      // (§5.1).
      const inner = W * (1 - V) - 2 * refPerTexel(r.size)
      expect(fractionOpaqueWithin(r, inner), shape).toBeGreaterThan(0.99)
    }
  }, 300_000)
})

describe('edgeWidth 0 (design 2026-09-05 §7, §2.5)', () => {
  it('collapses to the artwork at edgeWidth 0', async () => {
    const spec: EdgeSpec = { shape: 'torn', finish: 'paper', widthUnit: 'px' }
    const zero = await cell(spec, { edgeWidth: 0 })
    silhouetteMatchesAlpha(zero, 1)
    const decorated = await cell(spec, { edgeWidth: 0, deckleWidth: 40, fibers: 1, tearShadow: 1 })
    const plain = await cell(spec, { edgeWidth: 0, deckleWidth: 0, fibers: 0, tearShadow: 0 })
    expect(pixelsDiffer(decorated.front, plain.front)).toBe(false) // §2.5's zero rule
    expect(handleOf(zero).hull).toBe(HULL_USE_ALPHA) // no polygon
    expect(handleOf(zero).sdfRes).toBeGreaterThan(0) // the tight field still IS built
  }, 300_000)
})

describe('the edge is out of the picture at width 0 (design 2026-09-05 §8, guarantee 1)', () => {
  /**
   * DEVIATION from the brief's step 5, recorded in this task's report, on TWO counts.
   *
   * 1. `posesDiffer` cannot exist in `packages/paper`. A pose is a `motion` concept; `renderFront`
   *    pins `uFoldCount = 0` and `#define PAPER_FRONT_BUILD 1` compiles every fold path out of the
   *    program this package links (`paper-shader.ts`, P7's edit 9), and `packages/paper` depends on
   *    `@paper-crumple/motion` neither directly nor through the repository root. No test in this
   *    package can put two poses through one sheet.
   *
   * 2. "The shading stack still runs at `edgeWidth 0`" is FALSE BY DESIGN, and measuring it is how
   *    that was established. `frontFastPath()`'s deep-inside early-out writes `vec4(img.rgb, 1.0)`
   *    verbatim for an opaque artwork texel the tear's floor already covers, so the front's shading
   *    lives entirely in the ANNULUS. At `edgeWidth 0` there is no annulus: measured, zeroing
   *    `sheetCrumple`, `creases`, `facetStrength`, `grain`, `photoCrumple` and `photoFibre` changes
   *    not one texel of a width-0 front, in all four cells.
   *
   * What survives — and is a genuinely new property no earlier task pinned — is the other half of
   * guarantee 1: at `edgeWidth 0` the edge stops mattering ENTIRELY. All four cells of §6's table
   * render the same artwork and nothing else, so nothing downstream can see which cell it was built
   * under. §2.5's zero rule says the finish is off at width 0; this says the shape is too.
   *
   * Compared through `artworkRect` rather than as whole fronts, because the fronts are NOT the same
   * size: `freezeOverscan` takes its reserve from the factory's DEFAULT knob values (§4.4), so a
   * `paper` cell reserves `fiberLen + deckleWidth` of finish terms and gets a wider margin whatever
   * a later `build()` sets the width to.
   */
  it('renders the artwork and nothing else, in all four cells at edgeWidth 0', async () => {
    const reference = await cell(SMOOTH_CLEAN, { edgeWidth: 0 })
    const interior = artworkInterior(reference)
    for (const spec of ALL_FOUR_CELLS) {
      const r = await cell(spec, { edgeWidth: 0 })
      const label = `${JSON.stringify(spec)} @ edgeWidth 0`
      // It is a sheet at all, not an empty front — the assertion the rest of this rests on.
      expect(
        r.front.some((v, i) => i % 4 === 3 && v === 255),
        label,
      ).toBe(true)
      // Every flat texel is the artwork's own alpha: solid inside, empty outside, no border.
      expect(silhouetteMatchesAlpha(r, 1), label).toBe(0)
      // And the bytes inside are the same bytes, cell for cell.
      expect(alignedOnArtworkRect(reference, r, interior), label).toBe(0)
    }
  }, 600_000)

  it('does shade the annulus once there is one, in every cell of the four', async () => {
    const FLAT: Knobs = {
      sheetCrumple: 0,
      creases: 0,
      facetStrength: 0,
      grain: 0,
      photoCrumple: 0,
      photoFibre: 0,
    }
    for (const spec of ALL_FOUR_CELLS) {
      const shaded = await cell(spec, { edgeWidth: W })
      const flat = await cell(spec, { ...FLAT, edgeWidth: W })
      expect(pixelsDiffer(shaded.front, flat.front), JSON.stringify(spec)).toBe(true)
    }
  }, 600_000)
})

describe('the migration golden frame (design 2026-09-05 §9.1)', () => {
  /**
   * DEVIATION from the brief's step 6b, recorded in this task's report.
   *
   * The brief asks for `alignedOnArtworkRect(now, before) <= 1`. Measured, it is 255, and the cause
   * is neither a defect nor a tolerance that wants widening: §4.2's guard margin grows the per-side
   * margin from 26 texels to 34 on this fixture, so the front grows from 308 to 324 — and
   * `sprite-px` is reference px OF FRONT HEIGHT (`pxScale = front.h / KNOB_REFERENCE_PX`,
   * `sheet.ts`), so the same `W = 47` reference px lands 5.2 % further out in artwork texels than it
   * did on `develop`. The rim moves by about 1.2 texels, which on a ~800-texel perimeter flips
   * ~2 300 of the 65 536 compared texels between paper and nothing. No `artworkRect` alignment can
   * absorb that, because it is a scale difference and not an offset.
   *
   * So the frame is compared in the frame §9.1 itself quotes — REFERENCE px, where `W = 47`,
   * `v = 0.53` derives `minDist = 22.09` / `maxDist = 71.91` against today's `22` / `72` — plus the
   * one pixel claim that survives the scale change: `frontFastPath()`'s deep-inside early-out writes
   * `img.rgb` verbatim, so every flat interior texel of the artwork must still be byte for byte what
   * it was. Bit-exactness over the whole rect is not claimed and must not be asserted.
   *
   * What is asserted is the DIFFERENCE of the two reaches, not either one on its own. The absolute
   * figures (14.6 reference px of inward reach on this fixture, against the 22.09 `hullBandFor`
   * derives) carry the raster's own bias and the logo's concavities — see the header — and the two
   * frames carry them identically, which is what makes the comparison sound and the absolutes
   * uninteresting.
   */
  it("puts the paper's edge where develop's hull put it, in reference px", async () => {
    const now = await cell(SMOOTH_CLEAN)
    const before = await loadBaseline('hull-default') // captured on `develop` @ 222eda7, step 6a
    expect(before.artworkRect.w).toBe(now.artworkRect.w)
    expect(before.artworkRect.h).toBe(now.artworkRect.h)
    const here = reachOf(now)
    const there = reachOf(before)
    // One texel of the coarser of the two rasters, which is `develop`'s smaller front.
    const slack = refPerTexel(before.size)
    expect(Math.abs(here.min - there.min), `min ${here.min} vs ${there.min}`).toBeLessThanOrEqual(
      slack,
    )
    expect(Math.abs(here.max - there.max), `max ${here.max} vs ${there.max}`).toBeLessThanOrEqual(
      slack,
    )
  }, 300_000)

  it("keeps develop's own bytes inside the artwork, aligned on artworkRect", async () => {
    const now = await cell(SMOOTH_CLEAN)
    const before = await loadBaseline('hull-default')
    expect(alignedOnArtworkRect(now, before, artworkInterior(now))).toBe(0)
  }, 300_000)
})
