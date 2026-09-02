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
import { GlError, isAborted, KnobError, SheetError } from '@paper-crumple/core'
import type {
  Aborted,
  BuildError,
  Knobs,
  SheetFront,
  SheetKnobs,
  SheetRenderer,
  Size,
  SourceError,
  SourceOptions,
} from '@paper-crumple/core'
import type { GlContext, ScratchPools, Texture } from '@paper-crumple/core/unstable'
import { createResampler } from './artwork.js'
import type { Resampler } from './artwork.js'
import type { SdfBuilder } from './gl-sdf.js'
import { freezeOverscan } from './handle.js'
import type { PaperSheetHandle } from './handle.js'
import { hullCache } from './hull-cache.js'
import type { HullCache } from './hull-cache.js'
import { defaultsFor, descriptorsFor, edgeParamsFrom } from './paper-knobs.js'
import type { PaperEdgeMode } from './paper-knobs.js'
import { createPaperRenderer } from './paper-renderer.js'
import type { PaperRenderer } from './paper-renderer.js'
import { loadTileBitmaps, mountNeutralTiles, TILE_NAMES, uploadTiles } from './paper-tiles.js'
import type { MountedTiles } from './paper-tiles.js'
import type { PaperTileSet } from './tile-set.js'

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
    void bitmap
    void o
    if (mounted === null) {
      return new SheetError('paperSheet: call mount(ctx) before source() (spec 5.2)')
    }
    // task 11 (paper-sheet-renderer) replaces this body with the hull trace, the resample and
    // the field build. Until then this is an honest failure, not a fake success.
    return new SheetError(
      'paperSheet: source() is not implemented yet — task 11 of paper-sheet-renderer adds it',
    )
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
  }
}
