/**
 * `paperSheet()` — the sheet slot's factory, `mount`/`dispose` and the front's life (task 10 of
 * `2026-08-26-p10-paper-sheet-renderer`).
 *
 * **This file is written by three tasks, in sequence, and stays additive across them.** Task 10
 * (here) owns the factory, `mount`, `dispose`, the tile-load race and the `Mounted` closure
 * shape. Task 11 replaces `source()`'s body — the hull trace, the resample, the field build —
 * and is also where `mounted.pools` / `mounted.sdf` are actually created, lazily, at the first
 * sprite's own `artwork` / `sdfRes` figures (§8.1: `createScratchPools` needs both, and neither
 * is known until a sprite exists). Task 12 replaces `build()`, `releaseFront()` and `release()`.
 * Until its own task lands, each of those four methods is a documented, loud placeholder — never
 * a throw, never a silent no-op, never a fake success — so this module type-checks as a complete
 * `SheetRenderer` at every commit in between.
 */
import {
  ABORTED,
  attempt,
  GlError,
  isAborted,
  KnobError,
  SheetError,
  SourceExpiredError,
} from '@paper-crumple/core'
import type {
  Aborted,
  BuildError,
  Knobs,
  Rect,
  SheetFront,
  SheetKnobs,
  SheetRenderer,
  Size,
  SourceError,
  SourceOptions,
} from '@paper-crumple/core'
import {
  checkGuardBand,
  createScratchPools,
  drawTargetFor,
  hullCacheKey,
  KNOB_REFERENCE_PX,
  overscanRadius,
  uploadBytes,
} from '@paper-crumple/core/unstable'
import type { GlContext, ScratchPools, Texture } from '@paper-crumple/core/unstable'
import { createResampler } from './artwork.js'
import type { Resampler } from './artwork.js'
import { cpuSdfFromAlpha } from './field.js'
import { growBox, scaleBox, sheetRectFromExtent, signedFieldExtent } from './extent.js'
import type { AlphaBox } from './mask.js'
import { createSdfBuilder, sigmaFor, SDF_POOL_SLOTS } from './gl-sdf.js'
import type { Field, LooseField, SdfBuilder } from './gl-sdf.js'
import {
  checkReserve,
  dimsForLongSide,
  freezeOverscan,
  frontForArtwork,
  handleBytesFor,
} from './handle.js'
import type { PaperSheetHandle } from './handle.js'
import { hullCache } from './hull-cache.js'
import type { HullCache, HullCacheKey } from './hull-cache.js'
import { DISTANCE_WAVELENGTH_PX, buildHull, fillHullMask, toleranceFor } from './hull.js'
import { boundsExtent, hullBounds, hullComponentCount } from './hull-shape.js'
import type { HullShape, VertexBounds } from './hull-shape.js'
import { defaultsFor, descriptorsFor, edgeParamsFrom, resolveSdfRes } from './paper-knobs.js'
import type { PaperEdgeMode } from './paper-knobs.js'
import { createPaperRenderer } from './paper-renderer.js'
import type { PaperRenderer } from './paper-renderer.js'
import { loadTileBitmaps, mountNeutralTiles, TILE_NAMES, uploadTiles } from './paper-tiles.js'
import type { MountedTiles } from './paper-tiles.js'
import type { PaperTileSet } from './tile-set.js'

/** Working px between the hull repair pass's samples along every polygon segment (`engine.js:9`). */
const HULL_SAMPLE_PX = 4

/**
 * Factory options for `paperSheet()` (spec 6.5, 14).
 *
 * **`edgeMode` is a factory option, not a knob.** Spec 6.5's rule: "a setting that changes …
 * the set of other knobs is a factory option." `edgeMode` changes which of the 34 possible
 * descriptors `sheet.knobs` even contains — a `hull` factory's array (24 entries) simply has no
 * `tearAmp` in it, rather than an inert one a `hull` consumer's autocomplete still offers.
 * Default: `'hull'` — `paper.js:2029`'s own default, "the polygon cut sheet".
 *
 * **`tiles` defaults to `null` (spec 14).** Not for weight — the four re-encoded tiles are
 * 397 478 B, 0.74x one motion pack, so weight alone no longer carries the default — but because
 * the default edge mode is `hull`, which needs no tear, no teeth and no fibre at all: the modal
 * consumer would be charged for an asset their own configuration cannot use. A build before the
 * (opt-in) tiles land renders with the 1x1 neutral planes, which is exactly the render with the
 * photograph turned off (`paper.js:2085-2091`'s own comment, reproduced in `paper-tiles.ts`).
 *
 * `overscanHeadroom` defaults to `0` and is the factory-level room a consumer can reserve for a
 * live edge-knob slider before any sprite exists; see `PaperSheet.overscan`'s own doc comment for
 * how this differs from the per-sprite reserve `add()` freezes (spec 8.6, `handle.ts`).
 */
export interface PaperSheetOptions {
  readonly edgeMode?: PaperEdgeMode
  readonly tiles?: PaperTileSet | null
  readonly overscanHeadroom?: number
}

/**
 * `paperSheet()`'s own contract: `SheetRenderer` plus the two names this slot adds.
 *
 * **`overscan` is THE reserve: every sprite's, not only a square one's.** It is computed once,
 * synchronously, as `freezeOverscan(edgeParamsFrom(edgeMode, defaultsFor(edgeMode)),
 * overscanHeadroom).overscan` — this factory's *default* knob values plus the headroom, before
 * any sprite exists — and `source()` freezes exactly this number onto every handle. Spec 5.2
 * puts one readonly number on `SheetRenderer` because the core reads `sheet.overscan` to size
 * its surface before `add()` has produced a handle to ask instead, and with an aspect-free
 * reserve that number is exact: a front's long side is at most `artwork × (1 + 2·overscan)`
 * for every aspect (`frontForArtwork` in `handle.ts`).
 *
 * The reserve is applied as `ceil(overscan × artwork.h)` texels on every side of the artwork,
 * not as a uv fraction, so a tall sprite's x margin holds the paint radius without the radius
 * being scaled by `h / w`. Spec 8.6's "derived per sprite from its edge parameters and frozen at
 * `add()`" is read here as: derived from THIS FACTORY'S edge parameters — its defaults and its
 * headroom — and frozen for the sprite's life. It is deliberately NOT
 * read as "from whatever the knobs held when the sprite was added": `maxDist` is a hull-tier
 * knob, every hull-tier write re-runs `source()` (spec 6.3), and `source()` has no memory of an
 * earlier handle — a reserve taken from the live values would be re-frozen on every re-source,
 * which is exactly the silent artwork rescale the frozen reserve exists to forbid. The one
 * consistent reading is the one `build()`'s step-4 `checkReserve` already implements: the
 * factory's reserve is the ceiling, a knob past it is "re-add required", and `overscanHeadroom`
 * is the way to buy room before any sprite exists.
 */
export interface PaperSheet extends SheetRenderer<Knobs, PaperSheetHandle> {
  readonly edgeMode: PaperEdgeMode
  /**
   * Resolves once the tile fetch this `mount()` started has landed: `true` on a successful
   * swap-in of the real tiles, or immediately to `true` when `tiles` is `null` (nothing to
   * fetch), or to a `GlError` — this promise never rejects (spec 5.2's "errors are values"
   * extended to a promise that is fire-and-forget by construction).
   *
   * Level-2 tests must `await` this before any byte comparison, for the reason `engine.js`'s own
   * `ready` exists: "a harness that writes byte-reproducible screenshots must not have a race
   * deciding what it captured." A `build()` that runs before this settles is not a bug — it
   * draws with the 1x1 neutral tile planes, which is a legitimate render (task 4's derivation:
   * "the photograph turned off") — but it is a *different* render than one that ran after.
   */
  readonly tilesReady: Promise<InstanceType<typeof GlError> | true>

  /**
   * `invalidateHull(spriteKey)` — P8's `HullCache.invalidate`, exposed for the `replace()` path
   * P9 calls down when a conditional re-supply comes back `200` (§18 amendment 10). Returns how
   * many cached variants were dropped.
   *
   * `spriteKey` is this slot's own `paper:<n>` surrogate (`PaperSheetHandle.spriteKey`), which the
   * stage's own key is not — §5.2 passes no key down to `source()`. A caller that cannot name the
   * surrogate passes `'*'`, which clears every sprite's cache entirely rather than none of them.
   */
  invalidateHull(spriteKey: string): number

  /**
   * **Test-only**, and never assigned by production code. The level-2 suite installs this to
   * drive `source()`'s third abort check point (§10.5) deterministically: `source()` calls it
   * synchronously right after a freshly traced hull lands in the cache and before the abort check
   * that follows, which is the one moment no signal-timing trick from outside `source()` can
   * reliably hit. A name no consumer could mistake for API.
   */
  __afterHullForTest?: () => void

