import type { Aborted } from './abort.js'
import type { GlError, MotionError } from './errors.js'
import type { DrawResult, KnobDescriptor, Knobs, MotionKnobs } from './forward.js'
import type { Rect, Size } from './geometry.js'
import type { DrawTarget, GlContext } from './gl.js'
import type { LoadError } from './results.js'
import type { SheetFront } from './sheet.js'

/** The part of a fit the core reads (§5.3). */
export interface MotionFit {
  /** What the sheet front must be rendered at. */
  readonly frontSize: Size
  /** Batching key; opaque to the core. It sorts draws by an equality key it cannot interpret. */
  readonly sortKey: string
}

/** The part of a loaded clip the core reads (§5.3). */
export interface MotionClip {
  readonly frameCount: number
  /** Pose index to stored-frame index. */
  readonly keyFrames: readonly number[]
}

/** Everything a draw needs, passed on every call — there is no "current instance" (§5). */
export interface DrawArgs<F, C, K extends Knobs> {
  readonly clip: C
  readonly fit: F
  readonly frame: number
  readonly front: SheetFront
  readonly out: DrawTarget
  readonly knobs: Readonly<MotionKnobs<K>>
}

/**
 * The motion slot (§5.3). **P11 `motion-source` implements it**; nothing in wave 2 does.
 *
 * `load(fit)` and not `load(variant)`: the core cannot mint a variant name, because `MotionFit`
 * is opaque to it, so a string-typed variant had no legal caller. `load()` accepts a `signal`,
 * so its return carries `| Aborted`; `fit()` is pure and does not. The shared per-bucket pack
 * fetch is never cancelled by a per-sprite signal — it is shared by every sprite in that bucket.
 */
export interface MotionSource<
  K extends Knobs = Knobs,
  F extends MotionFit = MotionFit,
  C extends MotionClip = MotionClip,
> {
  readonly knobs: readonly KnobDescriptor[]

  mount(ctx: GlContext): InstanceType<typeof GlError> | undefined
  /** Pure. */
  fit(rect: Rect, override?: string | null): InstanceType<typeof MotionError> | F
  load(fit: F, o?: { signal?: AbortSignal }): Promise<LoadError | Aborted | C>
  draw(a: DrawArgs<F, C, K>): InstanceType<typeof GlError> | DrawResult
  release(clip: C): void
  dispose(): void
}
