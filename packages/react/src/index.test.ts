import { describe, expect, it } from 'vitest'
import * as api from './index.js'

describe('the public surface (§3)', () => {
  it('exports exactly the scene layer and the crumple layer, and no internals', () => {
    expect(Object.keys(api).sort()).toEqual([
      'Crumple',
      'PaperScene',
      'useCrumple',
      'usePaperScene',
      'useScene',
    ])
  })

  it('does not re-export useEvent, the store, or the fake stage', () => {
    expect('useEvent' in api).toBe(false)
    expect('createVersionedStore' in api).toBe(false)
    expect('createFakeStage' in api).toBe(false)
    expect('acquire' in api).toBe(false)
    expect('rememberPair' in api).toBe(false)
    expect('renderCrumple' in api).toBe(false)
  })
})
