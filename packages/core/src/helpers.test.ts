import { describe, expect, it } from 'vitest'
import { attempt } from './attempt.js'
import { GlError, PackError, SheetError } from './errors.js'
import { matchError } from './match.js'

const boom = (): never => JSON.parse('{ not json') as never

describe('attempt, the synchronous boundary (§10.8)', () => {
  it('returns the value when nothing goes wrong', () => {
    expect(attempt(() => 41 + 1)).toBe(42)
  })

  it('returns the thrown Error rather than letting it escape', () => {
    const r = attempt(boom)
    expect(r).toBeInstanceOf(SyntaxError)
  })

  it('wraps a thrown value in the class the boundary chose', () => {
    const r = attempt(boom, (cause) => new PackError({ message: 'manifest is not JSON', cause }))
    expect(PackError.is(r)).toBe(true)
    expect((r as InstanceType<typeof PackError>).cause).toBeInstanceOf(SyntaxError)
  })

  it('returns a platform TypeError as a value, so the return union stays honest', () => {
    const r = attempt(() => Object.defineProperty(Object.freeze({}), 'a', { value: 1 }))
    expect(r).toBeInstanceOf(TypeError)
  })

  it('wraps a platform throw in the class the boundary chose', () => {
    const r = attempt(
      () => new Float32Array(new ArrayBuffer(4), 1, 1),
      (cause) => new GlError({ message: 'bad buffer view', cause }),
    )
    expect(GlError.is(r)).toBe(true)
  })

  it('never lets a non-Error escape as a non-Error', () => {
    const r = attempt(() => Reflect.get(null as unknown as object, 'x'))
    expect(r).toBeInstanceOf(TypeError)
  })
})

describe('matchError, with its mandatory else (§10.7, amendment 4)', () => {
  it('routes by _tag', () => {
    const r = matchError(new GlError('no context'), {
      GlError: () => 'gl',
      SheetError: () => 'sheet',
      else: () => 'other',
    })
    expect(r).toBe('gl')
  })

  it('falls to else for a tag it was not given', () => {
    const r = matchError(new SheetError('degenerate'), {
      GlError: () => 'gl',
      else: () => 'other',
    })
    expect(r).toBe('other')
  })

  it('falls to else for a foreign error with no _tag at all', () => {
    expect(matchError(new Error('foreign'), { else: () => 'other' })).toBe('other')
  })

  it('never reaches through the prototype chain for a handler', () => {
    const hostile = new GlError('x')
    Object.defineProperty(hostile, '_tag', { value: 'toString', configurable: true })
    expect(matchError(hostile, { else: () => 'other' })).toBe('other')
  })

  it('ignores a non-string _tag', () => {
    const hostile = new PackError('x')
    Object.defineProperty(hostile, '_tag', { value: 42, configurable: true })
    expect(matchError(hostile, { else: () => 'other' })).toBe('other')
  })

  it('does not treat else as a tag', () => {
    const hostile = new GlError('x')
    Object.defineProperty(hostile, '_tag', { value: 'else', configurable: true })
    expect(matchError(hostile, { else: () => 'other' })).toBe('other')
  })
})
