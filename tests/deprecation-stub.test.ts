import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const stubDir = new URL('release/paper-crumple/', root)
const stub = JSON.parse(readFileSync(new URL('package.json', stubDir), 'utf8')) as Record<
  string,
  unknown
>
const readme = readFileSync(new URL('README.md', stubDir), 'utf8')

describe('the deprecation stub at the freed unscoped name', () => {
  it('claims exactly the unscoped name, at the family’s first version', () => {
    expect(stub.name).toBe('paper-crumple')
    expect(stub.version).toBe('1.0.0')
  })

  it('ships a README and nothing else — no source, no build', () => {
    expect(stub.files).toEqual(['README.md'])
    expect(stub.scripts).toBeUndefined()
    expect(stub.exports).toBeUndefined()
    expect(stub.main).toBeUndefined()
    expect(stub.module).toBeUndefined()
    expect(stub.types).toBeUndefined()
    expect(readdirSync(fileURLToPath(stubDir)).sort()).toEqual([
      'PUBLISHING.md',
      'README.md',
      'package.json',
    ])
  })

  it('depends on nothing, including the packages it points at', () => {
    expect(stub.dependencies).toEqual({})
    expect(stub.peerDependencies).toBeUndefined()
    expect(stub.devDependencies).toBeUndefined()
  })

  it('is not a workspace package and never will be', () => {
    const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8')
    expect(workspace).not.toMatch(/release/)
    expect(existsSync(fileURLToPath(new URL('packages/paper-crumple', root)))).toBe(false)
  })

  it('is invisible to Changesets, so the family’s fixed group cannot pick it up', () => {
    const config = readFileSync(new URL('.changeset/config.json', root), 'utf8')
    expect(JSON.parse(config).fixed).toEqual([
      ['@paper-crumple/core', '@paper-crumple/paper', '@paper-crumple/motion'],
    ])
    expect(config).not.toMatch(/"paper-crumple"/)
  })

  it('says it is deprecated and names all three replacements', () => {
    expect(readme).toMatch(/deprecated/i)
    for (const name of ['@paper-crumple/core', '@paper-crumple/paper', '@paper-crumple/motion']) {
      expect(readme).toContain(name)
    }
  })

  it('carries a runbook that publishes first and deprecates second', () => {
    const publishing = readFileSync(new URL('PUBLISHING.md', stubDir), 'utf8')
    const publishAt = publishing.indexOf('npm publish')
    const deprecateAt = publishing.indexOf('npm deprecate')
    expect(publishAt).toBeGreaterThanOrEqual(0)
    expect(deprecateAt).toBeGreaterThan(publishAt)
  })
})
