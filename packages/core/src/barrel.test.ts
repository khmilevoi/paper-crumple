import { describe, expect, it } from 'vitest'
import * as root from './index.js'
import * as unstable from './unstable.js'

/**
 * A subset check and never an exact-set check: `index.ts` is an append-only surface at sync 2
 * and P3, P4 and P5 all append to it. Asserting the exact set would turn every neighbour's
 * append into a P2 failure.
 */
const OWED_AT_ROOT = [
  'CrumpleError',
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
  'ABORTED',
  'isAborted',
  'findCause',
  'attempt',
  'partition',
  'matchError',
  'unwrap',
  'unwrapAsync',
  'assertSingleCore',
  'VERSION',
] as const

describe('the stable root', () => {
  it('exports every runtime name P2 owes it', () => {
    for (const name of OWED_AT_ROOT) {
      expect(Object.hasOwn(root, name), `missing export: ${name}`).toBe(true)
    }
  })

  it('keeps the slot-authoring factory out of it (§14)', () => {
    expect(Object.hasOwn(root, 'taggedError')).toBe(false)
  })

  it('does not leak the testable internals of the duplicate-core marker', () => {
    for (const name of ['registerCore', 'checkSingleCore', 'CORE_MARKER_KEY']) {
      expect(Object.hasOwn(root, name), `leaked internal: ${name}`).toBe(false)
    }
  })
})

describe('the /unstable subpath', () => {
  it('exports taggedError, which is the one runtime value it carries from P2', () => {
    expect(typeof unstable.taggedError).toBe('function')
  })

  it('produces a working class', () => {
    const MyError = unstable.taggedError('MyError', 'ERR_MY')
    const e = new MyError('third-party slot failure')
    expect(MyError.is(e)).toBe(true)
    expect(root.CrumpleError.is(e)).toBe(true)
    expect(e).toBeInstanceOf(Error)
  })
})
