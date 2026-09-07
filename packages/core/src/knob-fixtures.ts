/**
 * Two fake slot descriptor tuples, shaped like the real pair: an ambiguous numeric key tuned
 * differently on each side (`grain`, 0.09 against a flat sheet and 0.18 against a shaded 3D mesh,
 * §6.2), an ambiguous enum (`debug`, two debug views that must stay isolated), a bound colour on
 * both sides, one knob per level of the ladder, and one `reference: 'sprite-px'` knob.
 *
 * **Test fixture only.** Nothing imports it from `index.ts` or `unstable.ts`, so tsdown — which
 * bundles from those two entry points — never reaches it and it is not published.
 */
import { enumKnob, knobs } from './knobs.js'

export const FIXTURE_SHEET = knobs([
  {
    key: 'grain',
    kind: 'number',
    invalidates: 'front',
    default: 0.09,
    min: 0,
    max: 0.5,
    step: 0.01,
  },
  {
    key: 'tearAmp',
    kind: 'number',
    invalidates: 'front',
    default: 30,
    min: 0,
    max: 80,
    reference: 'sprite-px',
    ui: { label: 'Tear amplitude', unit: 'px', group: 'Edge' },
  },
  { key: 'angularity', kind: 'number', invalidates: 'hull', default: 0.5, min: 0, max: 1 },
  { key: 'sdfRes', kind: 'int', invalidates: 'field', default: 192, min: 64, max: 512 },
  { key: 'ambient', kind: 'number', invalidates: 'draw', default: 0.35, min: 0, max: 1 },
  {
    key: 'paperColor',
    kind: 'color',
    invalidates: 'front',
    default: '#f7f4ed',
    binds: 'paperColor',
  },
  enumKnob({
    key: 'debug',
    invalidates: 'draw',
    values: ['off', 'sdf', 'hull'],
    default: 'off',
    dev: true,
  }),
])

export const FIXTURE_MOTION = knobs([
  { key: 'grain', kind: 'number', invalidates: 'draw', default: 0.18, min: 0, max: 0.6 },
  { key: 'fillLight', kind: 'number', invalidates: 'draw', default: 0.6, min: 0, max: 6.283 },
  { key: 'shadow', kind: 'bool', invalidates: 'draw', default: true },
  {
    key: 'paperColor',
    kind: 'color',
    invalidates: 'front',
    default: '#f7f4ed',
    binds: 'paperColor',
  },
  enumKnob({
    key: 'debug',
    invalidates: 'draw',
    values: ['off', 'normals', 'depth'],
    default: 'off',
    dev: true,
  }),
])

/** A slot that declares a key core already owns, unbound. Used only for the shadowing rule. */
export const FIXTURE_SHADOWING_SHEET = knobs([
  { key: 'paperColor', kind: 'color', invalidates: 'draw', default: '#112233' },
])
