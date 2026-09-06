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
 * ## The instrument calibrates itself
 *
 * The rendered reach is read off an RGBA8 raster whose coverage comes from an 8-bit-encoded field
 * built at `sdfRes`, so it carries an error the library's own arithmetic does not. That error is
 * MEASURED in the same run rather than guessed: `edgeVariance 0` clamps `tearAmpsFor`'s budget to
 * zero (`edge-derive.ts`'s "Known boundaries"), so the true band there is exactly
 * `W +- CHEW_REACH * chew` and whatever the instrument reads instead of that is its own error.
 * The sweep is gated on the band widened by that measured error plus two texels. The numbers are
 * in this task's report.
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
import { discAlpha, logoAlpha } from './test-fixtures.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import type { EdgeSpec } from '@paper-crumple/core/unstable'

// ---------------------------------------------------------------------------------------------
// The helper block (§10's harness). `cell` is the only helper that touches GL; the rest are pure
// over its result.
// ---------------------------------------------------------------------------------------------

/** design 2026-09-05 §6's default cell — the one `develop`'s `hull` was, by its descriptor set. */
const SMOOTH_CLEAN: EdgeSpec = { shape: 'smooth', finish: 'clean', widthUnit: 'px' }
const TORN_CLEAN: EdgeSpec = { shape: 'torn', finish: 'clean', widthUnit: 'px' }

/** The four `shape x finish` combinations at `widthUnit: 'px'` — §6's table, in reading order. */
const ALL_FOUR_CELLS: readonly EdgeSpec[] = [
  SMOOTH_CLEAN,
  { shape: 'smooth', finish: 'paper', widthUnit: 'px' },
  TORN_CLEAN,
  { shape: 'torn', finish: 'paper', widthUnit: 'px' },
]

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
  readonly handle: PaperSheetHandle
  /** The source plane this cell was built over — `LOGO_ALPHA` or `DISC_ALPHA`. */
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
function sheetFor(spec: EdgeSpec): PaperSheet {
  const key = `${spec.shape}/${spec.finish}/${spec.widthUnit}`
  const known = sheets.get(key)
  if (known !== undefined) return known
  const sheet = paperSheet(optionsFor(spec))
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
 */
async function cell(spec: EdgeSpec, knobs: Knobs = {}, alpha = LOGO_ALPHA): Promise<Cell> {
  const sheet = sheetFor(spec)
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
  const key = `${r.alpha === DISC_ALPHA ? 'disc' : 'logo'}:${r.size.w}x${r.size.h}@${r.artworkRect.x},${r.artworkRect.y}`
  const known = outsideCache.get(key)
  if (known !== undefined) return known
  const out = new Float32Array(r.size.w * r.size.h)
  if (r.alpha === DISC_ALPHA) {
    const cx = r.artworkRect.x + SRC / 2
    const cy = r.artworkRect.y + SRC / 2
    for (let y = 0; y < r.size.h; y++) {
      for (let x = 0; x < r.size.w; x++) {
        out[y * r.size.w + x] = Math.max(0, Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - DISC_R)
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
function reachOf(r: Cell): { min: number; max: number } {
  const dist = outsideDistance(r)
  const { w, h } = r.size
  const outside = exteriorOf((i) => r.front[i * 4 + 3] >= OPAQUE, w, h)
  let min = Infinity
  let max = -Infinity
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (r.front[i * 4 + 3] < OPAQUE) continue
      if (!(outside[i - 1] || outside[i + 1] || outside[i - w] || outside[i + w])) continue
      const d = dist[i]
      if (d < min) min = d
      if (d > max) max = d
    }
  }
  expect(Number.isFinite(min), 'no outer boundary — the sheet fills the whole front').toBe(true)
  const scale = refPerTexel(r.size)
  return { min: min * scale, max: max * scale }
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
  const m = measureHull(field, dims.w, dims.h, handle.hull as PackedHull, 4 / texel)
  return { min: m.vertexMin / k, max: m.vertexMax / k }
}

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
    handle: null as unknown as PaperSheetHandle,
    alpha: LOGO_ALPHA,
  }
}

// ---------------------------------------------------------------------------------------------
// The properties.
// ---------------------------------------------------------------------------------------------

describe('the width does not depend on the shape knobs (design 2026-09-05 §10)', () => {
  it('keeps the reach inside W (1 +- v) across every shape knob', async () => {
    // The instrument's own error, measured in this run rather than guessed (see the header). At
    // `edgeVariance 0` the tear budget clamps to zero, so the true band is exactly `W +- chewReach`.
    const chewReach = CHEW_REACH * Number(defaultsFor(TORN_CLEAN).chew)
    const amps = tearAmpsFor({
      widthRef: W,
      variance: 0,
      tearMix: Number(defaultsFor(TORN_CLEAN).tearMix),
      tearAngular: Number(defaultsFor(TORN_CLEAN).tearAngular),
      chew: Number(defaultsFor(TORN_CLEAN).chew),
    })
    expect(amps, 'the clamp is what makes the control a control').toEqual({
      tearAmp: 0,
      midAmp: 0,
    })
    const controlCell = await cell(TORN_CLEAN, { edgeVariance: 0 }, DISC_ALPHA)
    const control = reachOf(controlCell)
    // The control is an ASSERTION as well as a calibration, and it has to be: a defect in the
    // derivation would otherwise widen the control and the tolerance together, and the sweep below
    // would absorb its own regression. Verified by negative probe — forcing `variance: 1` into both
    // `tearAmpsFor` and `hullBandFor` (ruling R3's own defect) is caught HERE, on the control,
    // before the sweep runs. Three texels is the whole of what the raster owes: the coverage
    // threshold, the 8-bit distance encode and the field's own resolution.
    const bound = 3 * refPerTexel(controlCell.size)
    expect(Math.abs(control.min - (W - chewReach)), 'control min').toBeLessThanOrEqual(bound)
    expect(Math.abs(control.max - (W + chewReach)), 'control max').toBeLessThanOrEqual(bound)
    const errLo = Math.max(0, W - chewReach - control.min)
    const errHi = Math.max(0, control.max - (W + chewReach))

    const rows: string[] = []
    for (const shape of ['smooth', 'torn'] as const) {
      const spec: EdgeSpec = { shape, finish: 'clean', widthUnit: 'px' }
      const sweep =
        shape === 'torn'
          ? cross({
              tearFreq: [2, 9, 24],
              tearAngular: [0, 0.8, 1],
              looseness: [0, 0.5, 1],
              tearMix: [0, 0.6, 1],
            })
          : cross({ angularity: [0, 0.7, 1] })
      for (const knobs of sweep) {
        const r = await cell(spec, knobs, DISC_ALPHA)
        const dims = fieldDims(r.handle)
        const measured =
          shape === 'torn'
            ? reachOf(r)
            : vertexReachOf(r.handle, cpuField(r.handle, dims, DISC_ALPHA), dims)
        // Two texels on top of the instrument's measured error: the raster resolves nothing finer
        // than one, and under `smooth` the polygon was traced on the GPU flood's field and measured
        // against the CPU one, which disagree by up to the flood's own half texel.
        const slack = 2 * refPerTexel(r.size)
        const where = `${shape} ${JSON.stringify(knobs)}`
        rows.push(`${where} -> [${measured.min.toFixed(2)}, ${measured.max.toFixed(2)}]`)
        expect(measured.min, where).toBeGreaterThanOrEqual(W * (1 - V) - errLo - slack)
        expect(measured.max, where).toBeLessThanOrEqual(W * (1 + V) + errHi + slack)
      }
    }
    // measurement, not a gate — the band above is the gate; this is the readout the report quotes.
    expect(rows).toHaveLength(84)
  }, 600_000)

  /**
   * `edge-derive.ts`'s "Known boundaries": below `W v = CHEW_REACH * chew` the tear budget clamps to
   * zero and the lower reach becomes `W - CHEW_REACH * chew`, STRICTLY BELOW the `W (1 - v)` the
   * band identity would give. A variance sweep starting at 0 walks straight into that regime, so
   * the identity is gated outside it above, and the clamped behaviour is asserted here instead
   * rather than left as a hole. The clamp itself is exact arithmetic and is asserted as such; what
   * the raster adds is that the rendered band really does collapse with it.
   */
  it('clamps the tear budget to zero below W v = CHEW_REACH * chew, and the contour collapses with it', async () => {
    const chew = Number(defaultsFor(TORN_CLEAN).chew)
    const boundary = (CHEW_REACH * chew) / W // 0.0613 at the defaults
    expect(V, 'the shipped variance is well outside the clamped regime').toBeGreaterThan(boundary)
    for (const v of [0, boundary * 0.5]) {
      const amps = tearAmpsFor({
        widthRef: W,
        variance: v,
        tearMix: 0.6,
        tearAngular: 0.8,
        chew,
      })
      expect(amps.tearAmp, `v ${v}`).toBe(0)
      expect(amps.midAmp, `v ${v}`).toBe(0)
      // `W - CHEW_REACH * chew` is strictly below `W (1 - v)` exactly where the clamp engages.
      expect(W - CHEW_REACH * chew).toBeLessThan(W * (1 - v))
    }
    const clamped = reachOf(await cell(TORN_CLEAN, { edgeVariance: 0 }, DISC_ALPHA))
    const full = reachOf(await cell(TORN_CLEAN, {}, DISC_ALPHA))
    // The rendered band collapses onto `chew` alone: at least three times narrower than the shipped
    // one, and sitting inside it rather than beside it.
    expect(clamped.max - clamped.min).toBeLessThan((full.max - full.min) / 3)
    expect(clamped.min).toBeGreaterThan(full.min)
    expect(clamped.max).toBeLessThan(full.max)
  }, 300_000)
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
    expect(zero.handle.hull).toBe(HULL_USE_ALPHA) // no polygon
    expect(zero.handle.sdfRes).toBeGreaterThan(0) // the tight field still IS built
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
