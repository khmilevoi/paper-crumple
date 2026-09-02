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
 * The four GL resource names §5.1 uses and never shapes. **P6 settled all four**, in
 * `./gl-resources.ts`, where §8.7's format and layout decision lands. They are re-exported from
 * here rather than moved, so that `unstable.ts` — an append-only surface — needs no edit to an
 * existing line.
 */
export type { Program, Target, Texture, TextureDesc } from './gl-resources.js'

/**
 * §4.2's view. **P9 declares its members** — `pose`, `state`, `sprite`, `run`, `tag`,
 * `idealSize`, `play`, `crumpleTo`, `swapTo`, `refresh`, `draw`, `show`, `stop`, `set`, `on`,
 * `once`, `dispose`. P2 declares the name because `MountResult`, `StageOptions.onError` and the
 * stage-side handler type all mention it and all three are P2's.
 *
 * Until P9 fills it, `View` is structurally satisfied by any object. That is a two-wave cost and
 * it is the cheaper one: the alternative is P2 guessing at §4.2's surface.
 */
export type { View } from './view.js'

/**
 * What `MotionSource.draw` reports back. §5.3 names the type and never gives its members.
 * **P11 declares them**, with P9 as their only reader.
 *
 * The two members are exactly what §8.4's batching claim needs to be checkable. Sorting by
 * `sortKey` yields "up to 36 VAO binds and exactly one program bind", and `(sortKey, frame)`
 * names the VAO that was bound uniquely — a stage that wants to verify the bind count has the
 * pair it needs and nothing it would have to interpret.
 */
export interface DrawResult {
  /** The `sortKey` of the fit that was drawn. Opaque to the core (§5.3). */
  readonly sortKey: string
  /** The stored-frame slot whose VAO was bound. */
  readonly frame: number
}

/**
 * §6.1's descriptor union and §5.5's resolved bag. **P3 settled both**, in `./knobs.ts`. They are
 * re-exported from here rather than moved, so that `index.ts` — an append-only surface at
 * sync 2 — needs no edit to an existing line.
 */
export type { KnobDescriptor, Knobs } from './knobs.js'

/**
 * §5.5's per-slot filtered views. **P3 settled both**, in `./shared-knobs.ts`, as
 * `Flatten<SharedKnobs & K>` — a widening of P2's placeholder `K`, so a slot written against the
 * placeholder keeps compiling.
 */
export type { MotionKnobs, SheetKnobs } from './shared-knobs.js'
