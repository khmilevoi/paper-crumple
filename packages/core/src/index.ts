/**
 * `@paper-crumple/core` — the stable entry point.
 *
 * **This file is append-only for the rest of the run.** Every export is named explicitly rather
 * than star-re-exported, so a neighbouring plan's addition is a clean append and two plans
 * exporting one name collide loudly at the sync point instead of silently shadowing.
 *
 * The convention (§10): functions return `Error | T`, callers narrow with `instanceof Error` and
 * exit early; cancellation is the `ABORTED` sentinel and never an `Error`; a promise that fails
 * resolves to an Error rather than rejecting; `on()` never returns an `Error | T`.
 */

// --- P2: errors and the convention (§10) ---
export {
  AbortedError,
  AssetError,
  CoreDuplicateError,
  CrumpleError,
  GlError,
  KnobError,
  MotionError,
  PackError,
  PoseError,
  SheetError,
  SourceExpiredError,
  ViewError,
} from './errors.js'
export type { ErrorGuard } from './errors.js'
export { ABORTED, isAborted } from './abort.js'
export type { Aborted } from './abort.js'
export { findCause } from './cause.js'
export { attempt } from './attempt.js'
export { matchError } from './match.js'
export type { MatchHandlers } from './match.js'
export { partition } from './partition.js'
export type { NoAbortedElement } from './partition.js'
export { unwrap, unwrapAsync } from './unwrap.js'
export { assertSingleCore } from './single-core.js'
export { VERSION } from './version.js'
export type {
  AddError,
  BuildError,
  LoadError,
  MountResult,
  PlayResult,
  ReadyError,
  SetResult,
  SourceError,
  SwapResult,
} from './results.js'

// --- P2: the contract types every later plan compiles against ---
export type { Rect, Size } from './geometry.js'
export type { PoseRef } from './pose.js'
export type { GlCaps, DrawTarget } from './gl.js'
export type { SheetFront, SheetRenderer, SourceOptions } from './sheet.js'
export type { DrawArgs, MotionSource } from './motion.js'
export type {
  BlitTarget,
  DirectTarget,
  HostedTarget,
  StageOptions,
  StageOptionsBase,
  Surface,
  ViewTarget,
} from './stage-types.js'
export type { EventName, Events, NoPayload, StageEvent } from './events.js'
export type { DrawResult, KnobDescriptor, Knobs, MotionKnobs, SheetKnobs, View } from './forward.js'

// --- P3: the knob registry (§6) ---
export { KNOB_REFERENCE_PX, enumKnob, knobs } from './knobs.js'
export type {
  BoolKnob,
  ColorKnob,
  EnumKnob,
  EnumKnobSpec,
  Hex,
  IntKnob,
  Invalidates,
  KnobBase,
  KnobUi,
  NumberKnob,
  SharedKnob,
} from './knobs.js'
export { INVALIDATION_ORDER } from './invalidation.js'
export type { Flatten, KnobValue, KnobsAt, KnobsOf } from './knob-types.js'
export { SHARED_KNOBS } from './shared-knobs.js'
export type { SharedKnobs } from './shared-knobs.js'
export type {
  AmbiguousKeys,
  BoundKnobs,
  KnobPatch,
  KnobPatchAt,
  KnobSetter,
  NoExcess,
  OwnKnobs,
  SpriteKnobPatch,
  ViewKnobPatch,
} from './knob-patch.js'

// --- P4: the event bus, the run lifecycle and the dwell arithmetic (§7.1, §7.2, §4.4, §4.5) ---

/**
 * The authored cadence (§7.2). Exported because a consumer chaining two `play()` calls by hand
 * does **not** reproduce `crumpleTo`'s ball hold and has to insert `DWELL_MS[5]` themselves.
 * Frozen: it is the library's schedule, not a consumer's scratch array.
 */
export { DWELL_MS } from './dwell.js'

export type { Run, RunOwner } from './run.js'
export type { PlayOptions, StagePlayOptions } from './runner.js'
export type { SkipReason, StagePlayReport } from './collisions.js'
export type { ViewState } from './view-state.js'

// P5 — resolution (spec 7.4). `sizeForDisplay` is the one name that takes the number of places
// `devicePixelRatio` is thought about from N to one.
export { sizeForDisplay } from './resolution.js'
export type { DisplaySizeRequest } from './resolution.js'

// --- P15: the sprite source path (§4.1, §8.5.1, §8.5.4, amendments 9 and 10) ---
// Four type-only names, and no machinery. `SpriteSource` is the type of `add`'s first parameter,
// `PinFor` composes into its options bag so a bare ImageBitmap without `pin: true` does not
// typecheck, `PinnedSource` is what `PinFor` tests against, and `BitmapSupplier` is what a
// consumer writing a supplier annotates. `normalizeSource` and the record it returns are internal
// to the package: P9 imports them from './source.js' by relative path, exactly as it imports the
// front LRU, because `add`'s public shape is P9's to design.
export type { BitmapSupplier, PinFor, PinnedSource, SpriteSource } from './source.js'

// --- P9: the stage, the sprites and the views (§4, §7.3, §8.4, §8.8, §10.6) ---
export { paperStage } from './stage.js'
export type { AddOptions, BlitStage, DirectStage, Fit, HostedStage, StageCommon } from './stage.js'
export type { Sprite } from './sprite.js'
export type { SwapOptions } from './view.js'
export { presetForImageId } from './preset.js'
