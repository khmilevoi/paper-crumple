import type { Aborted } from './abort.js'
import type {
  AssetError,
  GlError,
  KnobError,
  MotionError,
  PackError,
  PoseError,
  SheetError,
  SourceExpiredError,
  ViewError,
} from './errors.js'
import type { View } from './forward.js'

/**
 * # The named union aliases (§10.2)
 *
 * Return types stay narrow unions, but the unions are named and exported. This is the mechanism
 * that survives a new error class in a minor release: `if (x instanceof Error)` and
 * `CrumpleError.is(x)` are unaffected; naming the constituents inline in an annotation breaks;
 * and an exhaustive `_tag` switch breaks — which is correct, because a consumer who claimed to
 * handle every case no longer does. `matchError`'s mandatory `else` is the escape for a consumer
 * who only meant to route three tags.
 *
 * **Every alias in this file may gain members in a minor release.** That is documented, and it
 * is the whole point.
 *
 * `AbortedError` is not a member of any of them (amendment 1): abort is a sentinel, so it
 * appears in a *return type* as `| Aborted` and never inside an error union.
 */

/** `SheetRenderer.source()` — §5.2. The return adds `| Aborted`, because `source()` takes a signal. */
export type SourceError = InstanceType<typeof SheetError> | InstanceType<typeof GlError>

/** `SheetRenderer.build()` — §5.2. Synchronous and uncancellable, so it never carries `Aborted`. */
export type BuildError =
  | InstanceType<typeof SheetError>
  | InstanceType<typeof GlError>
  | InstanceType<typeof SourceExpiredError>

/** `MotionSource.load()` — §5.3. The return adds `| Aborted`, because `load()` takes a signal. */
export type LoadError = InstanceType<typeof PackError> | InstanceType<typeof AssetError>

/** `stage.add()` and everything composed from it — §4.1. */
export type AddError =
  | InstanceType<typeof SheetError>
  | InstanceType<typeof GlError>
  | InstanceType<typeof MotionError>
  | InstanceType<typeof PackError>
  | InstanceType<typeof AssetError>

/** `paperStage()` reaching its invariants — §4.0. */
export type ReadyError = InstanceType<typeof GlError> | InstanceType<typeof KnobError>

/**
 * `view.play()` — §4.2. A play moves between two poses of one sprite and resolves no target, so
 * it cannot carry `AddError`; that distinction is what §4.2's `Run<R>` parameter exists to keep.
 */
export type PlayResult = undefined | InstanceType<typeof PoseError> | Aborted

/** `view.crumpleTo()` and `view.swapTo()` — §4.2. A swap resolves a sprite, so it carries `AddError`. */
export type SwapResult = undefined | InstanceType<typeof PoseError> | AddError | Aborted

/** `stage.mount()` — §4.2, amendment 11. `add` + `view` + `show('flat')` in one call. */
export type MountResult = View | AddError | InstanceType<typeof ViewError> | Aborted

/**
 * `stage.set()`, `sprite.set()` and `view.set()` — §6.8, amendment 19. `undefined` and not
 * `void`, so `if (err)` narrows and the result is storable.
 */
export type SetResult = InstanceType<typeof KnobError> | undefined
