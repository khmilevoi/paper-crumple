/**
 * The motion slot's knob registry (§6.7): five look knobs plus a debug view, and nothing else.
 *
 * `paperColor` and `paperBack` are **core-declared shared knobs** (§6.2) and are deliberately
 * absent here — `MotionKnobs<K> = Flatten<SharedKnobs & K>` delivers them into the draw's bag
 * without a descriptor, and declaring them again would put two descriptors behind one value.
 *
 * `lightAngle` **cannot** be a knob at all: `uLight` is read from the pack manifest, which §9.3
 * lists among the values baked in. It is a paper-only knob and it is not shareable (§6.2).
 *
 * Every knob here is `invalidates: 'draw'`. None of them changes a texture, a program or the set
 * of other knobs, which is §6.5's rule for what may be a knob at all.
 */
import { enumKnob, knobs } from '@paper-crumple/core'
import type { KnobsOf } from '@paper-crumple/core'

import { DEBUG_VIEWS } from './shaders.js'

/**
 * Reference px per fibre tile on a 1000 px-tall sprite — the same figure `paper.js` uses, and the
 * reason the draw divides by `front.height / KNOB_REFERENCE_PX` (§6.4).
 */
export const FIBRE_TILE_PX = 300

/**
 * The five sliders `index.html` puts on the panel in the spike (`crumple.js:33-46`), carried over
 * with their ranges and defaults unchanged.
 *
 * `grain` defaults to **0.18** and not to the sheet's 0.09. §6.2 records the two as separately
 * tuned — one against a flat sheet, one against a shaded 3D mesh — and the namespaced registry is
 * what keeps them apart; `stage.set({ grain })` is a compile error naming both.
 */
export const MOTION_KNOBS = knobs([
  {
    key: 'ambient',
    kind: 'number',
    invalidates: 'draw',
    default: 0.86,
    min: 0,
    max: 1,
    step: 0.01,
    ui: { label: 'ambient' },
  },
  {
    key: 'aoStrength',
    kind: 'number',
    invalidates: 'draw',
    default: 0.48,
    min: 0,
    max: 1,
    step: 0.01,
    ui: { label: 'baked AO' },
  },
  {
    key: 'aoGamma',
    kind: 'number',
    invalidates: 'draw',
    default: 0.3,
    min: 0.1,
    max: 2,
    step: 0.01,
    ui: { label: 'AO gamma' },
  },
  {
    key: 'backShade',
    kind: 'number',
    invalidates: 'draw',
    default: 0.94,
    min: 0.3,
    max: 1,
    step: 0.01,
    ui: { label: 'reverse shade' },
  },
  {
    key: 'grain',
    kind: 'number',
    invalidates: 'draw',
    default: 0.18,
    min: 0,
    max: 0.6,
    step: 0.01,
    ui: { label: 'fibre grain' },
  },
  enumKnob({
    key: 'debug',
    invalidates: 'draw',
    values: DEBUG_VIEWS,
    default: 'composite',
    dev: true,
    ui: { label: 'debug view' },
  }),
])

/** The resolved bag `draw()` reads, before the core intersects it with `SharedKnobs`. */
export type MotionLookKnobs = KnobsOf<typeof MOTION_KNOBS>
