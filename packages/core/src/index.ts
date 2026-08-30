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
