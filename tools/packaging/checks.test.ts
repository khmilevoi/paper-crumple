import { describe, expect, it } from 'vitest'
import {
  PACKAGES,
  checkEntries,
  checkPackUrls,
  checkPackedManifest,
  checkTiles,
} from './checks.mjs'

const core = PACKAGES.find((p) => p.dir === 'core')!
const paper = PACKAGES.find((p) => p.dir === 'paper')!

const coreNames = [
  'package/package.json',
  'package/LICENSE',
  'package/README.md',
  'package/dist/index.js',
  'package/dist/index.js.map',
  'package/dist/index.d.ts',
  'package/dist/unstable.js',
  'package/dist/unstable.js.map',
  'package/dist/unstable.d.ts',
  'package/dist/bindings.js',
  'package/dist/bindings.js.map',
  'package/dist/bindings.d.ts',
]

describe('checkEntries', () => {
  it('checks the Reatom package entry and rejects missing declarations', () => {
    const reatom = PACKAGES.find((p) => p.dir === 'reatom')!
    expect(reatom).toBeDefined()
    const names = [
      'package/package.json',
      'package/LICENSE',
      'package/README.md',
      'package/dist/index.js',
      'package/dist/index.d.ts',
    ]
    expect(checkEntries(reatom, names)).toEqual([])
    expect(
      checkEntries(
        reatom,
        names.filter((name) => !name.endsWith('.d.ts')),
      ),
    ).toEqual(['@paper-crumple/reatom: missing package/dist/index.d.ts'])
  })
  it('requires the stable bindings entry in the published core tarball', () => {
    expect(
      checkEntries(
        core,
        coreNames.filter((name) => name !== 'package/dist/bindings.js'),
      ),
    ).toEqual(['@paper-crumple/core: missing package/dist/bindings.js'])
  })
  it('accepts the required set plus tsdown’s content-hashed shared chunks', () => {
    const withChunks = [
      ...coreNames,
      'package/dist/surface-grade-BTNTovWF.js',
      'package/dist/surface-grade-BTNTovWF.js.map',
      'package/dist/resolution-crzIglaP.d.ts',
    ]

    expect(checkEntries(core, withChunks)).toEqual([])
  })

  it('fails a tarball missing its README, which is the doorway spec 14 requires', () => {
    const without = coreNames.filter((n) => n !== 'package/README.md')

    expect(checkEntries(core, without)).toEqual(['@paper-crumple/core: missing package/README.md'])
  })

  it('fails anything shipped from outside dist, package.json, LICENSE and README', () => {
    expect(checkEntries(core, [...coreNames, 'package/src/index.ts'])).toEqual([
      '@paper-crumple/core: unexpected entry package/src/index.ts',
    ])
  })

  it('fails an .npmignore, which spec 14 forbids anywhere', () => {
    expect(checkEntries(core, [...coreNames, 'package/.npmignore'])).toEqual([
      '@paper-crumple/core: unexpected entry package/.npmignore',
    ])
  })
})

describe('checkPackedManifest', () => {
  const base = {
    name: '@paper-crumple/paper',
    version: '1.0.0',
    files: ['dist'],
    engines: { node: '>=22' },
    homepage: 'https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme',
    dependencies: {},
    peerDependencies: { typescript: '>=5.0', '@paper-crumple/core': '^1.0.0' },
    exports: { '.': {}, './tiles': {} },
  }

  it('accepts a caret peer on core, which is what workspace:^ expands to', () => {
    expect(checkPackedManifest(paper, base)).toEqual([])
  })

  it('fails a tilde peer on core (amendment 24)', () => {
    const tilde = {
      ...base,
      peerDependencies: { ...base.peerDependencies, '@paper-crumple/core': '~1.0.0' },
    }

    expect(checkPackedManifest(paper, tilde)).toEqual([
      '@paper-crumple/paper: peerDependencies["@paper-crumple/core"] is "~1.0.0"; expected ^1.x, a caret on the major this tarball ships — spec 14 amendment 24 requires a caret, because minors are additive',
    ])
  })

  it('fails a caret on a major the family does not ship, which a plain caret check let through', () => {
    const zero = {
      ...base,
      peerDependencies: { ...base.peerDependencies, '@paper-crumple/core': '^0.1.0' },
    }

    expect(checkPackedManifest(paper, zero)).toEqual([
      '@paper-crumple/paper: peerDependencies["@paper-crumple/core"] is "^0.1.0"; expected ^1.x, a caret on the major this tarball ships — spec 14 amendment 24 requires a caret, because minors are additive',
    ])
  })

  it('holds the peer to the packed version, so a 0.x family cannot claim ^1.x', () => {
    const zeroFamily = {
      ...base,
      version: '0.1.0',
      peerDependencies: { ...base.peerDependencies, '@paper-crumple/core': '^1.0.0' },
    }

    expect(checkPackedManifest(paper, zeroFamily)).toEqual([
      '@paper-crumple/paper: peerDependencies["@paper-crumple/core"] is "^1.0.0"; expected ^0.x, a caret on the major this tarball ships — spec 14 amendment 24 requires a caret, because minors are additive',
    ])
  })

  it('fails a packed manifest with no version to hold the peer against', () => {
    const unversioned: Record<string, unknown> = { ...base }
    delete unversioned.version

    expect(checkPackedManifest(paper, unversioned)).toEqual([
      '@paper-crumple/paper: version is undefined; expected a semver version',
    ])
  })

  it('fails a non-empty dependencies object in the packed manifest', () => {
    expect(checkPackedManifest(paper, { ...base, dependencies: { gl: '^1' } })).toEqual([
      '@paper-crumple/paper: packed dependencies is not empty: gl',
    ])
  })

  it('fails an exports map that is not exactly the enumerated subpaths', () => {
    expect(checkPackedManifest(paper, { ...base, exports: { '.': {} } })).toEqual([
      '@paper-crumple/paper: exports subpaths are ["."]; expected [".","./tiles"]',
    ])
  })

  it('fails a drifted homepage, so the three doorways cannot diverge', () => {
    expect(checkPackedManifest(paper, { ...base, homepage: 'https://example.com' })).toEqual([
      '@paper-crumple/paper: homepage is "https://example.com"; all three must point at the one docs URL',
    ])
  })

  it('requires no core peer of core itself', () => {
    const coreManifest = {
      ...base,
      name: '@paper-crumple/core',
      peerDependencies: { typescript: '>=5.0' },
      exports: { '.': {}, './unstable': {}, './bindings': {} },
    }

    expect(checkPackedManifest(core, coreManifest)).toEqual([])
  })

  it('fails core peer-depending on itself', () => {
    const coreManifest = {
      ...base,
      name: '@paper-crumple/core',
      peerDependencies: { typescript: '>=5.0', '@paper-crumple/core': '^1.0.0' },
      exports: { '.': {}, './unstable': {}, './bindings': {} },
    }

    expect(checkPackedManifest(core, coreManifest)).toEqual([
      '@paper-crumple/core: must not peer-depend on itself',
    ])
  })
})

