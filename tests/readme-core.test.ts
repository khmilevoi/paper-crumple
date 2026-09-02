import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readme = readFileSync(new URL('../packages/core/README.md', import.meta.url), 'utf8')
const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!)

describe("core's README, which is the canonical entry point (amendment 26)", () => {
  it('opens with the errore convention, before anything else (spec 10.8)', () => {
    expect(headings[0]).toBe('Errors are values')
  })

  it('states the four rules of the convention rather than gesturing at them', () => {
    const convention = readme.slice(0, readme.indexOf('## Install'))
    expect(convention).toContain('instanceof Error')
    expect(convention).toContain('ABORTED')
    expect(convention).toContain('Err.is()')
    expect(convention).toMatch(/resolves to an Error rather than rejecting/)
  })

  it('puts install second and the what-is-in-the-box table under it', () => {
    expect(headings[1]).toBe('Install')
    expect(headings[2]).toBe('What is in the box')
    const table = readme.slice(readme.indexOf('## What is in the box'))
    for (const name of ['@paper-crumple/core', '@paper-crumple/paper', '@paper-crumple/motion']) {
      expect(table).toContain(name)
    }
    for (const subpath of [
      '@paper-crumple/core/unstable',
      '@paper-crumple/paper/tiles',
      '@paper-crumple/motion/packs/2x3',
    ]) {
      expect(table).toContain(subpath)
    }
  })

  it('documents /unstable as unstable, and says why it is a path and not a JSDoc tag', () => {
    const section = readme.slice(readme.indexOf('## @paper-crumple/core/unstable'))
    expect(section).toMatch(/greps/)
    expect(section).toMatch(/may change in any release/i)
  })

  it('tells wrapper authors to declare core as a peer and never as a dependency', () => {
    const section = readme.slice(readme.indexOf('## For wrapper authors'))
    expect(section).toContain('peerDependencies')
    expect(section).toMatch(/never .*`?dependencies`?/)
    expect(section).toContain('assertSingleCore()')
  })

  it('records the one real loss cancelling the bundle cost — the single CDN URL', () => {
    expect(readme).toContain('esm.sh/paper-crumple')
    expect(readme).toMatch(/import map/)
  })

  it('says the three packages share one version number, and why', () => {
    expect(readme).toMatch(/one version number/)
    expect(readme).toMatch(/\^1\.x/)
  })

  it('carries no reference to a bundle package, which amendment 23 cancelled', () => {
    expect(readme).not.toMatch(/^npm install paper-crumple$/m)
    expect(readme).not.toMatch(/from 'paper-crumple'/)
  })
})
