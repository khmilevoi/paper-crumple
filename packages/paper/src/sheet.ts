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
import { ABORTED, attempt, GlError, isAborted, KnobError, SheetError } from '@paper-crumple/core'
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
  artworkLongSide,
  checkGuardBand,
  createScratchPools,
  exactFrontLongSide,
  handleBytes,
  hullCacheKey,
  KNOB_REFERENCE_PX,
  overscanRadius,
} from '@paper-crumple/core/unstable'
import type { GlContext, HandleFacts, ScratchPools, Texture } from '@paper-crumple/core/unstable'
import { createResampler } from './artwork.js'
import type { Resampler } from './artwork.js'
import { cpuSdfFromAlpha } from './field.js'
import { growBox, scaleBox, sheetRectFromExtent, signedFieldExtent } from './extent.js'
import type { AlphaBox } from './mask.js'
import { createSdfBuilder, sigmaFor } from './gl-sdf.js'
import type { Field, SdfBuilder } from './gl-sdf.js'
import { freezeOverscan } from './handle.js'
import type { PaperSheetHandle } from './handle.js'
import { hullCache } from './hull-cache.js'
import type { HullCache, HullCacheKey } from './hull-cache.js'
import { DISTANCE_WAVELENGTH_PX, buildHull, toleranceFor } from './hull.js'
import { hullBuffers, hullExtent } from './hull-shape.js'
import type { HullShape } from './hull-shape.js'
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
 * **`overscan` here is the FACTORY-level figure, and it is a different number from a sprite's
 * own reserve the moment a consumer touches a margin knob.** It is computed once, synchronously,
 * as `freezeOverscan(edgeParamsFrom(edgeMode, defaultsFor(edgeMode)), overscanHeadroom).overscan`
 * — this factory's *default* knob values, before any sprite exists. Spec 5.2 puts one readonly
 * number on `SheetRenderer` because the core reads `sheet.overscan` before `add()` has produced a
 * handle to ask instead. Spec 8.6, by contrast, derives overscan *per sprite* from that sprite's
 * own edge-knob values and freezes it at `add()` (`handle.ts`'s `PaperSheetHandle.overscan` /
 * `freezeOverscan`). The two coincide only while a sprite's edge knobs still sit at this
 * factory's defaults; the instant a consumer sets, say, a larger `maxDist` on one sprite,
 * `sheet.overscan` keeps reporting the factory baseline and that sprite's own handle carries the
 * sprite's real, larger reserve. Neither number is wrong; they answer different questions asked
 * at different times.
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
}

/**
 * §7.4.3's own rule, reused for `A`, for the front and for the field: the long axis takes
 * `longSide` exactly, the short axis keeps the SOURCE's aspect ratio (step 3 of the brief's
 * ten-step pipeline, applied wherever a size is derived from a long-side figure).
 */
function dimsForLongSide(longSide: number, srcW: number, srcH: number, floor = 1): Size {
  const long = Math.max(srcW, srcH)
  const short = Math.min(srcW, srcH)
  const shortSide = Math.max(floor, Math.round((longSide * short) / long))
  return srcW >= srcH ? { w: longSide, h: shortSide } : { w: shortSide, h: longSide }
}

/**
 * A numeric knob value, or `fallback` when the key is absent from `values` — which happens for
 * real here: `values` is always `defaultsFor(edgeMode)` (§5.2 passes no per-sprite knob values to
 * `source()`), and a `torn`-only or `hull`-only descriptor is simply not in the other mode's set
 * (`edgeParamsFrom`'s own `num` helper makes the same allowance).
 */
