import { knobs } from './knobs.js'
import type { Knobs } from './knobs.js'
import type { Flatten, KnobsOf } from './knob-types.js'

/**
 * # §6.2 — the shared registry
 *
 * `binds` is what the shared registry actually needs. "`paperColor` must be identical in the 2D
 * sheet and in the 3D fill" is a *declared binding*, not a naming coincidence — and
 * `material.js:170-171` sets **two** colours, not one. A slot opts in by declaring a descriptor
 * with `binds: 'paperColor'`; setting the bare shared key then writes every bound descriptor at
 * once, which is what makes the two identical by construction rather than by convention.
 *
 * These are the reason §6.7's paper count is 36 and not 38: `paperColor` and `paperBack` are
 * core-declared, so they are not among a slot's own knobs.
 *
 * No `ui` here on purpose (§6.1): a consumer's bundle does not carry English labels for a UI this
 * library does not own, and core of all places should not be the one to start.
 */
export const SHARED_KNOBS = knobs([
  {
    key: 'paperColor',
    kind: 'color',
    invalidates: 'front',
    default: '#f7f4ed',
    binds: undefined,
    ui: undefined,
  },
  {
    key: 'paperBack',
    kind: 'color',
    invalidates: 'front',
    default: '#e8e2d4',
    binds: undefined,
    ui: undefined,
  },
])

/** The bag every slot receives on top of its own, whatever else it declares. */
export type SharedKnobs = KnobsOf<typeof SHARED_KNOBS>

/**
 * §5.5 — the sheet slot's filtered view: **its own declared knobs plus the core-declared shared
 * ones**, never the whole merged registry.
 *
 * The original passed the flat registry to both slots and asserted in prose that "neither slot
 * knows anything about the other". Nothing enforced it, and the failure it invites is specific: a
 * third-party motion source reads `knobs.deckleWidth` because `paperSheet` is the only sheet
 * anyone runs, and breaks two months later under a different sheet with a `NaN` margin, in one
 * slot combination, with the bug filed against the wrong package.
 */
export type SheetKnobs<K extends Knobs> = Flatten<SharedKnobs & K>

/** §5.5 — the motion slot's filtered view, on the same terms as `SheetKnobs`. */
export type MotionKnobs<K extends Knobs> = Flatten<SharedKnobs & K>
