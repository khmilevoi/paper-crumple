import { describe, expect, it } from 'vitest'
import { ABORTED, isAborted } from './abort.js'
import { AbortedError, GlError, PackError } from './errors.js'

describe('ABORTED (§10.5, amendment 1)', () => {
  it('lives in the shared symbol registry, so two copies of core agree on it', () => {
    expect(ABORTED).toBe(Symbol.for('paper-crumple.aborted'))
    expect(Symbol.keyFor(ABORTED)).toBe('paper-crumple.aborted')
  })

  it('is not an Error, so instanceof Error does not catch a scroll', () => {
    expect((ABORTED as unknown) instanceof Error).toBe(false)
  })
})

describe('isAborted, over exactly the four normative shapes (§10.5)', () => {
  it('1 — the sentinel itself', () => {
    expect(isAborted(ABORTED)).toBe(true)
  })

  it('2 — an AbortedError instance', () => {
    expect(isAborted(new AbortedError('cancelled'))).toBe(true)
  })

  it('3a — an AbortedError anywhere in the cause chain', () => {
    const inner = new AbortedError('cancelled')
    const mid = new GlError({ message: 'mid', cause: inner })
    expect(isAborted(new PackError({ message: 'top', cause: mid }))).toBe(true)
  })

  it('3b — a DOMException named AbortError anywhere in the cause chain', () => {
    const dom = new DOMException('The operation was aborted.', 'AbortError')
    expect(isAborted(dom)).toBe(true)
    expect(isAborted(new PackError({ message: 'top', cause: dom }))).toBe(true)
  })

  it('4 — cause: ABORTED, legal since ES2022 and cheap to miss', () => {
    expect(isAborted(new GlError({ message: 'wrapped', cause: ABORTED }))).toBe(true)
  })

  it('says no to an ordinary error, a plain value and a null prototype', () => {
    expect(isAborted(new GlError('real failure'))).toBe(false)
    expect(isAborted(undefined)).toBe(false)
    expect(isAborted(null)).toBe(false)
    expect(isAborted(Symbol('paper-crumple.aborted'))).toBe(false)
    expect(isAborted(Object.create(null))).toBe(false)
  })

  it('terminates on a cyclic cause chain rather than recursing forever', () => {
    const a = new GlError('a')
    const b = new GlError({ message: 'b', cause: a })
    Object.defineProperty(a, 'cause', { value: b, configurable: true })
    expect(isAborted(b)).toBe(false)
  })
})