function numKnob(values: Knobs, key: string, fallback: number): number {
  const v = values[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** A plain per-axis `Rect` scale — no box-margin logic, unlike `sheetRectFromExtent`. */
function scaleRect(r: Rect, scale: number): Rect {
  return {
    x: Math.round(r.x * scale),
    y: Math.round(r.y * scale),
    w: Math.max(1, Math.round(r.w * scale)),
    h: Math.max(1, Math.round(r.h * scale)),
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
 * P8's `cpuSdfFromAlpha` over the sprite's own alpha, scaled directly to the field's resolution —
 * the degraded branch (~120 ms at 512, §8.2.1) this port falls to when `readBackField` refuses.
 * Both DOM boundaries (`OffscreenCanvas` construction, `getImageData`) are wrapped in `attempt`
 * (§10.8): a closed or detached bitmap must resolve to a `GlError`, never throw.
 */
function cpuFieldFallback(
  bitmap: ImageBitmap,
  w: number,
  h: number,
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

  const drawn = attempt(
    () => c2d.drawImage(bitmap, 0, 0, w, h),
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
  for (let i = 0, p = 3; i < alpha.length; i++, p += 4) alpha[i] = data[p] / 255
  return cpuSdfFromAlpha(alpha, w, h)
}

/**
 * True when `field` came off `readBackField` — GPU-native, y-up like every GPU texture; false
 * when it came off `cpuFieldFallback` — canvas-native, y-down like the canvas it was read off.
 * Carried per the brief's own warning ("the subtle bug the spike documents"): whichever later
 * stage rasterizes this sprite's hull mask onto the GPU (`engine.js`'s own
 * `pixelStorei(UNPACK_FLIP_Y_WEBGL, !cpuSdfYUp)`) needs it to flip correctly. `source()` itself
 * only traces the polygon and never rasterizes it, so nothing inside this call consumes it — it
 * is not persisted onto `PaperSheetHandle` (frozen by task 8) and is a documented, deliberate
 * departure from an otherwise-whole port; see the task report.
 */
interface CpuField {
  readonly field: Float32Array
  readonly yUp: boolean
}

function acquireCpuField(
  ctx: GlContext,
  tight: Field,
  texelPx: number,
  bitmap: ImageBitmap,
): InstanceType<typeof GlError> | CpuField {
  const readBack = readBackField(ctx, tight, texelPx)
  if (readBack !== null) return { field: readBack, yUp: true }
  const fallback = cpuFieldFallback(bitmap, tight.width, tight.height)
  if (GlError.is(fallback)) return fallback
  return { field: fallback, yUp: false }
}

export function paperSheet(options?: PaperSheetOptions): PaperSheet {
  const edgeMode: PaperEdgeMode = options?.edgeMode ?? 'hull'
  const tileSet: PaperTileSet | null = options?.tiles ?? null
  const overscanHeadroom = options?.overscanHeadroom ?? 0
  const knobDescriptors = descriptorsFor(edgeMode)

  // §6.5/§8.6: the factory-level baseline. See `PaperSheet.overscan`'s doc comment for why this
  // is not the same number `add()` later freezes onto a sprite's own handle.
  const reserve = freezeOverscan(edgeParamsFrom(edgeMode, defaultsFor(edgeMode)), overscanHeadroom)
  // Every mode's own *default* knob values reserve well under the 500 reference-px ceiling
  // `overscanFromRadius` guards, so this branch is unreachable for any of the three edge modes —
  // kept because `freezeOverscan`'s return type still carries it, and §10.8 forbids unwrapping an
  // `Error | T` unchecked even when a branch is believed dead.
  const overscan = KnobError.is(reserve) ? 0 : reserve.overscan

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

  function mount(ctx: GlContext): InstanceType<typeof GlError> | undefined {
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
    }

    tilesReadyState = makeDeferred<InstanceType<typeof GlError> | true>()

    if (tileSet === null) {
      tilesReadyState.resolve(true)
      return undefined
    }

    // Fire-and-forget with a value, never a floating rejection (spec 5.2's own wording).
    // `loadTileBitmaps` never rejects; the `try`/`catch` below is the belt for anything inside
    // this callback that could throw regardless (a closed-bitmap `.close()`, in principle),
    // so a bug here becomes a `GlError` on `tilesReady` and never an unhandled rejection.
    loadTileBitmaps(tileSet).then((result) => {
      try {
        if (GlError.is(result)) {
          tilesReadyState.resolve(result)
          return
        }
        if (isAborted(result)) {
          // No `signal` is ever passed to this internal call, so this is unreachable in
          // practice; handled because `loadTileBitmaps`'s own return type allows it.
          tilesReadyState.resolve(new GlError('paperSheet: unexpected tile-load abort'))
          return
        }
        if (mounted === null) {
          // `dispose()` ran while the fetch was in flight. Nothing left to swap the tiles into;
          // close what was decoded so the bitmaps do not leak.
          for (const name of TILE_NAMES) result[name].close()
          tilesReadyState.resolve(new GlError('paperSheet: tiles landed after dispose()'))
          return
        }
        const uploaded = uploadTiles(mounted.ctx, result)
        for (const name of TILE_NAMES) result[name].close()
        if (GlError.is(uploaded)) {
          tilesReadyState.resolve(uploaded)
          return
        }
        const previous = mounted.tiles
        mounted.tiles = uploaded
        previous.dispose()
        tilesReadyState.resolve(true)
      } catch (cause) {
        tilesReadyState.resolve(
          new GlError('paperSheet: tile mount failed unexpectedly', { cause }),
        )
      }
    })

    return undefined
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
    if (o.signal?.aborted === true) return ABORTED

    // §5.2 passes no per-sprite knob values to source(); the hull-trace-relevant work here runs
    // at this factory's default values, exactly as the factory-level `overscan` above does.
    const values = defaultsFor(edgeMode)
    const edgeParams = edgeParamsFrom(edgeMode, values)

    // Step 1: handle-level overscan.
    const sourceReserve = freezeOverscan(edgeParams, overscanHeadroom)
    if (KnobError.is(sourceReserve)) {
      // `KnobError` is not a member of `SourceError` (only `SheetError | GlError` are, per
      // amendment 1's `results.ts`), so it is wrapped rather than returned "as is" at the type
      // level; the cause is preserved. Unreachable for any of the three edge modes at their own
      // defaults (`paperSheet()`'s own `overscan` computation above notes the same thing), kept
      // because §10.8 forbids unwrapping an `Error | T` unchecked even when a branch is believed
      // dead.
      return new SheetError('paperSheet: source() could not derive overscan', {
        cause: sourceReserve,
      })
    }
    const p = sourceReserve.overscan

    const info = spriteInfoFor(bitmap)
    const spriteKey = info.key

    // Steps 2-3: frontLongSide, A_long, and A itself (source aspect kept).
    const srcW = info.srcW
    const srcH = info.srcH
    const sourceLongSide = Math.max(srcW, srcH)
    const frontLongSide = o.exact ? exactFrontLongSide(sourceLongSide, p) : o.maxSize
    const aLongSide = o.exact ? sourceLongSide : artworkLongSide(o.maxSize, p)
    const artwork = dimsForLongSide(aLongSide, srcW, srcH)

    // Step 4: sdfRes, off the front's long side (§7.4.3).
    const sdfRes = resolveSdfRes(numKnob(values, 'sdfRes', 0), frontLongSide)

    // The front's own size (never materialised as a texture here — task 12's `build()` does
    // that) and the field's size, both keeping the source aspect at their own long side.
    const front = dimsForLongSide(frontLongSide, srcW, srcH)
    const field = dimsForLongSide(sdfRes, front.w, front.h, 2)

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

    // Step 7: buildField — the margin applied as a uv offset, at no cost (§8.5).
    const artworkUvScale = 1 + 2 * p
    const tight = sdf.buildField({
      artwork: artworkTexture,
      artworkUv: [artworkUvScale, artworkUvScale, -p * artworkUvScale, -p * artworkUvScale],
      width: field.w,
      height: field.h,
      sourceLongSide: frontLongSide,
    })
    if (GlError.is(tight)) return tight

    // Step 8: blurField — sigma off `looseness`, which a `hull`-only sheet does not even declare
    // as a knob (`numKnob` falls back to 0, the field's own no-blur floor). Not otherwise
    // consumed here: `build()` (task 12) re-derives it against the sprite's real knob values.
    const looseness = numKnob(values, 'looseness', 0)
    const blurred = sdf.blurField({
      field: tight,
      sigmaPx: sigmaFor(looseness, frontLongSide),
      frontLongSide,
    })
    if (GlError.is(blurred)) return blurred

    // Abort check point 2 (§10.5): after the resample and the two field passes, before the CPU
    // hull trace — the boundary between work already paid for and the one genuinely
    // interruptible step. The `await` is what makes this point (and the third one, below)
    // observable from outside a synchronous call: without it nothing here would ever yield.
    await Promise.resolve()
    if (o.signal?.aborted === true) return ABORTED

    // Step 9: the CPU signed field for the hull trace, then buildHull, then the rect, then the
    // guard-band check.
    const texel = front.w / field.w
    const pxScale = front.h / KNOB_REFERENCE_PX
    const k = pxScale / texel

    const knobKey = hullCacheKey(knobDescriptors, values)
    const cacheKey: HullCacheKey = { spriteKey, sdfRes, knobKey }

    let hull: HullShape | undefined = m.cache.get(cacheKey)
    if (hull === undefined) {
      const cpu = acquireCpuField(m.ctx, tight, texel, bitmap)
      if (GlError.is(cpu)) return cpu

      // `torn` mode declares no hull-only descriptors at all — `values.minDist`/`maxDist` are
      // simply absent — so it always passes 0/0, which is what makes `buildHull` return
      // `HULL_USE_ALPHA` (the brief's own instruction).
      const minDist = edgeMode === 'torn' ? 0 : numKnob(values, 'minDist', 0)
      const maxDist = edgeMode === 'torn' ? 0 : numKnob(values, 'maxDist', 0)
      const angularity = numKnob(values, 'angularity', 0)
      const seed = numKnob(values, 'seed', 0)

      const built = buildHull({
        field: cpu.field,
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
    if (o.signal?.aborted === true) return ABORTED

    // The rect (§8.3, no source-sized readback): hull/both take it from the polygon's own
    // extent; torn (and any use-alpha hull) take it from the silhouette's own box, grown by the
    // overscan radius.
    let box: AlphaBox | undefined =
      hull.kind === 'use-alpha' ? undefined : hullExtent(hull, field.w, field.h)
    if (box === undefined) {
      // Only reachable for `torn` (always `use-alpha`) or a degenerate empty trace. The CPU field
      // is not retained past the cache-hit branch above, so a use-alpha rect always re-acquires
      // it — cheap relative to the trace it replaces, and never on the hot (cached-hull) path for
      // hull/both.
      const cpu = acquireCpuField(m.ctx, tight, texel, bitmap)
      if (GlError.is(cpu)) return cpu
      const raw = signedFieldExtent(cpu.field, field.w, field.h)
      if (raw === undefined) {
        return new SheetError('paperSheet: source() found an empty silhouette')
      }
      // `overscanRadius` is reference px (like `minDist`/`maxDist`); `k` is the same
      // reference-px-to-field-texel conversion the hull trace uses above.
      box = growBox(raw, overscanRadius(edgeParams) * k, field.w, field.h)
    }

    const frontBox = scaleBox(box, texel)
    const frontRect = sheetRectFromExtent(frontBox, front.w, front.h)

    // Step 50 (guard band, §8.6): before allocating anything the caller will not receive.
    const guardBand = checkGuardBand({ frontSize: front, hullExtent: frontRect })
    if (guardBand !== undefined) return guardBand

    const sourceScale = sourceLongSide / frontLongSide
    const rect = scaleRect(frontRect, sourceScale)

    const facts: HandleFacts = {
      rect,
      overscan: p,
      sdfRes,
      srcW,
      srcH,
      aspect: srcW / srcH,
      exact: o.exact,
      hull: hullBuffers(hull),
    }

    return {
      spriteKey,
      rect,
      frontRect,
      artwork,
      overscan: p,
      sdfRes,
      srcW,
      srcH,
      aspect: srcW / srcH,
      exact: o.exact,
      edgeMode,
      hull,
      alive: true,
      bytes: handleBytes(facts),
    }
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
    void handle
    void size
    void knobValues
    if (mounted === null) {
      return new SheetError('paperSheet: call mount(ctx) before build() (spec 5.2)')
    }
    // task 12 (paper-sheet-renderer) replaces this body with the real front build: allocate the
    // front through `ctx.texture`, wrap it in a `ctx.target`, render, dispose the target, return
    // the texture (§8.1: no front-assembly FBO, no size-keyed cache).
    return new SheetError(
      'paperSheet: build() is not implemented yet — task 12 of paper-sheet-renderer adds it',
    )
  }

  function releaseFront(front: SheetFront): void {
    void front
    if (mounted === null) return
    // §5.2: `releaseFront` exists so the core never calls `deleteTexture` on slot memory. Until
    // task 12 wires `frontTextures` / `liveFronts` up to a real `build()`, no front this slot
    // returns is ever real, so there is nothing yet to release — but that is worth saying loudly
    // rather than passing silently, since a silent no-op here would look identical to "already
    // freed" to a caller that cannot otherwise tell.
    console.warn(
      'paperSheet.releaseFront: not implemented until task 12 of paper-sheet-renderer — no ' +
        'front from this build of paperSheet() is releasing anything',
    )
  }

  function release(handle: PaperSheetHandle): void {
    void handle
    if (mounted === null) return
    console.warn(
      'paperSheet.release: not implemented until task 12 of paper-sheet-renderer — no handle ' +
        'from this build of paperSheet() is releasing anything',
    )
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
  }
}
