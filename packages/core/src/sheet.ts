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
  readonly bytes: number
}

/**
 * `sdfRes` is deliberately absent: it is one renderer's jump-flood resolution, and it becomes
 * `sheet.sdfRes`, a knob with `invalidates: 'field'` (§5.2).
 */
export type SourceOptions = {
  maxSize: number
  exact: boolean
  signal?: AbortSignal
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
  /** How much larger the sheet is than the artwork it carries, per side. See §8.6. */
  readonly overscan: number

  mount(ctx: GlContext): InstanceType<typeof GlError> | undefined
  source(bitmap: ImageBitmap, o: SourceOptions): Promise<SourceError | Aborted | H>
  build(handle: H, size: Size, knobs: Readonly<SheetKnobs<K>>): BuildError | SheetFront
  releaseFront(front: SheetFront): void
  release(handle: H): void
  dispose(): void
}
