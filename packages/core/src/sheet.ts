import type { Aborted } from './abort.js'
import type { GlError } from './errors.js'
import type { KnobDescriptor, Knobs, SheetKnobs } from './forward.js'
import type { Rect, Size } from './geometry.js'
import type { GlContext } from './gl.js'
import type { BuildError, SourceError } from './results.js'

/** The part of a sheet handle the core reads. Everything else is the slot's business (§5.2). */
export interface SheetHandle {
  /** The silhouette's box, in source pixels. */
  readonly rect: Rect
  /**
   * The same box in **front** texels — at the front `source()` sized for its `maxSize` (§7.4.3),
   * which is the scale `build()` copies the artwork into a front at, 1:1 (§7.4.2). This is the
   * rect `motion.fit` sizes the bucket box over (§5.4): a fit sized over the source-pixel `rect`
   * would put the front at the source's own scale, and §8.6 has `maxSize` bound the front.
   */
  readonly frontRect: Rect
  /** The slot's own accounting. The LRU has a byte budget and must not infer `w × h × 4`. */
  readonly bytes: number
}

/** A built front, ready to be drawn (§5.2). */
export interface SheetFront {
  readonly texture: WebGLTexture
  readonly width: number
  readonly height: number
  /** The paper's box, in texture pixels. */
  readonly rect: Rect
  /**
   * The unpadded artwork's box in this front, in texture pixels — where `build()` copied the
   * source 1:1 (§7.4.2), which is the one rectangle the paper is built *around* and the one a
   * consumer laying out the picture rather than the paper has to know. The motion slot centres
   * the sheet on `rect`, not on this, so the artwork's place on the screen is neither the
   * front's centre nor `rect`'s; `View.frame` maps this box through that placement so nothing
   * downstream has to reconstruct it.
   */
  readonly artwork: Rect
  readonly bytes: number
}

/**
 * `sdfRes` is deliberately absent: it is one renderer's jump-flood resolution, and it becomes
 * `sheet.sdfRes`, a knob with `invalidates: 'field'` (§5.2).
 */
export type SourceOptions = {
  maxSize: number
  exact: boolean
  /**
   * The artwork's wanted long side, in texels — the stage's `ceil(artworkCssPx x dpr)`. A slot
   * gives the artwork this many texels when its front still fits `maxSize`, and the largest
   * that does otherwise; absent, the artwork is the largest long side whose front — artwork
   * plus the per-axis margin (§8.6's `frontForArtwork`) — still fits `maxSize`, which is the
   * `cssPx` / `maxSize` stages' contract. Optional, so a slot that ignores it keeps compiling —
   * and then `artworkCssPx` degrades to the `maxSize` reading for that slot.
   */
  artworkLongSide?: number
  signal?: AbortSignal
  /**
   * The sheet's knob values for the sprite — §6.6's ladder projected onto the slot, the very bag
   * `build()` is handed. §6.3 makes `hull` a tier of its own ("invalidate the hull cache, then
   * front", keyed on "every knob at or above `'hull'`"), and §5.2 moves the hull, its cache and
   * its key inside `source()` — so the values the hull-tier knobs hold have to reach `source()`,
   * or a `build()` at any value but the slot's own defaults has no hull to build from and can
   * only answer `SourceExpiredError`. Optional: a slot driven without a stage traces at its
   * defaults.
   */
  knobs?: Knobs
}

/**
 * The sheet slot (§5.2). **P10 `paper-sheet-renderer` implements it**; nothing in wave 2 does.
 *
 * `source()` accepts a `signal`, so its return carries `| Aborted` — §10.5's rule is about the
 * signature, and `SourceError` no longer carries `AbortedError` (amendment 1). `build()` accepts
 * none, so it never mentions `Aborted`. The slot still receives an `ImageBitmap`: amendment 9's
 * `SpriteSource` is a *stage* parameter, and resolving a URL, a `Blob` or a supplier into a
 * bitmap is the core's work, done before `source()` is called.
 */
export interface SheetRenderer<K extends Knobs = Knobs, H extends SheetHandle = SheetHandle> {
  readonly knobs: readonly KnobDescriptor[]
  /**
   * The margin reserved on every side of the artwork, as a fraction of the artwork's height: for
   * a real sprite (`artwork.w x artwork.h` known) each side gets `ceil(overscan x artwork.h)`
   * texels, so its front's long side is exactly `artwork.long + 2 x ceil(overscan x artwork.h)`
   * (`frontForArtwork` in `paper/src/handle.ts`), not `artwork.long x (1 + 2 x overscan)` in
   * general — the two agree only for a portrait or square source. Before any sprite exists, the
   * stage sizes its surface from `artworkLongSide` alone (no real height to reserve against yet):
   * `frontCapFor` treats the long side as if it were the height too, giving the conservative cap
   * `artworkLongSide + 2 x ceil(overscan x artworkLongSide)`, which is never smaller than either
   * formula above, so every real aspect's front — and a slot that only honours the old
   * `x (1 + 2 x overscan)` bound — still fits inside what the stage allocates. See §8.6.
   */
  readonly overscan: number

  /**
   * Synchronous. Returns the errors it can detect without waiting for the driver; on a driver
   * with `KHR_parallel_shader_compile` a shader that fails to compile or link is reported by the
   * first `source()` instead (§5.2 amendment, P7 — `Program.ready()`), so the compile never
   * blocks the page.
   */
  mount(ctx: GlContext): InstanceType<typeof GlError> | undefined
  source(bitmap: ImageBitmap, o: SourceOptions): Promise<SourceError | Aborted | H>
  build(handle: H, size: Size, knobs: Readonly<SheetKnobs<K>>): BuildError | SheetFront
  releaseFront(front: SheetFront): void
  release(handle: H): void
  dispose(): void
}