  /**
   * **Test-only**, and never assigned by production code. The level-2 suite installs this to
   * drive `source()`'s SECOND abort check point (§10.5) deterministically: `source()` calls it
   * synchronously right after the two field passes (`buildField`/`blurField`) succeed and BEFORE
   * the `await` that check point 2 sits behind — the only way to make an abort land inside that
   * window without a race, since nothing else in this call ever yields before it (fix round 1,
   * finding 2: the level-2 suite had no way to reach this check point at all before this hook
   * existed). A name no consumer could mistake for API, by the same convention as
   * `__afterHullForTest`.
   */
  __afterFieldForTest?: () => void
}

/** A `resolve`-only deferred: `.promise` is handed out immediately, `.resolve` settles it once. */
interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/**
 * The mount-time state, built once by `mount(ctx)` and torn down once by `dispose()`. A closure
 * variable in `paperSheet()`, never a class field: §4.0's illegal states are a *stage*'s, and a
 * slot has exactly one, "mounted or not", which `mounted === null` already states completely.
 *
 * **`pools` and `sdf` are `null` here and stay `null` until task 11's `source()` creates them.**
 * `createScratchPools` needs `artwork` (§8.1's Pool A sizing law is `maxSize`-derived) and
 * `sdfRes`, and neither is known until a sprite exists — so `mount()`, which runs before any
 * sprite does, cannot build either. `source()` creates both lazily, at the first sprite's own
 * figures, and reuses them for every sprite after; a later sprite whose `maxSize` needs a bigger
 * Pool A re-creates both, disposing the previous set first. `dispose()` still owns freeing
 * whichever pair, if any, `source()` built by the time it runs.
 */
interface Mounted {
  readonly ctx: GlContext
  pools: ScratchPools | null
  sdf: SdfBuilder | null
  /** What `pools`/`sdf` were last built for — `null` exactly when they are. `ensurePools` (below)
   *  compares against this to decide reuse vs. a dispose-and-rebuild (task 11's own addition). */
  poolsSize: { artwork: Size; sdfRes: number } | null
  readonly resampler: Resampler
  readonly renderer: PaperRenderer
  readonly cache: HullCache
  tiles: MountedTiles
  /** Every front texture `build()` handed out and the core has not yet released, so `dispose()`
   *  can free any the core forgot (§8.1, §8.9's front tier must stay true even on a leak). */
  readonly liveFronts: Set<Texture>
  /** `releaseFront` finds the texture behind a returned `SheetFront` record here — the record
   *  itself carries a raw `WebGLTexture`, not this package's own `Texture` wrapper, so `dispose`
   *  cannot call `.dispose()` on it without this map. */
  readonly frontTextures: WeakMap<SheetFront, { texture: Texture }>
  /**
   * Live handles per spriteKey. A spriteKey is minted per bitmap OBJECT IDENTITY
   * (`spriteInfoFor`, below), so re-`source()`ing a bitmap the caller still holds open — core's
   * §8.5 re-source of a borrowed `ImageBitmap`, once another sprite has taken the artwork slot —
   * yields a second handle under the FIRST one's key, sharing its hull entry and its slot.
   * `release()` hands those back only with the last handle under the key: without the count,
   * releasing the superseded handle would free what the live one had just re-sourced, and the
   * live one's next `build()` would expire again, forever.
   */
  readonly liveHandles: Map<string, number>
  /**
   * Task 12's own addition: what the last `buildField`/`blurField` call (from either `source()`
   * or `build()`) left the shared Pool A field slots holding. `buildField`/`blurField` write into
   * one shared `sdf.tight` / `sdf.loose` slot apiece (§8.1) — there is no per-sprite storage for a
   * field — so a later `build()` call can only skip pass A (the jump flood) when it is asking for
   * exactly what this record already holds: the same sprite, at the same requested size. `null`
   * until the first `source()`/`build()` call, and reset to `null` whenever `ensurePools` disposes
   * and rebuilds the pools this record's `Field`s point into (a size a later sprite needs that
   * this mount's Pool A was not sized for).
   *
   * **Fix round 1, finding 1 — investigated, found unreachable, no change made to this record's
   * own keying.** The worry: `build(A)` after `build(B)` (or `source(B)`) at the same bucket size
   * could reuse a stale `spriteKey === A` record while the physical slot actually holds `B`'s
   * field. It cannot, by construction: `build()`'s own step 3 (above) refuses with
   * `SourceExpiredError` whenever `pools.poolA.artworkKey() !== handle.spriteKey`, and the ONLY
   * way `artworkKey` becomes `A` again after having been displaced is another `source(A)` call —
   * which (since this fix round) unconditionally re-runs `buildField`/`blurField` and re-writes
   * THIS record for `A` before returning. So every path that reaches the field-cache check below
   * with `handle.spriteKey === A` has, as its own precondition, a physical slot that the most
   * recent `source(A)`/`build(A)` call itself just wrote — never another sprite's leftover.
   * Confirmed empirically, not just argued: `source(A)`, `build(A)`, `source(B)` at the same
   * bucket size, `build(A)` again returns `SourceExpiredError` on that second call, not a front
   * built from `B`'s field — see `sheet.gl.test.ts`'s own "does not serve another sprite's stale
   * field" test and this round's report for the exact repro and both directions of the
   * measurement.
   */
  lastFieldBuild: {
    readonly spriteKey: string
    readonly size: Size
    readonly tight: Field
    readonly looseness: number
    readonly loose: LooseField
    /**
     * The hull polygon's own field (design §4), cached under the same `spriteKey` + requested
     * `size` key as `tight`, and sound under it for the same reason: a hull-tier knob cannot move
     * without a fresh `source()`, because `build()`'s step 6 refuses rather than retracing.
     * `null` for a `use-alpha` or all-dropped hull, and after `source()`, which builds no mask.
     */
    readonly paperField: Field | null
  } | null
}

/**
 * The sheet's reach for the guard band (§8.6): `centres` — texel-centre coordinates, either the
 * silhouette box's own texel indices or a hull's vertex bounds — pushed out by `radius` field
 * texels on every side, as a front-px `Rect` that is continuous, unrounded and unclamped. Texel
 * centres sit at `i + 0.5`. Per-axis scale rather than `source()`'s single `texel`, because
 * `dimsForLongSide` rounds the field's short side and a fraction of the FRONT is what the
 * shader's `q` measures.
 */
function reachRect(centres: VertexBounds, radius: number, field: Size, front: Size): Rect {
  const sx = front.w / field.w
  const sy = front.h / field.h
  const x0 = (centres.minX + 0.5 - radius) * sx
  const y0 = (centres.minY + 0.5 - radius) * sy
  const x1 = (centres.maxX + 0.5 + radius) * sx
  const y1 = (centres.maxY + 0.5 + radius) * sy
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * A numeric knob value, or `fallback` when the key is absent from `values` — which happens for
 * real here: `values` is `defaultsFor(edgeMode)` under whatever the caller projected into
 * `SourceOptions.knobs` (§6.3), declared keys only, and a `torn`-only or `hull`-only descriptor
 * is simply not in the other mode's set (`edgeParamsFrom`'s own `num` helper makes the same
 * allowance).
 */
