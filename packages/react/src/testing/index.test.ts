import { describe, expect, it } from 'vitest'
import * as testing from './index.js'

describe('@paper-crumple/react/testing', () => {
  it('exports exactly the supported runtime helpers', () => {
    expect(Object.keys(testing).sort()).toEqual([
      'buildingScene',
      'createFakeStage',
      'deferred',
      'detachedCrumple',
      'failedScene',
      'readyScene',
    ])
  })

  it('keeps the ReactDOM-backed render and probe helpers internal', () => {
    expect('render' in testing).toBe(false)
    expect('renderHook' in testing).toBe(false)
    expect('renderCrumple' in testing).toBe(false)
    expect('flush' in testing).toBe(false)
  })
})
