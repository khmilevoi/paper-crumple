import { expect, it } from 'vitest'
import { checkIsolatedImport } from '../../../tools/packaging/isolated-consumer.mjs'

it('rejects an isolated consumer missing the required native Reatom peer', () => {
  const errors = checkIsolatedImport('reatom', [], ['react'])
  expect(errors).toHaveLength(1)
  expect(errors[0]).toContain('@reatom/core')
}, 60_000)

it('imports packed Reatom without React, paper or motion', () => {
  expect(
    checkIsolatedImport(
      'reatom',
      ['@reatom/core'],
      [
        'react',
        'react-dom',
        '@paper-crumple/react',
        '@paper-crumple/paper',
        '@paper-crumple/motion',
      ],
    ),
  ).toEqual([])
}, 60_000)

it('imports packed React without Reatom, paper or motion', () => {
  expect(
    checkIsolatedImport(
      'react',
      ['react'],
      [
        '@reatom/core',
        '@reatom/react',
        '@paper-crumple/reatom',
        '@paper-crumple/paper',
        '@paper-crumple/motion',
      ],
    ),
  ).toEqual([])
}, 60_000)
