import { describe, expect, it } from 'vitest'
import { findCause } from './cause.js'
import { AssetError, GlError, PackError, SheetError } from './errors.js'

describe('findCause (§10)', () => {
  it('finds the value itself', () => {
    const e = new GlError('no context')
    expect(findCause(e, GlError)).toBe(e)
  })

  it('reaches a GlError underneath a PackError, which is the documented motive', () => {
    const gl = new GlError('texStorage2D failed')
    const pack = new PackError({ message: 'pack 2x3 could not be uploaded', cause: gl })
    expect(findCause(pack, GlError)).toBe(gl)
  })

  it('walks more than one link', () => {
    const gl = new GlError('deep')
    const mid = new AssetError({ message: 'mid', cause: gl })
    const top = new SheetError({ message: 'top', cause: mid })
    expect(findCause(top, GlError)).toBe(gl)
  })

  it('returns undefined when nothing in the chain matches', () => {
    expect(findCause(new PackError('flat'), GlError)).toBeUndefined()
  })

  it('survives hostile input', () => {
    expect(findCause(null, GlError)).toBeUndefined()
    expect(findCause(undefined, GlError)).toBeUndefined()
    expect(findCause('a string', GlError)).toBeUndefined()
    expect(findCause(Object.create(null), GlError)).toBeUndefined()
  })

  it('terminates on a cyclic cause chain', () => {
    const a = new PackError('a')
    const b = new PackError({ message: 'b', cause: a })
    Object.defineProperty(a, 'cause', { value: b, configurable: true })
    expect(findCause(b, GlError)).toBeUndefined()
  })
})
