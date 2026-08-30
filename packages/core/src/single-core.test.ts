import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CoreDuplicateError } from './errors.js'
import {
  CORE_MARKER_KEY,
  assertSingleCore,
  checkSingleCore,
  registerCore,
  type CoreRegistry,
} from './single-core.js'
import { VERSION } from './version.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the version marker (§10.4)', () => {
  it('keys off the shared registry, the same one ABORTED uses', () => {
    expect(CORE_MARKER_KEY).toBe(Symbol.for('paper-crumple.core'))
  })

  it('tracks the published manifest, so the marker never lies about the copy', () => {
    const manifest: { version: string } = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    expect(VERSION).toBe(manifest.version)
  })

  it('registers itself on load, so a second copy can see it', () => {
    expect((globalThis as CoreRegistry)[CORE_MARKER_KEY]).toBeDefined()
  })
})

describe('registerCore', () => {
  it('claims an empty scope and reports nothing found', () => {
    const scope: CoreRegistry = {}
    const own = { version: '1.0.0' }
    expect(registerCore(scope, own)).toBeUndefined()
    expect(scope[CORE_MARKER_KEY]).toBe(own)
  })

  it('leaves an occupied scope alone and reports what was there', () => {
    const first = { version: '1.0.0' }
    const scope: CoreRegistry = { [CORE_MARKER_KEY]: first }
    const second = { version: '1.1.0' }
    expect(registerCore(scope, second)).toBe(first)
    expect(scope[CORE_MARKER_KEY]).toBe(first)
  })
})

describe('assertSingleCore (amendment 7)', () => {
  it('returns undefined for the copy that won the registration', () => {
    const own = { version: '1.0.0' }
    const scope: CoreRegistry = {}
    registerCore(scope, own)
    expect(checkSingleCore(scope, own)).toBeUndefined()
  })

  it('returns a CoreDuplicateError for a copy that lost it, at the same version', () => {
    const first = { version: '1.0.0' }
    const second = { version: '1.0.0' }
    const scope: CoreRegistry = {}
    registerCore(scope, first)
    registerCore(scope, second)
    const err = checkSingleCore(scope, second)
    expect(CoreDuplicateError.is(err)).toBe(true)
    expect(err?.version).toBe('1.0.0')
    expect(err?.existing).toBe('1.0.0')
  })

  it('reports both versions when they differ', () => {
    const scope: CoreRegistry = { [CORE_MARKER_KEY]: { version: '1.0.0' } }
    const own = { version: '2.0.0' }
    const err = checkSingleCore(scope, own)
    expect(err?.version).toBe('2.0.0')
    expect(err?.existing).toBe('1.0.0')
  })

  it('returns the error rather than throwing it, so the application decides', () => {
    expect(assertSingleCore()).toBeUndefined()
  })
})
