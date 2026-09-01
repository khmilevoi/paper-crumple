/**
 * The twin's half of the cross-language contract (spec 9.2, 11).
 *
 * Byte equality on the `.bin`; value equality on the manifest. The manifest cannot be compared
 * byte for byte because Python renders a float as `1.0` and `JSON.stringify` renders it as `1` —
 * so the twin's manifest is compared against the *parsed* committed manifest, which is the same
 * object `parsePack` is handed.
 */
import { describe, expect, it } from 'vitest'

import { decodeFrame, parsePack } from '../../packages/motion/src/pack.js'
import { readTinyBin, readTinyManifest } from '../../packages/motion/test/fixture.js'
import { firstDifference } from './bytes.js'
import type { PackSpec } from './packWriter.js'
import { gridIndices, gridUvs, writePack } from './packWriter.js'

/** `pack.py`'s `fixture_frames()`, spelled out in JavaScript. */
function fixtureSpec(): PackSpec {
  const side = 3
  const n = side * side
  const p0: number[] = []
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) p0.push(x - 1, y - 1, 0)
  const p1: number[] = []
  for (let i = 0; i < n; i++) p1.push(p0[3 * i]!, p0[3 * i + 1]!, 0.25 * p0[3 * i]!)
  const l = Math.sqrt(0.25 * 0.25 + 1)
  const tilt: number[] = []
  const up: number[] = []
  for (let i = 0; i < n; i++) {
    tilt.push(-0.25 / l, 0, 1 / l)
    up.push(0, 0, 1)
  }
  return {
    vertsPerSide: side,
    frames: [
      { index: 0, positions: p0, normals: up, ao: new Array<number>(n).fill(1) },
      {
        index: 4,
        positions: p1,
        normals: tilt,
        ao: Array.from({ length: n }, (_, i) => i / (n - 1)),
      },
    ],
    keyFrames: [0, 4],
    light: [-0.4, 0.55, 0.73338],
    bucket: 'tiny',
    aspect: 1,
    sim: { fps: 24, frames: 8, storeEvery: 4, stage1End: 4, seed: 0, blender: 'fixture' },
  }
}

describe('the grid tables', () => {
  it('advances the column first, row 0 at y minimum', () => {
    const uvs = gridUvs(2)
    expect(uvs.length).toBe(18)
    expect(Array.from(uvs.slice(0, 6))).toEqual([0, 0, 0.5, 0, 1, 0])
  })

  it('emits two triangles per quad, the same winding pack.py writes', () => {
    const indices = gridIndices(2)
    expect(indices.length).toBe(24)
    expect(Array.from(indices.slice(0, 6))).toEqual([0, 1, 4, 0, 4, 3])
  })
})

describe('the JS twin against the committed fixture', () => {
  it('reproduces tiny.bin byte for byte', () => {
    const written = writePack(fixtureSpec())
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    const got = new Uint8Array(written.bin)
    const want = new Uint8Array(readTinyBin())
    expect(got.length).toBe(320)
    expect(firstDifference(got, want)).toBe(-1)
  })

  it('reproduces tiny.json by value, floats included', () => {
    const written = writePack(fixtureSpec())
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    expect(written.manifest).toEqual(readTinyManifest())
  })

  it('produces a pack the shipped parser accepts', () => {
    const written = writePack(fixtureSpec())
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    const pack = parsePack(written.bin, written.manifest)
    expect(pack).not.toBeInstanceOf(Error)
    if (pack instanceof Error) return
    expect(pack.vertexCount).toBe(9)
    expect(pack.indexCount).toBe(24)
    expect(pack.frameCount).toBe(2)
    // Simulation indices [0, 4] resolved to stored slots [0, 1] (spec 9.1).
    expect(Array.from(pack.keyFrames)).toEqual([0, 1])
    expect(pack.frames[0]!.alphaFloor).toBe(0)
    expect(pack.frames[1]!.alphaFloor).toBe(1)
  })
})

describe('the twin at the real grid size', () => {
  it('round-trips 65 x 65 within the codecs’ precision', () => {
    const side = 65
    const n = side * side
    let seed = 3
    const rand = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
    const positions = new Float32Array(3 * n)
    const normals = new Float32Array(3 * n)
    const ao = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      positions.set([rand() * 2 - 1, rand() * 2 - 1, rand() - 0.5], 3 * i)
      const v = [rand() - 0.5, rand() - 0.5, rand() - 0.5]
      const l = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!) || 1
      normals.set(
        v.map((c) => c / l),
        3 * i,
      )
      ao[i] = rand()
    }
    const written = writePack({
      vertsPerSide: side,
      frames: [{ index: 0, positions, normals, ao }],
      keyFrames: [0],
      light: [0, 0, 1],
      bucket: 'tiny',
      aspect: 1,
      sim: { stage1End: 0 },
    })
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    // align4(32 + 8*4225) = 33832, align4(33832 + 2*24576) = 82984, align4(9*4225) = 38028.
    expect(written.bin.byteLength).toBe(82984 + 38028)
    const pack = parsePack(written.bin, written.manifest)
    expect(pack).not.toBeInstanceOf(Error)
    if (pack instanceof Error) return
    const frame = decodeFrame(pack, 0)
    expect(frame).not.toBeInstanceOf(Error)
    if (frame instanceof Error) return
    for (let i = 0; i < 3 * n; i++)
      expect(Math.abs(frame.positions[i]! - positions[i]!)).toBeLessThanOrEqual(1e-3)
    for (let i = 0; i < n; i++) {
      const dot =
        frame.normals[3 * i]! * normals[3 * i]! +
        frame.normals[3 * i + 1]! * normals[3 * i + 1]! +
        frame.normals[3 * i + 2]! * normals[3 * i + 2]!
      expect(dot).toBeGreaterThan(0.999)
      expect(Math.abs(frame.ao[i]! - ao[i]!)).toBeLessThanOrEqual(1 / 255)
    }
  })
})

describe('the twin never throws', () => {
  it('propagates encodeOct’s PackError on a non-finite normal', () => {
    const spec = fixtureSpec()
    const broken: PackSpec = {
      ...spec,
      frames: [{ ...spec.frames[0]!, normals: new Array<number>(27).fill(Number.NaN) }],
    }
    const written = writePack(broken)
    expect(written).toBeInstanceOf(Error)
    if (!(written instanceof Error)) return
    expect(written.name).toBe('PackError')
    expect(written.message).toMatch(/non-finite normal/)
  })
})
