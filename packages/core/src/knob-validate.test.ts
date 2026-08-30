import { describe, expect, it } from 'vitest'
import { KnobError } from './errors.js'
import { enumKnob } from './knobs.js'
import { validateKnobValue } from './knob-validate.js'

const number = {
  key: 'grain',
  kind: 'number',
  invalidates: 'front',
  default: 0.09,
  min: 0,
  max: 0.5,
} as const
const int = {
  key: 'sdfRes',
  kind: 'int',
  invalidates: 'field',
  default: 192,
  min: 64,
  max: 512,
} as const
const bool = { key: 'shadow', kind: 'bool', invalidates: 'draw', default: true } as const
const color = {
  key: 'paperColor',
  kind: 'color',
  invalidates: 'front',
  default: '#f7f4ed',
} as const
const choice = enumKnob({
  key: 'debug',
  invalidates: 'draw',
  values: ['off', 'normals'],
  default: 'off',
})

const rejects = (d: Parameters<typeof validateKnobValue>[0], v: unknown): string => {
  const err = validateKnobValue(d, v)
  expect(KnobError.is(err), `accepted ${JSON.stringify(v) ?? String(v)}`).toBe(true)
  return (err as Error).message
}

describe('number knobs', () => {
  it('accepts a finite number inside the declared range', () => {
    expect(validateKnobValue(number, 0)).toBeUndefined()
    expect(validateKnobValue(number, 0.5)).toBeUndefined()
    expect(validateKnobValue(number, 0.09)).toBeUndefined()
  })

  it('rejects out of range, which is the KnobError amendment 18 leaves untouched', () => {
    expect(rejects(number, 0.6)).toContain('out of range')
    expect(rejects(number, -0.01)).toContain('out of range')
  })

  it('rejects a non-number and a non-finite one', () => {
    expect(rejects(number, '0.2')).toContain('finite number')
    expect(rejects(number, Number.NaN)).toContain('finite number')
    expect(rejects(number, Number.POSITIVE_INFINITY)).toContain('finite number')
  })
})

describe('int knobs', () => {
  it('accepts an integer in range and rejects a fraction', () => {
    expect(validateKnobValue(int, 192)).toBeUndefined()
    expect(rejects(int, 192.5)).toContain('integer')
    expect(rejects(int, 8)).toContain('out of range')
  })
})

describe('bool knobs', () => {
  it('takes a boolean and nothing that merely looks like one', () => {
    expect(validateKnobValue(bool, false)).toBeUndefined()
    expect(rejects(bool, 0)).toContain('boolean')
    expect(rejects(bool, 'true')).toContain('boolean')
  })
})

describe('color knobs', () => {
  it('takes a hex colour, which is the check §6.1 opens with', () => {
    expect(validateKnobValue(color, '#f7f4ed')).toBeUndefined()
    expect(validateKnobValue(color, '#fff')).toBeUndefined()
    expect(rejects(color, 'not a colour')).toContain('hex colour')
    expect(rejects(color, 0xf7f4ed)).toContain('hex colour')
  })
})

describe('enum knobs', () => {
  it('takes a declared member and names the alternatives when it does not', () => {
    expect(validateKnobValue(choice, 'normals')).toBeUndefined()
    const message = rejects(choice, 'normal')
    expect(message).toContain("'off'")
    expect(message).toContain("'normals'")
  })
})

describe('the message', () => {
  it('always names the knob, because a panel shows it beside the field', () => {
    expect(rejects(number, 9)).toContain("'grain'")
  })

  it('never calls String() on a symbol', () => {
    expect(rejects(bool, Symbol('nope'))).toContain('boolean')
  })
})