function numKnob(values: Knobs, key: string, fallback: number): number {
  const v = values[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Where the unpadded artwork sits inside a front of `front` texels: centred, at its own size, copied
 * 1:1 (spec 7.4.2 — texels are copied, never resampled, so the origin is rounded to whole texels).
 * One expression for every front this module frames — `source()`'s trace front and whatever size
 * `build()` is asked for — because the seed pass, the CPU fallback, the hull mask, `renderFront`'s
 * `artworkRect` and the rect the motion layer centres on must all agree on it. Framing the fields by
 * a flat `p` inset instead (`artworkUv = fieldUv * (1+2p) - p`) coincides with this only when the
 * front is `artwork * (1+2p)`, which a bucket-shaped front (spec 5.4, 8.6) is not: there the inset
 * scaled the silhouette to `size / (1+2p)` while the artwork stayed 1:1, and the paper came out
 * smaller than the image it was meant to surround.
 */
function artworkPlacement(front: Size, artwork: Size): Rect {
  return {
    x: Math.round((front.w - artwork.w) / 2),
    y: Math.round((front.h - artwork.h) / 2),
    w: artwork.w,
    h: artwork.h,
  }
}

/**
 * The seed pass's `uArtworkUv` (`gl-sdf.ts`) for that placement: field uv — which is front uv, the
 * field being a plain resample of the front — into artwork uv, `(uv * front - placement.xy) /
 * placement.wh`, as a `(scale.xy, offset.xy)` pair.
 */
function artworkUvFor(placement: Rect, front: Size): readonly [number, number, number, number] {
  return [
    front.w / placement.w,
    front.h / placement.h,
    -placement.x / placement.w,
    -placement.y / placement.h,
  ]
}

/** The field's texel grid for a front: the same long-side rule, floored at 2 (§7.4.3). */
function fieldDimsFor(sdfRes: number, front: Size): Size {
  return dimsForLongSide(sdfRes, front.w, front.h, 2)
}

/**
 * `frontRect` (front texels, at the front `placement` was taken in) to `rect` (source pixels):
 * subtract the artwork's origin, then one scale per axis — the resample maps the FULL source onto
 * the FULL artwork (`srcRect` at the call site: no crop, no offset), so artwork texels and source
 * pixels differ by `src / artwork` alone. Rounded at the ends, like the front rect it comes from.
 */
function frontRectToSourceRect(frontRect: Rect, placement: Rect, src: Size): Rect {
  const sx = src.w / placement.w
  const sy = src.h / placement.h
  const x0 = (frontRect.x - placement.x) * sx
  const y0 = (frontRect.y - placement.y) * sy
  const x1 = (frontRect.x + frontRect.w - placement.x) * sx
  const y1 = (frontRect.y + frontRect.h - placement.y) * sy
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.max(1, Math.round(x1 - x0)),
    h: Math.max(1, Math.round(y1 - y0)),
  }
}

/**
 * Take, or (dispose-and-)rebuild, this mount's Pool A/B pair and its `SdfBuilder` at `{ artwork,
 * sdfRes }`. §8.1's Pool A budget is fixed at creation from exactly these two figures, so a later
 * sprite that needs a bigger artwork or a different `sdfRes` cannot simply `acquire` into the old
 * pools — the fixed budget would refuse it. The doc comment on `Mounted` above states the rule;
 * this is what enforces it.
 */
function ensurePools(
  m: Mounted,
  artwork: Size,
  sdfRes: number,
): InstanceType<typeof GlError> | { readonly pools: ScratchPools; readonly sdf: SdfBuilder } {
  const current = m.poolsSize
  if (
    m.pools !== null &&
    m.sdf !== null &&
    current !== null &&
    current.artwork.w === artwork.w &&
    current.artwork.h === artwork.h &&
    current.sdfRes === sdfRes
  ) {
    return { pools: m.pools, sdf: m.sdf }
  }

  m.sdf?.dispose()
  m.pools?.dispose()
  m.pools = null
  m.sdf = null
  m.poolsSize = null
  // Whatever `build()` last cached in `lastFieldBuild` points at Targets the disposed `SdfBuilder`
  // owned (`gl-sdf.ts`'s own `targetsBySlot`); a fresh `SdfBuilder` below re-acquires new ones at
  // the same pool slots, so the cache would otherwise hand a later `build()` call a `Field` whose
  // framebuffer no longer exists.
  m.lastFieldBuild = null

  const pools = createScratchPools({ gl: m.ctx, artwork, sdfRes })
  const sdf = createSdfBuilder(m.ctx, pools.poolA)
  if (GlError.is(sdf)) {
    pools.dispose()
    return sdf
  }

  m.pools = pools
  m.sdf = sdf
  m.poolsSize = { artwork, sdfRes }
  return { pools, sdf }
}

/**
 * Ports `engine.js:#readBackField` whole (task 11 brief): reads pass A's own output back to the
 * CPU, in field TEXELS — a field-sized `readPixels`, 147 456 B at `sdfRes` 192, which §8.1 budgets
 * explicitly. Float targets read as RED/FLOAT when the driver reports that as its implementation
 * format ("a quarter of the transfer and what ANGLE reports for an R16F target"), RGBA/FLOAT
 * otherwise; the RGBA8 fallback decodes through the byte contract. `null` on any failure — errors
 * are swallowed on purpose, because the caller has a CPU transform (§8.2.1).
 *
 * `READ_FRAMEBUFFER` is bound explicitly: `DrawScope.bindTarget` only ever binds
 * `DRAW_FRAMEBUFFER`, so a caller that skipped this would silently read the canvas backbuffer.
 */
function readBackField(ctx: GlContext, field: Field, texelPx: number): Float32Array | null {
  const { gl } = ctx
  const w = field.width
  const h = field.height
  const decode = field.decode
  return ctx.scope((): Float32Array | null => {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, field.target.framebuffer)
    // Stale-error drain, verbatim from engine.js: a prior call's error must not be misread as
    // this readback's own failure.
    while (gl.getError() !== gl.NO_ERROR) {
      // drain
    }
    let out: Float32Array | null = null
    if (ctx.caps.floatRT) {
      const single =
        gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RED &&
        gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.FLOAT
      const channels = single ? 1 : 4
      const buf = new Float32Array(w * h * channels)
      gl.readPixels(0, 0, w, h, single ? gl.RED : gl.RGBA, gl.FLOAT, buf)
      if (gl.getError() === gl.NO_ERROR) {
        out = new Float32Array(w * h)
        for (let i = 0, p = 0; i < out.length; i++, p += channels) {
          out[i] = (buf[p] * decode[0] + decode[1]) / texelPx
        }
      }
    } else {
      const buf = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      if (gl.getError() === gl.NO_ERROR) {
        out = new Float32Array(w * h)
        for (let i = 0, p = 0; i < out.length; i++, p += 4) {
          out[i] = ((buf[p] / 255) * decode[0] + decode[1]) / texelPx
        }
      }
    }
    return out
  })
}

/**
 * P8's `cpuSdfFromAlpha` over the sprite's own alpha — the degraded branch (~120 ms at 512,
 * §8.2.1) this port falls to when `readBackField` refuses. Both DOM boundaries (`OffscreenCanvas`
 * construction, `getImageData`) are wrapped in `attempt` (§10.8): a closed or detached bitmap must
 * resolve to a `GlError`, never throw.
 *
 * **Reproduces `readBackField`'s own artwork placement (fix round 1, finding 4), and does NOT
 * flip rows (fix round 1, finding 1 — see below for why not, with the measurement to back it):**
 *
 * 1. *Margin.* `buildField`'s seed pass (`gl-sdf.ts`'s `SEED_FS`) reads the artwork through
 *    `artworkUvFor(placement, front)`, so the artwork occupies a *sub-rectangle* of the field —
 *    `placement`, the artwork's centred 1:1 box in the front, scaled by `field / front` — not the
 *    whole field. `drawImage`'s 5-argument form reproduces exactly that sub-rectangle, which is
 *    `{ dx, dy, dWidth, dHeight }` below. The canvas starts fully transparent, so the untouched
 *    margin reads alpha 0 — "outside" — matching the seed pass's own `inRange` guard, which never
 *    samples the artwork there either. The original report's departure 2 named exactly this gap;
 *    this is what closes it.
 * 2. *Orientation — NOT a mismatch here, checked rather than assumed.* The original report's
 *    departure asserted "GPU-native y-up… canvas-native y-down…", by analogy with `engine.js`'s
 *    own `cpuSdfYUp`. That analogy does not hold for THIS package's actual upload path:
 *    `artwork.ts`'s own resample fallback draws the bitmap onto a canvas and `texSubImage2D`s the
 *    resulting bytes straight into the artwork texture with `UNPACK_FLIP_Y_WEBGL` pinned `false`
 *    (`artwork.ts`'s own header comment) — canvas row 0 lands in texture row 0 unflipped. The seed
 *    pass then samples that texture with `texelFetch`, which addresses stored texel rows directly
 *    (row 0 = texture row 0 = canvas row 0), and `readBackField`'s `readPixels` reads the resulting
 *    FBO row-major from the row GL calls row 0 — the SAME row a `texelFetch` row-0 lookup would
 *    have sampled. So `readBackField`'s row 0 and THIS function's own canvas-native row 0 already
 *    name the same row; a `flipFieldRows` here would introduce a mismatch that does not otherwise
 *    exist, not fix one. Measured directly (an asymmetric fixture, both branches, `frontRect.y`
 *    compared): un-flipped, the two branches land within 0 px of each other; artificially flipped
 *    to test the claim, they land 32 px apart on a 128 px front — see
 *    `sheet.gl.test.ts`'s "findings 1, 4" test, and this round's report for the exact numbers and
 *    how they were produced.
 */
function cpuFieldFallback(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  placement: Rect,
  front: Size,
): InstanceType<typeof GlError> | Float32Array {
  const canvas = attempt(
    () => new OffscreenCanvas(w, h),
    (cause) =>
      new GlError('paperSheet: source() CPU-field fallback OffscreenCanvas construction failed', {
        cause,
      }),
  )
  if (GlError.is(canvas)) return canvas

  const c2d = canvas.getContext('2d')
  if (c2d === null) {
    return new GlError('paperSheet: source() CPU-field fallback 2D context unavailable')
  }

  // The same placement `buildField`'s seed pass reads the artwork at (`artworkUvFor`, "Departure
  // 2" in `gl-sdf.ts`'s own header comment): the artwork's 1:1 box in the front, at the field's
  // own resolution — front uv is field uv, so each axis scales by `field / front`.
  const kx = w / front.w
  const ky = h / front.h
  const dx = placement.x * kx
  const dy = placement.y * ky
  const dWidth = placement.w * kx
  const dHeight = placement.h * ky

  const drawn = attempt(
    () => c2d.drawImage(bitmap, dx, dy, dWidth, dHeight),
    (cause) => new GlError('paperSheet: source() CPU-field fallback drawImage failed', { cause }),
  )
  if (GlError.is(drawn)) return drawn

  const imageData = attempt(
    () => c2d.getImageData(0, 0, w, h),
    (cause) =>
      new GlError('paperSheet: source() CPU-field fallback getImageData failed', { cause }),
  )
  if (GlError.is(imageData)) return imageData

  const alpha = new Float32Array(w * h)
  const data = imageData.data
  for (let i = 0, k = 3; i < alpha.length; i++, k += 4) alpha[i] = data[k] / 255
  return cpuSdfFromAlpha(alpha, w, h)
}

