import { describe, expect, it } from 'vitest'
import * as root from './index.js'
import * as unstable from './unstable.js'

/**
 * A subset check and never an exact-set check: both barrels are append-only surfaces at sync 2
 * and P2, P4 and P5 append to them too. Asserting the exact set would turn a neighbour's append
 * into a P3 failure.
 */
const OWED_AT_ROOT = [
  'knobs',
  'enumKnob',
  'KNOB_REFERENCE_PX',
  'SHARED_KNOBS',
  'INVALIDATION_ORDER',
] as const
const OWED_AT_UNSTABLE = [
  'isHex',
  'hexToRgb',
  'atOrAbove',
  'maxInvalidation',
  'hullCacheKey',
  'pxScale',
  'scaleKnob',
] as const

describe('the stable root', () => {
  it('exports every runtime name P3 owes it', () => {
    for (const name of OWED_AT_ROOT) {
      expect(Object.hasOwn(root, name), `missing export: ${name}`).toBe(true)
    }
  })

  it('keeps the registry itself internal — a stage has no consumer for its bookkeeping', () => {
    for (const name of ['createKnobRegistry', 'resolveKnobValues', 'validateKnobValue']) {
      expect(Object.hasOwn(root, name), `leaked internal: ${name}`).toBe(false)
      expect(Object.hasOwn(unstable, name), `leaked internal: ${name}`).toBe(false)
    }
  })

  it('declares the two shared knobs the family binds', () => {
    expect(root.SHARED_KNOBS.map((d) => d.key)).toEqual(['paperColor', 'paperBack'])
  })

  it('keeps the slot-authoring utilities off the root (§14)', () => {
    for (const name of OWED_AT_UNSTABLE) {
      expect(Object.hasOwn(root, name), `slot utility on the root: ${name}`).toBe(false)
    }
  })
})

describe('the /unstable subpath', () => {
  it('exports every slot-authoring utility P3 owes it', () => {
    for (const name of OWED_AT_UNSTABLE) {
      expect(Object.hasOwn(unstable, name), `missing export: ${name}`).toBe(true)
    }
  })

  it('produces a usable colour conversion for a vec3 uniform', () => {
    expect(unstable.hexToRgb('#ffffff')).toEqual([1, 1, 1])
  })
})

describe('the names P2 already exported', () => {
  it('does not re-export KnobDescriptor, Knobs, SheetKnobs or MotionKnobs a second time', () => {
    // They stay on P2's `from './forward.js'` line, which now redirects to this plan's modules.
    // A duplicate export is a compile error; this test states the intent so a reader does not
    // "fix" the omission.
    expect(Object.hasOwn(root, 'KnobDescriptor')).toBe(false)
  })
})
