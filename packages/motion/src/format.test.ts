import { describe, expect, it } from 'vitest'

import {
  HEADER_BYTES,
  MAGIC,
  MAX_VERTS_PER_SIDE,
  VERSION,
  align4,
  frameLayout,
  packOffsets,
} from './format.js'

describe('the header constants', () => {
  it('are the ones spec 9 fixes', () => {
    expect(MAGIC).toBe('CRMP')
    expect(VERSION).toBe(1)
    expect(HEADER_BYTES).toBe(32)
    // 255 quads, 256 vertices per side, 65 536 vertices, highest index 65 535 (spec 9.3).
    expect(MAX_VERTS_PER_SIDE).toBe(256)
    expect(MAX_VERTS_PER_SIDE ** 2 - 1).toBe(0xffff)
  })
})

describe('align4', () => {
  it('rounds up to the next multiple of four and leaves multiples alone', () => {
    expect([0, 1, 2, 3, 4, 5, 81, 82, 83, 84].map(align4)).toEqual([
      0, 4, 4, 4, 4, 8, 84, 84, 84, 84,
    ])
  })
})

describe('frameLayout', () => {
  it('matches the shipped 65x65 pack exactly', () => {
    expect(frameLayout(4225)).toEqual({ positions: 0, normals: 25350, ao: 33800, bytes: 38028 })
  })

  it('pads the fixture grid from 81 to 84 bytes', () => {
    expect(frameLayout(9)).toEqual({ positions: 0, normals: 54, ao: 72, bytes: 84 })
  })
})

describe('packOffsets', () => {
  it('reproduces the shipped pack: 32, 33832, 82984, and 539320 bytes for twelve frames', () => {
    const o = packOffsets(4225, 24576)
    expect(o).toEqual({ uvOffset: 32, indexOffset: 33832, frameBase: 82984 })
    expect(o.frameBase + 12 * frameLayout(4225).bytes).toBe(539320)
  })

  it('reproduces the fixture: 32, 104, 152, and 320 bytes for two frames', () => {
    const o = packOffsets(9, 24)
    expect(o).toEqual({ uvOffset: 32, indexOffset: 104, frameBase: 152 })
    expect(o.frameBase + 2 * frameLayout(9).bytes).toBe(320)
  })

  it('keeps every block on the alignment its typed view needs', () => {
    for (const side of [3, 5, 8, 17, 65, 256]) {
      const o = packOffsets(side * side, 6 * (side - 1) ** 2)
      expect(o.uvOffset % 4).toBe(0) // Float32Array
      expect(o.indexOffset % 4).toBe(0) // Uint16Array needs 2; align4 gives 4
      expect(o.frameBase % 4).toBe(0) // Uint16Array of positions, at the block start
      expect(frameLayout(side * side).bytes % 4).toBe(0) // and every stride after it
    }
  })
})
