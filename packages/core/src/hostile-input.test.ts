import { describe, expect, it } from 'vitest'
import {
  ABORTED,
  AbortedError,
  CrumpleError,
  GlError,
  PackError,
  assertSingleCore,
  attempt,
  findCause,
  isAborted,
  matchError,
  partition,
  unwrap,
} from './index.js'
import { taggedError } from './unstable.js'

/** Values chosen to break a helper that assumes it was handed an object it recognises. */
const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  -0,
  Number.NaN,
  '',
  'ABORTED',
  Symbol('paper-crumple.aborted'),
  Symbol.for('paper-crumple.core'),
  true,
  [],
  {},
  Object.create(null),
  new Error('a foreign error'),
  { _tag: 'GlError', code: 'ERR_GL' },
  { cause: { cause: { cause: 'nothing' } } },
  new Proxy({}, { get: () => undefined }),
]

describe('§10.8: every surface returns rather than throws', () => {
  it('isAborted answers a boolean for every hostile value', () => {
    for (const value of HOSTILE) {
      expect(() => isAborted(value)).not.toThrow()
      expect(typeof isAborted(value)).toBe('boolean')
    }
  })

  it('findCause answers undefined-or-a-match for every hostile value', () => {
    for (const value of HOSTILE) {
      expect(() => findCause(value, GlError)).not.toThrow()
      expect(findCause(value, GlError)).toBeUndefined()
    }
  })

  it('CrumpleError.is answers a boolean for every hostile value', () => {
    for (const value of HOSTILE) {
      expect(typeof CrumpleError.is(value)).toBe('boolean')
    }
    expect(CrumpleError.is({ _tag: 'GlError', code: 'ERR_GL' })).toBe(false)
  })

  it('matchError always produces a value, never an escape', () => {
    for (const value of HOSTILE) {
      const r = matchError(value as Error, { else: () => 'fell through' })
      expect(r).toBe('fell through')
    }
  })

  it('partition never throws and never loses an element', () => {
    const [ok, bad] = partition<unknown>(HOSTILE)
    expect(ok.length + bad.length).toBe(HOSTILE.length)
    expect(bad).toHaveLength(1)
  })

  it('attempt converts every escape into a returned Error', () => {
    const frozen = Object.freeze({ a: 1 })
    const r = attempt(() => Object.defineProperty(frozen, 'a', { value: 2 }))
    expect(r).toBeInstanceOf(Error)
    expect(
      attempt(
        () => 1,
        () => new GlError('never used'),
      ),
    ).toBe(1)
  })

  it('wraps a non-Error escape in an Error, which is the branch a foreign throw lands in', () => {
    function* suspended(): Generator<number, void, void> {
      yield 1
    }
    const gen = suspended()
    gen.next()
    const r = attempt(() => gen.throw('a slot author threw a string'))
    expect(r).toBeInstanceOf(Error)
    expect((r as Error).message).toBe('a slot author threw a string')
    expect((r as Error).cause).toBe('a slot author threw a string')
  })

  it('assertSingleCore returns rather than throwing, whatever the realm holds', () => {
    expect(() => assertSingleCore()).not.toThrow()
  })

  it('a cause chain far longer than the walk terminates', () => {
    let deep: Error = new PackError('bottom')
    for (let i = 0; i < 5_000; i += 1) {
      deep = new PackError({ message: `link ${String(i)}`, cause: deep })
    }
    expect(() => isAborted(deep)).not.toThrow()
    expect(isAborted(deep)).toBe(false)
    expect(findCause(deep, GlError)).toBeUndefined()
  })

  it('an error constructed with a hostile init is still an Error with a string message', () => {
    for (const value of HOSTILE) {
      const e = new GlError({ message: 'held', cause: value })
      expect(e).toBeInstanceOf(Error)
      expect(e.message).toBe('held')
      expect(typeof e.name).toBe('string')
    }
  })
})

describe('§10.8: unwrap is the one exception, and it is a conversion', () => {
  it('throws the error it was handed and nothing else', () => {
    const e = new GlError('boom')
    expect(() => unwrap(e as number | typeof e)).toThrow(e)
  })

  it('throws an AbortedError, never the bare symbol', () => {
    let thrown: unknown
    try {
      unwrap(ABORTED as number | typeof ABORTED)
    } catch (caught) {
      thrown = caught
    }
    expect(AbortedError.is(thrown)).toBe(true)
    expect(typeof thrown).toBe('object')
  })
})

describe('§10.4: Err.is() is canonical at package seams', () => {
  it('a second copy’s error answers .is() and fails instanceof', () => {
    const Copy = taggedError('PackError', 'ERR_PACK')
    const foreign = new Copy('from the other copy')
    expect(foreign instanceof PackError).toBe(false)
    expect(PackError.is(foreign)).toBe(true)
    expect(findCause(new GlError({ message: 'wraps it', cause: foreign }), PackError)).toBe(foreign)
  })
})