/**
 * The CPU signed field for the hull trace, from whichever branch succeeds — `readBackField` when
 * the driver allows it, `cpuFieldFallback` otherwise. Both share the same row order (checked, not
 * assumed — see `cpuFieldFallback`'s own doc comment) and now the same artwork placement, so a
 * hull traced off either branch for the same sprite is equivalent rather than mirrored or
 * margin-shifted; neither branch needs to be told which the caller is (fix round 1, findings 1 and
 * 4 — departures the original report named and this round resolves by normalising at the source
 * rather than by carrying a flag downstream).
 */
function acquireCpuField(
  ctx: GlContext,
  tight: Field,
  texelPx: number,
  bitmap: ImageBitmap,
  placement: Rect,
  front: Size,
): InstanceType<typeof GlError> | Float32Array {
  const readBack = readBackField(ctx, tight, texelPx)
  if (readBack !== null) return readBack
  return cpuFieldFallback(bitmap, tight.width, tight.height, placement, front)
}

export function paperSheet(options?: PaperSheetOptions): PaperSheet {
  const edgeMode: PaperEdgeMode = options?.edgeMode ?? 'hull'
  const tileSet: PaperTileSet | null = options?.tiles ?? null
  const overscanHeadroom = options?.overscanHeadroom ?? 0
  const knobDescriptors = descriptorsFor(edgeMode)

  /**
   * §6.3 — the values a trace runs at: this mode's defaults, with the HULL TIER alone taken from
   * the caller's projection of §6.6's ladder for the sprite (`SourceOptions.knobs`) — declared
   * keys only, so a torn sheet handed `minDist` keeps ignoring it, exactly as `build()` does. No
   * projection traces at the defaults.
   *
   * Nothing else in `source()` may follow the live knobs — and that includes `maxDist`, which IS
   * in the hull tier this function lets through: the reserve is derived from `reserveParams`,
   * the defaults, and never from the values this returns. The reserve and the overscan `p` it
   * derives — and with `p` the artwork's own resolution `A = maxSize / (1 + 2p)` — are frozen at
   * add() for the sprite's life (§8.6): a re-source that read the live `tearAmp` or `looseness`
   * handed back a handle with another `p` than the fit was sized over, so `build()` placed a
   * smaller artwork in the same bucket, and on a portrait sprite the `h / w`-scaled reserve ran
   * off the reference plane and `source()` itself refused ("could not derive overscan") where
   * `build()`'s own reserve check (step 4) is the honest surface. `sdfRes` and `looseness` stay
   * at the defaults for the same reason `build()` re-blurs at the live `looseness` itself.
   */
  function valuesFor(knobs: Knobs | undefined): Knobs {
    const out = defaultsFor(edgeMode)
    if (knobs === undefined) return out
    for (const d of knobDescriptors) {
      const v = knobs[d.key]
      if (d.invalidates === 'hull' && v !== undefined) out[d.key] = v
    }
    return out
  }

  /** The hull-tier slice of `values`, the way `PaperSheetHandle.hullKnobs` records it (§6.3). */
  function hullTierOf(values: Knobs): Knobs {
    const out: Record<string, string | number | boolean> = {}
    for (const d of knobDescriptors) {
      const v = values[d.key]
      if (d.invalidates === 'hull' && v !== undefined) out[d.key] = v
    }
    return out
  }

  // §6.5/§8.6: the edge parameters every reserve in this factory is derived from — the mode's
  // defaults, never a sprite's live values (`source()`'s step 1 says why) — and the factory-level
  // baseline itself. See `PaperSheet.overscan`'s doc comment: a sprite's own handle carries this
  // same number.
  const reserveParams = edgeParamsFrom(edgeMode, defaultsFor(edgeMode))
  const reserve = freezeOverscan(reserveParams, overscanHeadroom)
  // Every mode's own *default* knob values alone reserve well under the 500 reference-px ceiling
  // `overscanFromRadius` guards — but `overscanHeadroom` is a user-supplied factory option with no
  // upper bound (`freezeOverscan` scales the radius by `1 + headroom`), so this branch genuinely IS
  // reachable: past a headroom of roughly 4.95 for `hull`'s own defaults (roughly 2.34 for
  // `torn`'s), the scaled radius leaves no artwork inside the reference frame. `overscan` is never
  // actually read in that case — `mount()` below is the earliest call with an error channel
  // (`PaperSheet.overscan` itself has none, spec 5.2: a plain `readonly number`) and refuses to
  // mount, returning the wrapped `KnobError` first. The field still needs *a* value for the narrow
  // window between construction and a first `mount()` call, so it is `Infinity` rather than a
  // plausible-looking `0` — a `0` here would silently claim "no margin needed," which is exactly
  // the one reading this failed derivation can never honestly produce.
  let overscan: number
  let overscanError: InstanceType<typeof KnobError> | null
  if (KnobError.is(reserve)) {
    overscanError = reserve
    overscan = Number.POSITIVE_INFINITY
  } else {
    overscanError = null
    overscan = reserve.overscan
  }

  let mounted: Mounted | null = null
  // Before the first `mount()` there is nothing to report yet, so this deferred is never
  // resolved — a pending promise nobody is required to await, which is not a floating rejection.
  let tilesReadyState = makeDeferred<InstanceType<typeof GlError> | true>()

  // §5.2's `SourceOptions` carries no key. `paper:<n>` is minted once per BITMAP IDENTITY — a
  // slot-local surrogate for the stage's own key, which §5.2 does not pass down — so the same
  // bitmap re-`source()`d hits the same artwork slot and the same hull-cache entry, and a
  // `replace()` with fresh bytes (a fresh `ImageBitmap`) gets a fresh key for free.
  //
  // `srcW`/`srcH` are captured alongside the key, on first use, and reused rather than re-read
  // from `bitmap.width`/`.height` on every call: an `ImageBitmap`'s own dimensions cannot change
  // across its life, but they DO read as `0x0` once `.close()`'d, and §8.5.4 explicitly allows
  // `stage.add(b, { key }); b.close()` — the bitmap is not guaranteed to still be open on a later
  // `source()` for the very same key. `lastArtwork` records what `A` the artwork slot was last
  // written at, so a repeat call whose artwork slot is still resident (untouched by another
  // sprite in between) and whose desired `A` has not changed can skip the resample outright
  // rather than needing to touch the bitmap at all — sound because a spriteKey is minted per
  // bitmap OBJECT IDENTITY, so "the same key" already means "the same, unchanged bytes".
  interface SpriteInfo {
    readonly key: string
    readonly srcW: number
    readonly srcH: number
    lastArtwork: Size | null
  }
  const spriteInfos = new WeakMap<ImageBitmap, SpriteInfo>()
  let nextSpriteKeyId = 1
  function spriteInfoFor(bitmap: ImageBitmap): SpriteInfo {
    const existing = spriteInfos.get(bitmap)
    if (existing !== undefined) return existing
    const info: SpriteInfo = {
      key: `paper:${nextSpriteKeyId}`,
      srcW: bitmap.width,
      srcH: bitmap.height,
      lastArtwork: null,
    }
    nextSpriteKeyId += 1
    spriteInfos.set(bitmap, info)
    return info
  }

  // See `PaperSheet.__afterHullForTest`'s own doc comment: test-only, never set by production
  // code.
  let afterHullForTest: (() => void) | undefined
  // See `PaperSheet.__afterFieldForTest`'s own doc comment: test-only, never set by production
  // code (fix round 1, finding 2).
  let afterFieldForTest: (() => void) | undefined

  function mount(ctx: GlContext): InstanceType<typeof GlError> | undefined {
    // The earliest honest surface for a factory-level `overscanHeadroom` that could not be
    // frozen into a reserve (see the `overscanError` derivation above) — `paperSheet()` itself
    // returns synchronously with no error channel, and `source()` requires a successful `mount()`
    // first regardless, so nothing downstream can be reached without passing through here.
    if (overscanError !== null) {
      return new GlError(
        'paperSheet: cannot mount — overscanHeadroom pushes the factory-level reserve past the ' +
          `${KNOB_REFERENCE_PX} px reference plane (spec 8.6); pass a smaller overscanHeadroom`,
        { cause: overscanError },
      )
    }
    if (mounted !== null) {
      return new GlError('paperSheet: mount() called while already mounted — call dispose() first')
    }

    const resampler = createResampler(ctx)
    if (GlError.is(resampler)) return resampler

    const renderer = createPaperRenderer(ctx)
    if (GlError.is(renderer)) {
      resampler.dispose()
      return renderer
    }

    const neutral = mountNeutralTiles(ctx)
    if (GlError.is(neutral)) {
      renderer.dispose()
      resampler.dispose()
      return neutral
    }

    mounted = {
      ctx,
      pools: null,
      sdf: null,
      poolsSize: null,
      resampler,
      renderer,
      cache: hullCache(),
      tiles: neutral,
      liveFronts: new Set<Texture>(),
      frontTextures: new WeakMap<SheetFront, { texture: Texture }>(),
      liveHandles: new Map<string, number>(),
      lastFieldBuild: null,
    }

    tilesReadyState = makeDeferred<InstanceType<typeof GlError> | true>()

    if (tileSet === null) {
      tilesReadyState.resolve(true)
      return undefined
    }

    // Captured now, not read as `tilesReadyState` inside the callback below: `mount()` replaces
    // `tilesReadyState` with a fresh deferred on every call (just above), so a stale `.then` from
    // an earlier `mount()` reading the mutable outer binding at callback time — rather than the
    // deferred that was current when *this* fetch started — would settle a *later* mount's
    // promise. A `mount → dispose → mount` sequence is exactly that: the first mount's fetch can
    // still be in flight when the second one starts.
    const deferred = tilesReadyState

    // Fire-and-forget with a value, never a floating rejection (spec 5.2's own wording).
    // `loadTileBitmaps` never rejects; the `try`/`catch` below is the belt for anything inside
    // this callback that could throw regardless (a closed-bitmap `.close()`, in principle),
    // so a bug here becomes a `GlError` on `tilesReady` and never an unhandled rejection.
    loadTileBitmaps(tileSet).then((result) => {
      try {
        if (GlError.is(result)) {
          deferred.resolve(result)
          return
        }
        if (isAborted(result)) {
          // No `signal` is ever passed to this internal call, so this is unreachable in
          // practice; handled because `loadTileBitmaps`'s own return type allows it.
          deferred.resolve(new GlError('paperSheet: unexpected tile-load abort'))
          return
        }
        if (mounted === null) {
          // `dispose()` ran while the fetch was in flight. Nothing left to swap the tiles into;
          // close what was decoded so the bitmaps do not leak.
          for (const name of TILE_NAMES) result[name].close()
          deferred.resolve(new GlError('paperSheet: tiles landed after dispose()'))
          return
        }
        const uploaded = uploadTiles(mounted.ctx, result)
        for (const name of TILE_NAMES) result[name].close()
        if (GlError.is(uploaded)) {
          deferred.resolve(uploaded)
          return
        }
        const previous = mounted.tiles
        mounted.tiles = uploaded
        previous.dispose()
        deferred.resolve(true)
      } catch (cause) {
        deferred.resolve(new GlError('paperSheet: tile mount failed unexpectedly', { cause }))
      }
    })

    return undefined
  }

  // A function, not the inlined `o.signal?.aborted === true` it wraps: `aborted` can flip between
  // any two of `source()`'s three check points (an abort mid-trace is the entire reason there are
  // three, not one), but TS's CFA does not know that — having seen one `=== true` check rule the
  // property out, it treats a second textually-identical check on the same reference as
  // unreachable. A fresh call each time is a fresh expression, so nothing narrows across calls
  // (same idiom as `core/runner.ts`'s own `signalAborted`).
  function signalAborted(signal: AbortSignal | undefined): boolean {
    return signal !== undefined && signal.aborted
  }

  async function source(
    bitmap: ImageBitmap,
    o: SourceOptions,
  ): Promise<SourceError | Aborted | PaperSheetHandle> {
    if (mounted === null) {
      return new SheetError('paperSheet: call mount(ctx) before source() (spec 5.2)')
    }
    const m = mounted

    // Abort check point 1 (§10.5): on entry, before any GPU work is spent.
    if (signalAborted(o.signal)) return ABORTED

    // §6.3 — the hull cache key is "every knob at or above 'hull'", so the trace runs at the
    // hull-tier values the caller projected for the sprite, over this factory's defaults. The
    // reserve, `p` and the artwork size derived below stay at the defaults (`valuesFor`'s own doc
    // comment: §8.6 freezes them at add()).
    const values = valuesFor(o.knobs)
    const edgeParams = edgeParamsFrom(edgeMode, values)

    const info = spriteInfoFor(bitmap)
    const spriteKey = info.key
    const srcW = info.srcW
    const srcH = info.srcH

    // Step 1: the frozen reserve — this factory's DEFAULTS plus `overscanHeadroom`, never the
    // live hull tier (`maxDist` is both a hull-tier knob and the whole of `r_hull`, so a reserve
    // taken from `edgeParams` would be re-frozen on every hull-tier re-source: `p` grew, `A`
    // shrank, and the artwork visibly rescaled inside a bucket `fit` had sized once). Aspect-free
    // (`handle.ts`'s `freezeOverscan`), so it IS `overscan` above; `mount()` already refused when
    // that derivation failed, and `source()` returns before this line without a mount.
    const p = overscan

    // Steps 2-3: the artwork, its per-axis margin and the front it sits in (§8.6, `handle.ts`).
    // `artworkLongSide` (optional on `SourceOptions`) is `artworkCssPx`'s own channel from the
    // stage; absent, the artwork is what `maxSize` leaves after the margin, as it always was.
    const framing = frontForArtwork({
      overscan: p,
      srcW,
      srcH,
      maxSize: o.maxSize,
      exact: o.exact,
      artworkLongSide: o.artworkLongSide,
    })
    if (SheetError.is(framing)) return framing
    const { artwork, front } = framing
    const frontLongSide = Math.max(front.w, front.h)

    // Step 4: sdfRes, off the front's long side (§7.4.3).
    const sdfRes = resolveSdfRes(numKnob(values, 'sdfRes', 0), frontLongSide)

    const field = fieldDimsFor(sdfRes, front)
    const placement = artworkPlacement(front, artwork)

    // Step 5: pools, sized at { artwork, sdfRes } — created lazily here, reused across sprites,
    // re-created (with disposal) when a later sprite needs a bigger Pool A.
    const ensured = ensurePools(m, artwork, sdfRes)
    if (GlError.is(ensured)) return ensured
    const { pools, sdf } = ensured

    // Step 6: resample into the Pool A artwork slot — unless it is already sitting there. A
    // spriteKey is minted per BITMAP OBJECT IDENTITY (above), so "the artwork slot already holds
    // this exact key, at this exact size" means the bytes cannot have changed; skipping the
    // resample then is not a stale-cache risk, and it is what lets a `source()` for a sprite
    // whose hull is already cached succeed even when the caller has since closed the bitmap
    // (§8.5.4's own "stage.add(b, { key }); b.close()" — the last read of the bitmap already
    // happened, on the call that populated the slot).
    const alreadyResident =
      pools.poolA.artworkKey() === spriteKey &&
      info.lastArtwork !== null &&
      info.lastArtwork.w === artwork.w &&
      info.lastArtwork.h === artwork.h
    let artworkTexture: Texture
    if (alreadyResident) {
      const held = pools.poolA.holdArtwork(spriteKey, {
        width: artwork.w,
        height: artwork.h,
        format: 'RGBA8UI',
        filter: 'NEAREST',
        label: `artwork:${spriteKey}`,
      })
      if (GlError.is(held)) return held
      artworkTexture = held
    } else {
      const resampled = m.resampler.resample({
        spriteKey,
        bitmap,
        srcRect: { x: 0, y: 0, w: srcW, h: srcH },
        artwork,
        poolA: pools.poolA,
        poolB: pools.poolB,
      })
      if (GlError.is(resampled)) return resampled
      artworkTexture = resampled.texture
      info.lastArtwork = artwork
    }

    // Step 7: buildField — the margin applied as a uv offset, at no cost (§8.5): the artwork's
    // own placement in the front, expressed in uv.
    const tight = sdf.buildField({
      artwork: artworkTexture,
      artworkUv: artworkUvFor(placement, front),
      width: field.w,
      height: field.h,
      sourceLongSide: frontLongSide,
    })
    if (GlError.is(tight)) return tight

    // Step 8: blurField — sigma off `looseness`, which a `hull`-only sheet does not even declare
    // as a knob (`numKnob` falls back to 0, the field's own no-blur floor).
    const looseness = numKnob(values, 'looseness', 0)
    const blurred = sdf.blurField({
      field: tight,
      sigmaPx: sigmaFor(looseness, frontLongSide),
      frontLongSide,
    })
    if (GlError.is(blurred)) return blurred

    // Fix round 1, finding 3 (the doubled pass B): `m.lastFieldBuild` used to start `null` and
    // stay that way until `build()`'s own first call — so the very passes just run above were
    // thrown away and `build()`'s first call for this sprite always redid both, unconditionally,
    // even though its own `size` is `front` (this call's own front dims) on the ordinary path
    // (source() then build() at the size just sourced). Recording them here means that first
    // `build()` call sees a cache hit instead: `tightReusable` requires the SAME spriteKey and the
    // SAME `size` (§8.1's shared-slot rule this record exists to serve), which a `build()` call
    // for a DIFFERENT requested size, or a different sprite having taken the slot since, correctly
    // fails — falling through to a fresh `buildField`/`blurField`, exactly as before this change.
    m.lastFieldBuild = {
      spriteKey,
      size: { w: front.w, h: front.h },
      tight,
      looseness,
      loose: blurred,
      paperField: null,
    }

    // Test-only hook (fix round 1, finding 2 — see `__afterFieldForTest`'s own doc comment on
    // `PaperSheet`): fires synchronously, before the `await` below ever yields, so a test-driven
    // `controller.abort()` here is guaranteed to have landed by the time check point 2's own read
    // of `o.signal.aborted` runs — no race, unlike a signal fired from outside this call's own
    // stack frame.
    afterFieldForTest?.()

    // Abort check point 2 (§10.5): after the resample and the two field passes, before the CPU
    // hull trace — the boundary between work already paid for and the one genuinely
    // interruptible step. The `await` is what makes this point (and the third one, below)
    // observable from outside a synchronous call: without it nothing here would ever yield.
    await Promise.resolve()
    if (signalAborted(o.signal)) return ABORTED

    // Step 9: the CPU signed field for the hull trace, then buildHull, then the rect, then the
    // guard-band check.
    const texel = front.w / field.w
    const pxScale = front.h / KNOB_REFERENCE_PX
    const k = pxScale / texel

    const knobKey = hullCacheKey(knobDescriptors, values)
    const cacheKey: HullCacheKey = { spriteKey, sdfRes, knobKey }

    let hull: HullShape | undefined = m.cache.get(cacheKey)
    if (hull === undefined) {
      const cpu = acquireCpuField(m.ctx, tight, texel, bitmap, placement, front)
      if (GlError.is(cpu)) return cpu

      // `torn` mode declares no hull-only descriptors at all — `values.minDist`/`maxDist` are
      // simply absent — so it always passes 0/0, which is what makes `buildHull` return
      // `HULL_USE_ALPHA` (the brief's own instruction).
      const minDist = edgeMode === 'torn' ? 0 : numKnob(values, 'minDist', 0)
      const maxDist = edgeMode === 'torn' ? 0 : numKnob(values, 'maxDist', 0)
      const angularity = numKnob(values, 'angularity', 0)
      const seed = numKnob(values, 'seed', 0)

      const built = buildHull({
        field: cpu,
        width: field.w,
        height: field.h,
        minDist: minDist * k,
        maxDist: maxDist * k,
        angularity,
        seed,
        tolerance: toleranceFor(angularity) * k,
        wavelength: DISTANCE_WAVELENGTH_PX * k,
        sampleStep: HULL_SAMPLE_PX / texel,
      })
      hull = built.hull
      // "The freshly traced hull is written into the cache before the sentinel is returned" —
      // §10.5's own wording for check point 3, below: a hull that already landed is kept.
      m.cache.set(cacheKey, hull)
    }

    // Abort check point 3 (§10.5's own named point): after the hull trace returns. Fires
    // unconditionally (cache hit or fresh trace) — a cache hit already "landed" trivially, so
    // there is nothing more to keep either way.
    afterHullForTest?.()
    if (signalAborted(o.signal)) return ABORTED

    // The rect (§8.3, no source-sized readback): hull/both take it from the polygon's own
    // extent; torn (and any use-alpha hull) take it from the silhouette's own box, grown by the
    // overscan radius. `reach` is the SAME two terms — silhouette plus paint radius — kept for
    // the guard band as continuous front px, neither rounded nor clamped: `growBox`, `scaleBox`
    // and `sheetRect` each round outward (a texel or a pixel per step — quantisation the reserve
    // never promised to cover), `sheetRect`'s 4 % is §8.3's bucket-decision safety rather than
    // paint, and a box clamped to the plane stops at exactly 0.5, so it cannot say how far an
    // under-reserved sheet really reaches.
    const bounds = hullBounds(hull)
    let box: AlphaBox
    let reach: Rect
    if (bounds === undefined) {
      // Only reachable for `torn` (always `use-alpha`) or a degenerate empty trace. The CPU field
      // is not retained past the cache-hit branch above, so a use-alpha rect always re-acquires
      // it — cheap relative to the trace it replaces, and never on the hot (cached-hull) path for
      // hull/both.
      const cpu = acquireCpuField(m.ctx, tight, texel, bitmap, placement, front)
      if (GlError.is(cpu)) return cpu
      const raw = signedFieldExtent(cpu, field.w, field.h)
      if (raw === undefined) {
        return new SheetError('paperSheet: source() found an empty silhouette')
      }
      // `overscanRadius` is reference px (like `minDist`/`maxDist`); `k` is the same
      // reference-px-to-field-texel conversion the hull trace uses above.
      const radius = overscanRadius(edgeParams) * k
      box = growBox(raw, radius, field.w, field.h)
      reach = reachRect(
        { minX: raw.x0, minY: raw.y0, maxX: raw.x1, maxY: raw.y1 },
        radius,
        field,
        front,
      )
    } else {
      box = boundsExtent(bounds, field.w, field.h)
      // Finding F1. `extent.ts:5-7` says the polygon's vertices already sit `maxDist` past the
      // silhouette, so the polygon's own box is the sheet's extent. That holds for `hull` and
      // fails for `both`: there the torn path draws outward FROM the contour, by exactly the
      // terms `overscanRadius` collects as `r_both - maxDist`: the leading `thickness`, the tear
      // bracket `[thickness + 0.6*looseness*tearAmp + midAmp]*edgeK`, four fibre lengths and the
      // slop — roughly 111 reference px at this package's own knob defaults (22 + 61.2 + 16 + 12),
      // against roughly 36 from `SHEET_MARGIN_FRAC`'s 4 %. Derived from the same function the frozen
      // reserve is derived from, so the two can never drift apart. Until the hull polygon became
      // a real field this was invisible, because `both` never reached the polygon at all. For
      // `hull` the same expression is the slop alone (`r_hull - maxDist`): the antialiasing the
      // reach carries past the polygon, which the rect leaves to `sheetRect`'s 4 %.
      const beyond = (overscanRadius(edgeParams) - edgeParams.maxDist) * k
      if (edgeMode === 'both') box = growBox(box, beyond, field.w, field.h)
      reach = reachRect(bounds, beyond, field, front)
    }

    const frontBox = scaleBox(box, texel)
    const frontRect = sheetRectFromExtent(frontBox, front.w, front.h)

    // Step 9 (guard band, §8.6): before allocating anything the caller will not receive. Read off
    // `reach`, not `frontRect` — the rect comment above gives the three reasons.
    const guardBand = checkGuardBand({ frontSize: front, hullExtent: reach })
    if (guardBand !== undefined) return guardBand

    // `rect` (source pixels) goes through the artwork's own placement — the very box the seed
    // pass framed the field on (§8.5) — not a uniform `sourceLongSide / frontLongSide` scale (fix
    // round 1, finding 3): a uniform scale has no origin term, so it drops the margin the
    // placement encodes. Artwork texels and source pixels then differ by `src / artwork` alone,
    // because the resample maps the FULL source onto the FULL artwork (`srcRect` above).
    const rect = frontRectToSourceRect(frontRect, placement, { w: srcW, h: srcH })

    const handle: PaperSheetHandle = {
      spriteKey,
      rect,
      frontRect,
      front,
      artwork,
      overscan: p,
      sdfRes,
      srcW,
      srcH,
      aspect: srcW / srcH,
      exact: o.exact,
      edgeMode,
      hull,
      hullKnobs: hullTierOf(values),
      alive: true,
      bytes: 0,
    }
    m.liveHandles.set(spriteKey, (m.liveHandles.get(spriteKey) ?? 0) + 1)
    return { ...handle, bytes: handleBytesFor(handle) }
  }

  function invalidateHull(spriteKey: string): number {
    if (mounted === null) return 0
    if (spriteKey === '*') {
      const total = mounted.cache.size
      mounted.cache.clear()
      return total
    }
    return mounted.cache.invalidate(spriteKey)
  }

  function build(
    handle: PaperSheetHandle,
    size: Size,
    knobValues: Readonly<SheetKnobs<Knobs>>,
  ): BuildError | SheetFront {
    // Step 1 (spec 5.2): mount() first.
    if (mounted === null) {
      return new SheetError('paperSheet: call mount(ctx) before build() (spec 5.2)')
    }
    const m = mounted

    // Step 2: a released handle is a SheetError, never a throw.
    if (handle.alive === false) {
      return new SheetError('paperSheet: build() called on a handle release() already freed')
    }

    // Step 3 (spec 8.5): "the artwork is no longer in the pool" is read straight off the pool,
    // never off a flag on the handle — `poolA.artworkKey()` is the only signal the core needs,
    // and it is what lets a second sprite taking the slot be detected without either handle
    // knowing about the other. `m.pools`/`m.sdf` being unset at all (no sprite has ever been
    // sourced into this mount) is the same fact by construction.
    if (m.pools === null || m.sdf === null) {
      return new SourceExpiredError(
        'paperSheet: build() — no artwork has ever been sourced into this mount (spec 8.5); ' +
          'call source() before build()',
      )
    }
    const pools = m.pools
    const sdf = m.sdf
    if (pools.poolA.artworkKey() !== handle.spriteKey) {
      return new SourceExpiredError(
        `paperSheet: build() — handle "${handle.spriteKey}"'s artwork is no longer in the pool ` +
          '(spec 8.5); another sprite has taken the slot, so source() must run again',
      )
    }

    // Step 4 (spec 8.6): checkReserve catches a front-class slider dragged past the frozen
    // margin. `reserve` (this factory's own closure variable, above) carries the same RADIUS
    // `source()` freezes onto every handle: both are `freezeOverscan(reserveParams,
    // overscanHeadroom)`, which is aspect-free, so the radius is
    // deterministic in (mode, defaults, headroom), none of which vary per sprite or over a sheet's
    // life, and re-reading it here is exactly "the handle's own frozen reserve" without a field
    // added to the handle for it. `KnobError` is unreachable here (mount() above already refused
    // whenever `reserve` is one), kept because §10.8 forbids unwrapping an `Error | T` unchecked
    // even on a branch believed dead.
    if (KnobError.is(reserve)) {
      return new SheetError('paperSheet: build() could not derive the frozen overscan reserve', {
        cause: reserve,
      })
    }
    // Fix round 1, finding 2 (was wrong): a previous version pinned every field-tier knob
    // (`looseness`, `sdfRes`) back to this factory's default before deriving `edgeParams`, on the
    // theory that `checkReserve` is a "front-class slider" guard and `looseness` is field-tier.
    // That is false: core's own `overscanRadius` (`overscan.ts`) takes the LIVE `looseness` as a
    // real term of `r_torn`/`r_both` (the `0.45*sigma` blur lead and the `0.6*looseness*tearAmp`
    // tear bracket) — pinning it silently disabled the one guard `overscanHeadroom` exists to be
    // the escape hatch from. `checkReserve` gets the sprite's live `knobValues` verbatim, exactly
    // as the brief's own step 4 states; a caller who genuinely needs to drag `looseness` past the
    // frozen reserve gets the "re-add required" `SheetError` this check exists to produce, and one
    // who needs the room reserves it up front with a larger `overscanHeadroom` (spec 8.6).
    const reserveCheck = checkReserve(reserve, edgeParamsFrom(edgeMode, knobValues))
    if (reserveCheck !== undefined) return reserveCheck

    // Step 5 (spec 6.3, engine.js's own setLooseness): pass A (the tight SDF field) depends only
    // on the artwork and the handle-frozen geometry, never on any knob — so it is reused whenever
    // this call is asking for exactly what the last `build()` left the shared Pool A field slots
    // holding (same sprite, same requested size; `gl-sdf.ts`'s own `buildField`/`blurField` write
    // into one shared slot apiece, so a different sprite or size having intervened means the slot
    // no longer holds this sprite's tight field). Pass B (the blur) is re-run alone whenever
    // `looseness` itself moved — never pass A — which is what makes dragging it cheap.
    const frontLongSide = Math.max(size.w, size.h)
    const field = fieldDimsFor(handle.sdfRes, size)
    // Where the artwork sits in THIS front — 1:1, centred (spec 7.4.2) — whatever `size` the
    // bucket fit asked for. The field, the hull mask and the rect below are all framed on it,
    // exactly as `source()` framed its own front: what moved between the two is this origin.
    const placement = artworkPlacement(size, handle.artwork)
    const cachedField = m.lastFieldBuild
    const tightReusable =
      cachedField !== null &&
      cachedField.spriteKey === handle.spriteKey &&
      cachedField.size.w === size.w &&
      cachedField.size.h === size.h

    const artworkTexture = pools.poolA.holdArtwork(handle.spriteKey, {
      width: handle.artwork.w,
      height: handle.artwork.h,
      format: 'RGBA8UI',
      filter: 'NEAREST',
      label: `artwork:${handle.spriteKey}`,
    })
    if (GlError.is(artworkTexture)) return artworkTexture

    let tight: Field
    if (tightReusable) {
      tight = cachedField.tight
    } else {
      const built = sdf.buildField({
        artwork: artworkTexture,
        artworkUv: artworkUvFor(placement, size),
        width: field.w,
        height: field.h,
        sourceLongSide: frontLongSide,
      })
      if (GlError.is(built)) return built
      tight = built
    }

    const looseness = numKnob(knobValues, 'looseness', 0)
    let loose: LooseField
    if (tightReusable && cachedField.looseness === looseness) {
      loose = cachedField.loose
    } else {
      const blurred = sdf.blurField({
        field: tight,
        sigmaPx: sigmaFor(looseness, frontLongSide),
        frontLongSide,
      })
      if (GlError.is(blurred)) return blurred
      loose = blurred
    }

    const fieldRecord = {
      spriteKey: handle.spriteKey,
      size: { w: size.w, h: size.h },
      tight,
      looseness,
      loose,
      paperField: tightReusable ? cachedField.paperField : null,
    }
    m.lastFieldBuild = fieldRecord

    // Step 6 (spec 6.3): a hull-tier knob (`minDist`, `maxDist`, `angularity`, `seed`) moving off
    // the value `source()` traced the handle's hull at is `invalidates: 'hull'`, which the core
    // resolves by calling `source()` again, at the current knobs — `build()` never silently
    // retraces, which would hide a cache miss the invalidation ladder exists to surface. The
    // values the trace ran at are the handle's own `hullKnobs` (`source()` records the hull tier
    // of `SourceOptions.knobs` there), so that is what "the ones the handle was built at" means.
    // `SourceExpiredError`, never a bare `SheetError`: core's `rebuildFront` walks §8.5's
    // re-source row on that class alone and orphans every other `BuildError` (§10.6, no caller on
    // the stack) — a `SheetError` here orphaned the sprite on every hull-tier set() for its life.
    // Checked after the field rebuild above (never before it, per the brief's own numbered
    // order), even though the rebuild's own work is wasted on the error path below — each step
    // catches its own honest precondition, in the stated sequence, rather than being reordered
    // for a marginal saving on an error path.
    const hullTierKeys = knobDescriptors.filter((d) => d.invalidates === 'hull')
    const hullChanged = hullTierKeys.some((d) => knobValues[d.key] !== handle.hullKnobs[d.key])
    if (hullChanged) {
      return new SourceExpiredError(
        'paperSheet: build() — a hull-invalidating knob (minDist/maxDist/angularity/seed) moved ' +
          "off the value this handle's hull was traced at (spec 6.3); source() again, with the " +
          'current knobs',
      )
    }

    // Step 6b (design §2, §3, §5): the hull polygon's own field, and the reason `uEdgeMode`
    // becomes 1 rather than 2. The polygon lives in the texels of the field `source()` traced on,
    // around the artwork placed 1:1 in `handle.front`; this build's field is over `size`, with the
    // artwork placed 1:1 again but at another origin. So a hull texel goes to that front's px,
    // then to artwork px (minus the trace placement), back to this front's px (plus this
    // placement), and into this field's texels: one scale and one translation per axis, which is
    // what `fillHullMask`'s `sx, sy, tx, ty` are. A scale alone reconciled the two only while
    // both fronts were `artwork * (1 + 2p)` — never true of a bucket-shaped build (spec 8.6).
    //
    // The mask is a dedicated, non-pooled `RGBA8UI` allocation disposed inside this call (the
    // pattern `artwork.ts:26-28` establishes), so §8.1's fixed Pool A budget is untouched; only
    // the FIELD lands in a pool slot, and `SDF_POOL_SLOTS.hullField` is already declared for it.
    // The bytes are transient: `field.w * field.h * 4`, i.e. 147 KB at `sdfRes` 192, freed here.
    // Uploaded unflipped — `UNPACK_FLIP_Y_WEBGL` stays pinned false and the mask inherits the
    // field's row order, exactly as the artwork does (§6; the p10 plan's `yUp` flag is superseded,
    // see this file's own row-order note at lines 457-472).
    const srcField = fieldDimsFor(handle.sdfRes, handle.front)
    const tracePlacement = artworkPlacement(handle.front, handle.artwork)
    const hullSx = (handle.front.w / srcField.w) * (field.w / size.w)
    const hullSy = (handle.front.h / srcField.h) * (field.h / size.h)
    const hullTx = ((placement.x - tracePlacement.x) * field.w) / size.w
    const hullTy = ((placement.y - tracePlacement.y) * field.h) / size.h
    let paperField: Field | null = fieldRecord.paperField
    if (
      paperField === null &&
      handle.hull.kind === 'polygons' &&
      hullComponentCount(handle.hull) > 0
    ) {
      const bytes = fillHullMask(handle.hull, field.w, field.h, hullSx, hullSy, hullTx, hullTy)
      // `undefined` is "no drawable component", not a failure (design §7): the sheet stays on
      // `uEdgeMode = 2` and renders exactly as it does today. A GL failure below is a different
      // thing and is never swallowed into this branch.
      if (bytes !== undefined) {
        const mask = m.ctx.texture({
          width: field.w,
          height: field.h,
          format: 'RGBA8UI',
          filter: 'NEAREST',
          label: `paper.hullMask:${handle.spriteKey}`,
        })
        if (GlError.is(mask)) {
          return new SheetError(
            `paperSheet: build() could not allocate the hull mask for sprite ${handle.spriteKey}`,
            { cause: mask },
          )
        }
        const uploaded = m.ctx.scope(() => uploadBytes(m.ctx.gl, mask, bytes))
        if (GlError.is(uploaded)) {
          mask.dispose()
          return new SheetError(
            `paperSheet: build() could not upload the hull mask for sprite ${handle.spriteKey}`,
            { cause: uploaded },
          )
        }
        const builtField = sdf.buildField({
          artwork: mask,
          artworkUv: [1, 1, 0, 0],
          width: field.w,
          height: field.h,
          sourceLongSide: frontLongSide,
          slot: SDF_POOL_SLOTS.hullField,
        })
        mask.dispose()
        if (GlError.is(builtField)) {
          return new SheetError(
            `paperSheet: build() could not build the hull field for sprite ${handle.spriteKey}`,
            { cause: builtField },
          )
        }
        paperField = builtField
      }
      // Success path only, once `paperField` has been assigned (or deliberately left `null` for
      // "no drawable component"): an error path above returns before reaching here, and a record
      // that claimed a field it did not build would be worse than no cache at all.
      m.lastFieldBuild = { ...fieldRecord, paperField }
    }

    // Step 7 (spec 8.7): RGBA8, no mipmaps, LINEAR, non-premultiplied — allocated through
    // `ctx.texture`, never a pool: a front is resident and the core's own LRU budgets it, not
    // this slot (spec 8.1's two pools are scratch, and a front-assembly cache would be a third).
    const front = m.ctx.texture({
      width: size.w,
      height: size.h,
      format: 'RGBA8',
      filter: 'LINEAR',
      label: 'paper.front',
    })
    if (GlError.is(front)) return front

    // Step 8 (spec 8.1): there is no front-assembly FBO — render directly into the front's own
    // texture, the very texture this call returns. The target is disposed at the end of the
    // call; the texture is not.
    const target = m.ctx.target(front)
    if (GlError.is(target)) {
      front.dispose()
      return target
    }

    const renderFailed = m.renderer.renderFront(m.tiles, {
      target: drawTargetFor(target),
      front: size,
      // The same box the fields above were framed on, so the paper the shader cuts from them
      // surrounds the texels it copies from the artwork (spec 7.4.2).
      artworkRect: placement,
      artwork: artworkTexture,
      tight,
      loose,
      // The hull polygon's own field (design 2026-09-02 §3): non-null exactly when the handle
      // carries a polygon hull with at least one drawable component — in `hull` AND `both` modes
      // alike, since step 6b above reads the handle, never `edgeMode`. In `hull` mode that is what
      // makes `paper-renderer.ts:169` select `uEdgeMode = 1`. `use-alpha` and an all-dropped hull
      // keep `null`, and so keep mode 2, bit-identical to before this change.
      //
      // `both` mode changes here too, and deliberately: `paper-renderer.ts:168-172` already
      // substitutes this field for BOTH `tightField` and `looseTexture` when `edgeMode === 'both'`
      // (its own port of the ancestor spike's `edge.js:104-110`), so the silhouette becomes the
      // polygon's contour rather than the tight/loose union. That path was written but never
      // exercised, because `build()` hardcoded `null` until now. Growing `both`'s sheet extent to
      // match is Task 4's concern, not this one's — this is not a "no change" claim for `both`.
      paperField,
      edgeMode,
      values: knobValues,
      descriptors: knobDescriptors,
    })
    target.dispose()
    if (renderFailed !== undefined) {
      front.dispose()
      return renderFailed
    }

    // Step 9: `rect` is the paper's box in THIS front. The artwork is 1:1 in the trace front and
    // in this one, and the paper is built around the artwork, so the box `source()` measured moves
    // with the artwork's origin and nothing else — a translation, not a rescale (fix round 2's
    // uniform `frontLongSide / sourceLongSide` scale, correct only at `p = 0`, is the thing this
    // must never regress to). `SheetFront.rect` is what the motion layer centres the sheet on, so
    // a rect that did not track the paper would be a visible mis-placement on the canvas.
    const rect: Rect = {
      x: handle.frontRect.x + placement.x - tracePlacement.x,
      y: handle.frontRect.y + placement.y - tracePlacement.y,
      w: handle.frontRect.w,
      h: handle.frontRect.h,
    }

    const result: SheetFront = {
      texture: front.handle,
      width: size.w,
      height: size.h,
      rect,
      // The one box the paper was built around, reported so a consumer can lay the picture out
      // without re-deriving the placement rule; `View.frame` maps it through the motion slot's.
      artwork: placement,
      bytes: front.bytes,
    }
    m.liveFronts.add(front)
    m.frontTextures.set(result, { texture: front })
    return result
  }

  function releaseFront(front: SheetFront): void {
    if (mounted === null) return
    // §5.2: `releaseFront` exists so the core never calls `deleteTexture` on slot memory. A
    // no-op for a front this slot does not know — the core may call it twice (§4.6's teardown
    // order makes that likely), and a `WeakMap` lookup that already came up empty stays empty.
    const entry = mounted.frontTextures.get(front)
    if (entry === undefined) return
    mounted.frontTextures.delete(front)
    mounted.liveFronts.delete(entry.texture)
    entry.texture.dispose()
  }

  function release(handle: PaperSheetHandle): void {
    // A second release() of the same handle must not reach the count, the cache or the pool: by
    // then the key it carries may be a live handle's (see `Mounted.liveHandles`).
    if (handle.alive === false) return
    // Set before the `mounted === null` early return, not after: a `release()` that arrives
    // after `dispose()` has nothing left to invalidate or release back to the pool, but the
    // handle itself is still genuinely no longer alive, and this flag is the only thing a caller
    // can check for that. Inert today — `build()` refuses on `mounted === null` first — but the
    // flag should tell the truth regardless of what currently reads it.
    handle.alive = false
    if (mounted === null) return
    const remaining = (mounted.liveHandles.get(handle.spriteKey) ?? 1) - 1
    if (remaining > 0) {
      // Another handle under this key — the re-source of a still-open bitmap — owns the hull
      // entry and the artwork slot now. This one hands back nothing but itself.
      mounted.liveHandles.set(handle.spriteKey, remaining)
      return
    }
    mounted.liveHandles.delete(handle.spriteKey)
    mounted.cache.invalidate(handle.spriteKey)
    if (mounted.pools !== null && mounted.pools.poolA.artworkKey() === handle.spriteKey) {
      // The literal slot name `'artwork'` is `ArtworkPool.holdArtwork`'s own internal convention
      // — not exported as a constant, but exercised directly by core's own suite
      // (`gl-pools.test.ts`'s `pools.poolA.release('artwork')`), so it is a stable part of the
      // contract rather than a private implementation detail this module is reaching past.
      mounted.pools.poolA.release('artwork')
    }
  }

  function dispose(): void {
    if (mounted === null) return
    const m = mounted
    mounted = null
    for (const texture of m.liveFronts) texture.dispose()
    m.liveFronts.clear()
    m.tiles.dispose()
    m.renderer.dispose()
    m.resampler.dispose()
    m.sdf?.dispose()
    m.pools?.dispose()
    m.cache.clear()
  }

  return {
    edgeMode,
    knobs: knobDescriptors,
    overscan,
    get tilesReady() {
      return tilesReadyState.promise
    },
    mount,
    source,
    build,
    releaseFront,
    release,
    dispose,
    invalidateHull,
    get __afterHullForTest() {
      return afterHullForTest
    },
    set __afterHullForTest(fn) {
      afterHullForTest = fn
    },
    get __afterFieldForTest() {
      return afterFieldForTest
    },
    set __afterFieldForTest(fn) {
      afterFieldForTest = fn
    },
  }
}
