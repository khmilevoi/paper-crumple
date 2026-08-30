import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as T

/** Only the fields this file asserts on. `no-explicit-any` is on; nothing here is `any`. */
interface Manifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  main?: string
  module?: string
  sideEffects?: boolean
  homepage?: string
  files?: string[]
  engines?: Record<string, string>
  exports?: Record<string, Record<string, string>>
  scripts?: Record<string, string>
  publishConfig?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

const HOMEPAGE = 'https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme'

const SUBPATHS: Record<string, string[]> = {
  core: ['.', './unstable'],
  paper: ['.', './tiles'],
  motion: ['.', './packs/2x3', './packs/1x1', './packs/3x2'],
}

const PUBLISHED = ['core', 'paper', 'motion'] as const
const manifests = new Map<string, Manifest>(
  PUBLISHED.map((dir) => [dir, readJson<Manifest>(`packages/${dir}/package.json`)]),
)

describe.each(PUBLISHED)('@paper-crumple/%s', (dir) => {
  const manifest = manifests.get(dir)!

  it('is named for its directory and is not private', () => {
    expect(manifest.name).toBe(`@paper-crumple/${dir}`)
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig).toEqual({ access: 'public' })
  })

  it('declares an explicit empty dependencies object, not an absent key', () => {
    expect(Object.prototype.hasOwnProperty.call(manifest, 'dependencies')).toBe(true)
    expect(manifest.dependencies).toEqual({})
  })

  it('ships only dist', () => {
    expect(manifest.files).toEqual(['dist'])
  })

  it('is ESM only, with no CJS entry points anywhere', () => {
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBeUndefined()
    expect(manifest.module).toBeUndefined()
    const targets = JSON.stringify(manifest.exports)
    expect(targets).not.toMatch(/\.cjs/)
    expect(targets).not.toMatch(/require/)
  })

  it('declares only the Node floor consumers must meet, and never engines.pnpm', () => {
    expect(manifest.engines).toEqual({ node: '>=22' })
  })

  it('enumerates its export subpaths explicitly, in order, and never globs one', () => {
    const exports = manifest.exports ?? {}
    expect(Object.keys(exports)).toEqual(SUBPATHS[dir])
    for (const [key, entry] of Object.entries(exports)) {
      expect(key).not.toContain('*')
      expect(Object.keys(entry)).toEqual(['types', 'default'])
      expect(entry.types).toMatch(/^\.\/dist\/[\w/-]+\.d\.ts$/)
      expect(entry.default).toMatch(/^\.\/dist\/[\w/-]+\.js$/)
    }
  })

  it('requires TypeScript 5.0 or newer of a TypeScript consumer', () => {
    expect(manifest.peerDependencies?.typescript).toBe('>=5.0')
    expect(manifest.peerDependenciesMeta?.typescript).toEqual({ optional: true })
  })

  it('starts at 0.0.0 so the one release changeset lands the family on 1.0.0', () => {
    expect(manifest.version).toBe('0.0.0')
  })

  it('points at the one shared docs URL', () => {
    expect(manifest.homepage).toBe(HOMEPAGE)
  })

  it('promises no module-level side effects', () => {
    expect(manifest.sideEffects).toBe(false)
  })
})

describe('the core duplication hazard (§10.4)', () => {
  it('makes core a peer of both slots, with a devDependency for workspace resolution', () => {
    for (const slot of ['paper', 'motion'] as const) {
      const manifest = manifests.get(slot)!
      expect(manifest.peerDependencies?.['@paper-crumple/core']).toBe('workspace:^')
      expect(manifest.devDependencies?.['@paper-crumple/core']).toBe('workspace:*')
      expect(manifest.dependencies?.['@paper-crumple/core']).toBeUndefined()
    }
  })

  it('does not make core depend on itself', () => {
    const core = manifests.get('core')!
    expect(core.peerDependencies?.['@paper-crumple/core']).toBeUndefined()
    expect(core.devDependencies?.['@paper-crumple/core']).toBeUndefined()
  })
})

describe('engines.pnpm', () => {
  it('appears in no manifest at all, because pnpm checks it against consumers too', () => {
    const all: Manifest[] = [
      readJson<Manifest>('package.json'),
      readJson<Manifest>('packages/tsconfig/package.json'),
      ...PUBLISHED.map((dir) => manifests.get(dir)!),
    ]
    for (const manifest of all) {
      expect(manifest.engines?.pnpm).toBeUndefined()
    }
  })
})
