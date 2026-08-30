import { describe, expect, it } from 'vitest'
import { KNOB_REFERENCE_PX, enumKnob, knobs, pxScale, scaleKnob } from './knobs.js'
import type { KnobDescriptor } from './knobs.js'

describe('knobs()', () => {
  it('returns the tuple it was handed, identically', () => {
    const input = [
      { key: 'ambient', kind: 'number', invalidates: 'draw', default: 0.35, min: 0, max: 1 },
    ] as const
    expect(knobs(input)).toBe(input)
  })
})

describe('enumKnob()', () => {
  it('adds kind: enum and keeps every other field', () => {
    const d = enumKnob({
      key: 'debug',
      invalidates: 'draw',
      values: ['off', 'normals', 'depth'],
      default: 'off',
      dev: true,
    })
    expect(d).toEqual({
      key: 'debug',
      kind: 'enum',
      invalidates: 'draw',
      values: ['off', 'normals', 'depth'],
      default: 'off',
      dev: true,
    })
  })

  it('produces something the union accepts', () => {
    const d: KnobDescriptor = enumKnob({
      key: 'debug',
      invalidates: 'draw',
      values: ['off', 'normals'],
      default: 'off',
    })
    expect(d.kind).toBe('enum')
  })
})

describe('the sprite-px reference (§6.4)', () => {
  it('quotes px-valued knobs against a 1000 px-tall sprite', () => {
    expect(KNOB_REFERENCE_PX).toBe(1000)
    expect(pxScale(384)).toBeCloseTo(0.384, 10)
  })

  it('rescales only the knobs that declare the reference', () => {
    const tearAmp = {
      key: 'tearAmp',
      kind: 'number',
      invalidates: 'front',
      default: 30,
      min: 0,
      max: 80,
      reference: 'sprite-px',
    } as const
    const ambient = {
      key: 'ambient',
      kind: 'number',
      invalidates: 'draw',
      default: 0.35,
      min: 0,
      max: 1,
    } as const
    // 30 quoted px on a 384 px sprite is 11.52 real px. Reading it as 30 target px is the
    // "roughly 2.4x too coarse" failure §6.4 names.
    expect(scaleKnob(tearAmp, 30, 384)).toBeCloseTo(11.52, 10)
    expect(scaleKnob(ambient, 0.35, 384)).toBe(0.35)
  })

  it('leaves a non-numeric kind alone even if something asks it to scale', () => {
    const shadow = { key: 'shadow', kind: 'bool', invalidates: 'draw', default: true } as const
    expect(scaleKnob(shadow, 7, 384)).toBe(7)
  })
})
