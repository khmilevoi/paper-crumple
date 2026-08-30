import { describe, expect, it } from 'vitest'
import {
  AbortedError,
  AssetError,
  CoreDuplicateError,
  CrumpleError,
  GlError,
  KnobError,
  MotionError,
  PackError,
  PoseError,
  SheetError,
  SourceExpiredError,
  ViewError,
  taggedError,
} from './errors.js'

const ALL = [
  GlError,
  PackError,
  SheetError,
  KnobError,
  AssetError,
  AbortedError,
  MotionError,
  PoseError,
  SourceExpiredError,
  ViewError,
  CoreDuplicateError,
] as const

describe('the eleven classes (§10.1)', () => {
  it('each carries its own _tag, its own code and its own name', () => {
    const tags = ALL.map((C) => C.tag)
    expect(tags).toEqual([
      'GlError',
      'PackError',
      'SheetError',
      'KnobError',
      'AssetError',
      'AbortedError',
      'MotionError',
      'PoseError',
      'SourceExpiredError',
      'ViewError',
      'CoreDuplicateError',
    ])
    expect(new Set(ALL.map((C) => C.code)).size).toBe(ALL.length)
    const e = new GlError('no context')
    expect(e._tag).toBe('GlError')
    expect(e.code).toBe('ERR_GL')
    expect(e.name).toBe('GlError')
    expect(e.message).toBe('no context')
  })

  it('is a real Error, so instanceof Error narrows it (§10)', () => {
    expect(new SheetError('degenerate rect')).toBeInstanceOf(Error)
    expect(new SheetError('degenerate rect')).toBeInstanceOf(CrumpleError)
  })

  it('reports [object <Tag>] through Symbol.toStringTag (§10.3)', () => {
    expect(Object.prototype.toString.call(new PoseError('out of range'))).toBe('[object PoseError]')
  })
})

describe('construction', () => {
  it('takes a message', () => {
    expect(new PackError('bad manifest').message).toBe('bad manifest')
  })

  it('takes an object, which is the form §10.8 writes', () => {
    const cause = new Error('fetch failed')
    const e = new AssetError({ message: 'tile 2x3 did not load', cause })
    expect(e.message).toBe('tile 2x3 did not load')
    expect(e.cause).toBe(cause)
  })

  it('takes a message plus a cause', () => {
    const cause = new Error('underlying')
    expect(new ViewError('element already has a view', { cause }).cause).toBe(cause)
  })

  it('carries typed properties on the one class that declares them', () => {
    const e = new CoreDuplicateError('two copies of core', { version: '1.2.0', existing: '1.1.0' })
    expect(e.version).toBe('1.2.0')
    expect(e.existing).toBe('1.1.0')
    expect(e.message).toBe('two copies of core')
  })

  it('never lets a property overwrite message or cause', () => {
    const e = new CoreDuplicateError({
      message: 'kept',
      version: '1.0.0',
      existing: '1.0.0',
    })
    expect(e.message).toBe('kept')
  })

  it('never lets an init key spoof the class identity (§10.4)', () => {
    const diagnostics: Record<string, unknown> = {
      message: 'boom',
      _tag: 'SheetError',
      code: 'ERR_SPOOF',
      name: 'Spoofed',
      stack: 'not a stack',
    }
    const e = new GlError(diagnostics as unknown as { message: string })
    expect(GlError.is(e)).toBe(true)
    expect(SheetError.is(e)).toBe(false)
    expect(e).toBeInstanceOf(GlError)
    expect(e._tag).toBe('GlError')
    expect(e.code).toBe('ERR_GL')
    expect(e.name).toBe('GlError')
    expect(e.message).toBe('boom')
  })
})

describe('Err.is(), which is canonical at package seams (§10.4)', () => {
  it('answers true for an instance of its own class', () => {
    expect(GlError.is(new GlError('x'))).toBe(true)
  })

  it('answers false for a sibling class', () => {
    expect(GlError.is(new SheetError('x'))).toBe(false)
  })

  it('answers true across a simulated second copy of core, where instanceof fails', () => {
    const OtherCopy = taggedError('GlError', 'ERR_GL')
    const fromOtherCopy = new OtherCopy('a GlError from another copy')
    expect(fromOtherCopy instanceof GlError).toBe(false)
    expect(GlError.is(fromOtherCopy)).toBe(true)
    expect(CrumpleError.is(fromOtherCopy)).toBe(true)
  })

  it('answers false for a foreign error and for a plain object wearing a _tag', () => {
    expect(CrumpleError.is(new Error('foreign'))).toBe(false)
    expect(CrumpleError.is({ _tag: 'GlError' })).toBe(false)
    expect(CrumpleError.is(null)).toBe(false)
    expect(CrumpleError.is(undefined)).toBe(false)
  })
})
