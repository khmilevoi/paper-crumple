import { describe, expect, it } from 'vitest'
import { ABORTED } from './abort.js'
import { AbortedError, GlError } from './errors.js'
import { unwrap, unwrapAsync } from './unwrap.js'

describe('unwrap (§10.7, amendment 3)', () => {
  it('returns a success value untouched', () => {
    expect(unwrap(42 as number | Error)).toBe(42)
    expect(unwrap(null as null | Error)).toBe(null)
    expect(unwrap(undefined as undefined | Error)).toBe(undefined)
  })

  it('throws the error it was given, identity preserved', () => {
    const e = new GlError('no context')
    expect(() => unwrap(e as number | typeof e)).toThrow(e)
  })

  it('throws an AbortedError on the sentinel, never the symbol itself', () => {
    expect(() => unwrap(ABORTED as number | typeof ABORTED)).toThrow(Error)
    try {
      unwrap(ABORTED as number | typeof ABORTED)
    } catch (thrown) {
      expect(AbortedError.is(thrown)).toBe(true)
      expect((thrown as InstanceType<typeof AbortedError>).cause).toBe(ABORTED)
    }
  })

  it('does not convert an abort-caused error into an AbortedError', () => {
    const wrapped = new GlError({ message: 'wrapped', cause: ABORTED })
    expect(() => unwrap(wrapped as number | typeof wrapped)).toThrow(wrapped)
  })
})

describe('unwrapAsync', () => {
  it('resolves a success value', async () => {
    await expect(unwrapAsync(Promise.resolve(7 as number | Error))).resolves.toBe(7)
  })

  it('rejects with the returned error, since a failing promise resolves to it', async () => {
    const e = new GlError('boom')
    await expect(unwrapAsync(Promise.resolve(e as number | typeof e))).rejects.toBe(e)
  })

  it('rejects with an AbortedError on the sentinel', async () => {
    await expect(
      unwrapAsync(Promise.resolve(ABORTED as number | typeof ABORTED)),
    ).rejects.toSatisfy((thrown: unknown) => AbortedError.is(thrown))
  })

  it('passes a genuine rejection through unchanged', async () => {
    const boom = new TypeError('rejected, not resolved')
    await expect(unwrapAsync(Promise.reject(boom) as PromiseLike<number>)).rejects.toBe(boom)
  })
})
