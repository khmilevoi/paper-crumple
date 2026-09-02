import { describe, expect, it } from 'vitest'
import { findDependencyViolations } from './zero-dependencies.mjs'

const clean = [
  { dir: 'core', manifest: { name: '@paper-crumple/core', dependencies: {} } },
  { dir: 'paper', manifest: { name: '@paper-crumple/paper', dependencies: {} } },
  { dir: 'motion', manifest: { name: '@paper-crumple/motion', dependencies: {} } },
  { dir: 'tsconfig', manifest: { name: '@paper-crumple/tsconfig', private: true } },
]

describe('findDependencyViolations', () => {
  it('passes a workspace where every published package declares an empty dependencies object', () => {
    expect(findDependencyViolations(clean)).toEqual([])
  })

  it('fails a package that declares a runtime dependency', () => {
    const dirty = [
      ...clean.slice(1),
      { dir: 'core', manifest: { name: '@paper-crumple/core', dependencies: { gl: '^1.0.0' } } },
    ]

    expect(findDependencyViolations(dirty)).toEqual([
      '@paper-crumple/core declares dependencies: gl',
    ])
  })

  it('fails a published package whose dependencies key is absent rather than empty', () => {
    const dirty = [...clean.slice(1), { dir: 'core', manifest: { name: '@paper-crumple/core' } }]

    expect(findDependencyViolations(dirty)).toEqual([
      '@paper-crumple/core has no "dependencies" key; write "dependencies": {} explicitly (spec 14)',
    ])
  })

  it('does not require the explicit empty object of a private package', () => {
    expect(findDependencyViolations([clean[3]!])).toEqual([])
  })

  it('fails a private package that declares a runtime dependency', () => {
    const dirty = [
      { dir: 'tsconfig', manifest: { name: 'x', private: true, dependencies: { yaml: '^2' } } },
    ]

    expect(findDependencyViolations(dirty)).toEqual(['x declares dependencies: yaml'])
  })
})
