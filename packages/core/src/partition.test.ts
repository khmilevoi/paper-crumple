import { describe, expect, it } from 'vitest'
import { GlError, SheetError } from './errors.js'
import { partition } from './partition.js'

describe('partition (§10.7)', () => {
  it('splits values from errors, in input order', () => {
    const gl = new GlError('a')
    const sheet = new SheetError('b')
    const [ok, bad] = partition<number | Error>([1, gl, 2, sheet, 3])
    expect(ok).toEqual([1, 2, 3])
    expect(bad).toEqual([gl, sheet])
  })

  it('returns two empty arrays for an empty batch', () => {
    const [ok, bad] = partition<number | Error>([])
    expect(ok).toEqual([])
    expect(bad).toEqual([])
  })

  it('treats every Error subclass as an error, ours and the platform�s', () => {
    const [ok, bad] = partition<unknown>([new TypeError('t'), new GlError('g'), 'not an error'])
    expect(ok).toEqual(['not an error'])
    expect(bad).toHaveLength(2)
  })

  it('does not mutate or require a mutable input', () => {
    const input = Object.freeze([1, new GlError('a')]) as readonly (number | Error)[]
    const [ok, bad] = partition(input)
    expect(input).toHaveLength(2)
    expect(ok).toEqual([1])
    expect(bad).toHaveLength(1)
  })
})
