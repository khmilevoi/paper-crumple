import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), 'utf8')) as T

interface ChangesetsConfig {
  fixed?: string[][]
  linked?: string[][]
  access?: string
  baseBranch?: string
  privatePackages?: { version: boolean; tag: boolean }
}

interface TurboConfig {
  tasks?: Record<string, { dependsOn?: string[]; outputs?: string[] }>
  pipeline?: unknown
}

describe('Changesets', () => {
  const config = readJson<ChangesetsConfig>('.changeset/config.json')

  it('fixes the three published packages to one version number', () => {
    expect(config.fixed).toEqual([
      ['@paper-crumple/core', '@paper-crumple/paper', '@paper-crumple/motion'],
    ])
  })

  it('names the cancelled unscoped paper-crumple package nowhere in the config', () => {
    expect(JSON.stringify(config)).not.toMatch(/"paper-crumple"/)
  })

  it('publishes scoped packages publicly and versions from the trunk', () => {
    expect(config.access).toBe('public')
    expect(config.baseBranch).toBe('develop')
  })

  it('leaves private packages unversioned and untagged', () => {
    expect(config.privatePackages).toEqual({ version: false, tag: false })
  })

  it('uses fixed rather than linked, which is a different guarantee', () => {
    expect(config.linked).toEqual([])
  })
})

describe('Turborepo', () => {
  const turbo = readJson<TurboConfig>('turbo.json')

  it('declares a build task that respects the dependency graph', () => {
    expect(turbo.tasks?.build?.dependsOn).toEqual(['^build'])
    expect(turbo.tasks?.build?.outputs).toEqual(['dist/**'])
  })

  it('uses tasks, not the v1 pipeline key', () => {
    expect(turbo.pipeline).toBeUndefined()
  })
})
