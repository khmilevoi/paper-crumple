import { describe, expect, it } from 'vitest'

import {
  TINY_BIN_BYTES,
  TINY_JSON_BYTES,
  readTinyBin,
  readTinyJsonBytes,
  readTinyManifest,
} from '../../test/fixture.js'

describe('the tiny fixture', () => {
  it('is the 320-byte binary the bake writers must reproduce', () => {
    const bin = readTinyBin()
    expect(bin.byteLength).toBe(TINY_BIN_BYTES)
    expect(bin.byteLength).toBe(320)
    expect(new TextDecoder().decode(new Uint8Array(bin, 0, 4))).toBe('CRMP')
  })

  it('is a 653-byte manifest with no CR anywhere, because .gitattributes forces LF', () => {
    const bytes = readTinyJsonBytes()
    expect(bytes.byteLength).toBe(TINY_JSON_BYTES)
    expect(bytes.byteLength).toBe(653)
    expect(bytes.includes(0x0d)).toBe(false)
    // pack.py writes json.dumps(...) + '\n' — the trailing newline is part of the contract.
    expect(bytes[bytes.length - 1]).toBe(0x0a)
  })

  it('describes a 3x3 grid with two stored frames', () => {
    const m = readTinyManifest() as Record<string, unknown>
    expect(m.bucket).toBe('tiny')
    expect(m.version).toBe(1)
    expect(m.vertsPerSide).toBe(3)
    expect(m.vertexCount).toBe(9)
    expect(m.indexCount).toBe(24)
    expect(m.binBytes).toBe(320)
    expect(m.frameBytes).toBe(84)
    expect(m.bin).toBe('tiny.bin')
    // Simulation indices, not stored slots: [0, 4] against frames whose index values are 0 and 4.
    expect(m.keyFrames).toEqual([0, 4])
  })

  it('carries a sim block, which the loader never reads and must never reject', () => {
    const m = readTinyManifest() as Record<string, unknown>
    expect(m.sim).toMatchObject({ blender: 'fixture', stage1End: 4 })
  })
})
