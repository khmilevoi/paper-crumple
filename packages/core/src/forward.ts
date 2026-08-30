/* eslint-disable @typescript-eslint/no-empty-object-type --
 * Several declarations here have no members yet, on purpose: the plan that owns the type gives
 * it members, and inventing them here would pre-empt that plan's design. An empty interface is
 * the honest declaration of "this name exists and its shape is somebody else's".
 */

import type { Knobs } from './knobs.js'

/**
 * # Forward declarations
 *
 * P2 owns signatures that mention types P2 does not own. This file holds every one of them, so
 * the borrowed names are in one place, greppable, and each carries the plan that settles it.
 * **A later plan replaces the declaration here rather than adding a second one**; a duplicate
 * export in the core barrel is a decomposition violation and sync 2 reports it as one.
 *
 * | Name | Settled by | Spec |
 * | --- | --- | --- |
 * | `Program`, `Texture`, `Target`, `TextureDesc` | P6 `core-gl-foundation` | §5.1 |
 * | `View` | P9 `core-stage-sprite-view` | §4.2 |
 * | `DrawResult` | P11 `motion-source`, with P9 as its only reader | §5.3 |
 * | `KnobDescriptor`, `Knobs`, `SheetKnobs`, `MotionKnobs` | P3 `core-knob-registry`, re-exported below | §5.5, §6.1, §6.8 |
 */

/**
 * A compiled program handle, returned by `GlContext.program`. **P6 declares its members.**
 * The spec names the type in §5.1 and never gives it a shape.
 */
export interface Program {}

/**
 * A GPU texture handle, returned by `GlContext.texture`. **P6 declares its members.**
 */
export interface Texture {}

/**
 * A render target over a `Texture`, returned by `GlContext.target`. **P6 declares its members.**
 */
export interface Target {}

/**
 * The description `GlContext.texture` allocates from. **P6 declares its members**, which are
 * where §8.7's format and layout decision lands.
 */
export interface TextureDesc {}

/**
 * §4.2's view. **P9 declares its members** — `pose`, `state`, `sprite`, `run`, `tag`,
 * `idealSize`, `play`, `crumpleTo`, `swapTo`, `refresh`, `draw`, `show`, `stop`, `set`, `on`,
 * `once`, `dispose`. P2 declares the name because `MountResult`, `StageOptions.onError` and the
 * stage-side handler type all mention it and all three are P2's.
 *
 * Until P9 fills it, `View` is structurally satisfied by any object. That is a two-wave cost and
 * it is the cheaper one: the alternative is P2 guessing at §4.2's surface.
 */
export interface View {}

/**
 * What `MotionSource.draw` reports back. §5.3 names the type and never gives its members.
 * **P11 declares them**, with P9 as their only reader.
 */
export interface DrawResult {}

/**
 * §6.1's descriptor union and §5.5's resolved bag. **P3 settled both**, in `./knobs.ts`. They are
 * re-exported from here rather than moved, so that `index.ts` — an append-only surface at
 * sync 2 — needs no edit to an existing line.
 */
export type { KnobDescriptor, Knobs } from './knobs.js'

/**
 * §5.5's filtered view for the sheet slot. **P3 replaces this with
 * `Flatten<SharedKnobs & K>`**, which is a widening of what a slot receives, so a slot written
 * against this declaration keeps compiling.
 */
export type SheetKnobs<K extends Knobs> = K

/**
 * §5.5's filtered view for the motion slot. **P3 replaces this with
 * `Flatten<SharedKnobs & K>`**, on the same terms as `SheetKnobs`.
 */
export type MotionKnobs<K extends Knobs> = K