describe('checkPackUrls', () => {
  const entry = (name: string, text: string) => ({
    name,
    size: text.length,
    data: Buffer.from(text, 'utf8'),
  })

  it('accepts the literal rolldown emits today, with double quotes', () => {
    const entries = [
      entry('package/dist/packs/2x3.js', 'binUrl: new URL("./2x3.bin", import.meta.url)'),
      entry('package/dist/packs/1x1.js', 'binUrl: new URL("./1x1.bin", import.meta.url)'),
      entry('package/dist/packs/3x2.js', 'binUrl: new URL("./3x2.bin", import.meta.url)'),
    ]

    expect(checkPackUrls(entries)).toEqual([])
  })

  it('fails the rewrite a toolchain upgrade would introduce (spec 14.1)', () => {
    const entries = [
      entry('package/dist/packs/2x3.js', 'binUrl: __toBinaryURL("./2x3.bin")'),
      entry('package/dist/packs/1x1.js', 'binUrl: new URL("./1x1.bin", import.meta.url)'),
      entry('package/dist/packs/3x2.js', 'binUrl: new URL("./3x2.bin", import.meta.url)'),
    ]

    expect(checkPackUrls(entries)).toEqual([
      'package/dist/packs/2x3.js no longer contains new URL("./2x3.bin", import.meta.url); rolldown rewrote it',
    ])
  })

  it('fails a missing pack module outright', () => {
    expect(checkPackUrls([])).toEqual([
      'package/dist/packs/2x3.js is not in the tarball',
      'package/dist/packs/1x1.js is not in the tarball',
      'package/dist/packs/3x2.js is not in the tarball',
    ])
  })
})

describe('checkTiles', () => {
  const bytes = (n: number) => Buffer.alloc(n, 7)
  const names = ['crumple-a.webp', 'crumple-g.webp', 'crumple-r.webp', 'fibre-a.webp']
  const source = new Map(names.map((n, i) => [n, bytes(100 + i)]))
  const entries = names.map((n, i) => ({
    name: `package/dist/tiles/${n}`,
    size: 100 + i,
    data: bytes(100 + i),
  }))

  it('accepts tiles that are byte-identical to the committed source and inside the budget', () => {
    expect(checkTiles(entries, source)).toEqual([])
  })

  it('fails a tile whose bytes drifted from the committed source', () => {
    const drifted = [
      ...entries.slice(1),
      { name: 'package/dist/tiles/crumple-a.webp', size: 100, data: bytes(99) },
    ]

    expect(checkTiles(drifted, source)).toEqual([
      'package/dist/tiles/crumple-a.webp differs from packages/paper/src/tiles/crumple-a.webp',
    ])
  })

  it('fails a tarball whose tiles exceed the 397 478 B budget', () => {
    const fat = new Map([['crumple-a.webp', bytes(400_000)]])
    const fatEntries = [
      { name: 'package/dist/tiles/crumple-a.webp', size: 400_000, data: bytes(400_000) },
    ]

    expect(checkTiles(fatEntries, fat)).toEqual([
      'the packed tiles total 400000 B, over spec 14’s 397478 B budget',
    ])
  })
})
