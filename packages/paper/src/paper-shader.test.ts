import { describe, it, expect } from 'vitest'
import { DEBUG_MODES } from './paper-shader.js'

describe('DEBUG_MODES', () => {
  it('has the expected length', () => {
    expect(DEBUG_MODES.length).toBe(8)
  })

  it('matches the spike array verbatim', () => {
    const expected = [
      'composite',
      'raw SDF',
      'loose SDF',
      'paper mask',
      'fold regions',
      'fold depth',
      'artwork only',
      'paper field',
    ]
    expect(DEBUG_MODES).toEqual(expected)
  })
})
