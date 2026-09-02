import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DOCS_URL = 'https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme'
const PACKAGES = ['core', 'paper', 'motion'] as const

const readme = (dir: string): string =>
  readFileSync(new URL(`../packages/${dir}/README.md`, import.meta.url), 'utf8')

const manifest = (dir: string): { homepage?: string } =>
  JSON.parse(readFileSync(new URL(`../packages/${dir}/package.json`, import.meta.url), 'utf8'))

const OPEN = '<!-- shared:install-and-import -->'
const CLOSE = '<!-- /shared:install-and-import -->'

function sharedBlock(dir: string): string {
  const text = readme(dir)
  const start = text.indexOf(OPEN)
  const end = text.indexOf(CLOSE)
  expect(start, `${dir} has no ${OPEN}`).toBeGreaterThanOrEqual(0)
  expect(end, `${dir} has no ${CLOSE}`).toBeGreaterThan(start)
  return text.slice(start + OPEN.length, end)
}

describe('the three READMEs', () => {
  it('each carry the shared install-and-import block, byte-identical', () => {
    const [core, paper, motion] = PACKAGES.map(sharedBlock)
    expect(paper).toBe(core)
    expect(motion).toBe(core)
  })

  it('name every one of the five specifiers hello-world irreducibly needs', () => {
    const block = sharedBlock('core')
    for (const specifier of [
      "from '@paper-crumple/core'",
      "from '@paper-crumple/paper'",
      "from '@paper-crumple/paper/tiles'",
      "from '@paper-crumple/motion'",
      "from '@paper-crumple/motion/packs/2x3'",
    ]) {
      expect(block).toContain(specifier)
    }
  })

  it('import only specifiers the export maps actually declare', () => {
    const declared = new Set<string>()
    for (const dir of PACKAGES) {
      const pkg = JSON.parse(
        readFileSync(new URL(`../packages/${dir}/package.json`, import.meta.url), 'utf8'),
      ) as { name: string; exports: Record<string, unknown> }
      for (const subpath of Object.keys(pkg.exports)) {
        declared.add(subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`)
      }
    }

    const imported = [...sharedBlock('core').matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
    expect(imported.length).toBeGreaterThan(0)
    for (const specifier of imported) expect(declared).toContain(specifier)
  })

  it('carry the prefers-reduced-motion branch, which discharges the obligation P14 holds', () => {
    for (const dir of PACKAGES) {
      expect(sharedBlock(dir)).toContain("matchMedia('(prefers-reduced-motion: reduce)')")
    }
  })

  it('agree with their manifest homepage on the one docs URL', () => {
    for (const dir of PACKAGES) {
      expect(manifest(dir).homepage).toBe(DOCS_URL)
      expect(readme(dir)).toContain(DOCS_URL)
    }
  })

  it('open with the package they document', () => {
    for (const dir of PACKAGES) {
      expect(readme(dir).split('\n')[0]).toBe(`# @paper-crumple/${dir}`)
    }
  })

  it('tell a slot package’s reader that core is a peer and points at core for the rest', () => {
    for (const dir of ['paper', 'motion'] as const) {
      expect(readme(dir)).toContain('peerDependencies')
      expect(readme(dir)).toContain('@paper-crumple/core')
    }
  })
})
