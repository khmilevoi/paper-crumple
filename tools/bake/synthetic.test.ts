/**
 * The synthetic pack: a stand-in for a bake, so the runtime can be brought up without Blender
 * (spec 13). `fixtures/synthetic.bin` is 539 KB and **must never ship** — it is safe here only
 * because `tools/` is outside `pnpm-workspace.yaml`'s `packages/*` glob, so no tarball can reach
 * it.
 *
 * Regenerate after a deliberate change to `synthetic.ts` or to the format:
 *   bash:       WRITE_SYNTHETIC=1 pnpm vitest run tools/bake/synthetic.test.ts
 *   PowerShell: $env:WRITE_SYNTHETIC=1; pnpm vitest run tools/bake/synthetic.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { decodeFrame, parsePack } from '../../packages/motion/src/pack.js'
import { firstDifference } from './bytes.js'
import { writePack } from './packWriter.js'
import { SYNTHETIC_BYTES, SYNTHETIC_STORED, syntheticFrames } from './synthetic.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/synthetic.bin', import.meta.url))

const written = writePack(syntheticFrames())

describe('the synthetic pack generator', () => {
  it('writes a pack of exactly the shipped size', () => {
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    // 82 984 B of header + UV + index, then 12 frames of 38 028 B.
    expect(written.bin.byteLength).toBe(SYNTHETIC_BYTES)
    expect(written.bin.byteLength).toBe(539320)
  })

  it('parses, and frame 0 is the exact rest grid', () => {
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    const pack = parsePack(written.bin, written.manifest)
    expect(pack).not.toBeInstanceOf(Error)
    if (pack instanceof Error) return
    expect(pack.frameCount).toBe(12)
    expect(pack.frames.map((f) => f.index)).toEqual([...SYNTHETIC_STORED])
    // Simulation key frames [0, 8, 16, 24, 32, 44] resolved to stored slots.
    expect(Array.from(pack.keyFrames)).toEqual([0, 2, 4, 6, 8, 11])
    const frame0 = decodeFrame(pack, 0)
    expect(frame0).not.toBeInstanceOf(Error)
    if (frame0 instanceof Error) return
    const corner = 3 * (64 * 65 + 64)
    expect(frame0.positions[corner]).toBe(1)
    expect(frame0.positions[corner + 1]).toBe(1)
    expect(pack.frames[0]!.alphaFloor).toBe(0)
    expect(pack.frames[11]!.alphaFloor).toBe(1)
  })

  it('shrinks in xy by the last frame, so the ball reads as compact', () => {
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    const pack = parsePack(written.bin, written.manifest)
    expect(pack).not.toBeInstanceOf(Error)
    if (pack instanceof Error) return
    const last = decodeFrame(pack, 11)
    expect(last).not.toBeInstanceOf(Error)
    if (last instanceof Error) return
    let maxXY = 0
    for (let i = 0; i < last.positions.length; i += 3) {
      maxXY = Math.max(maxXY, Math.abs(last.positions[i]!), Math.abs(last.positions[i + 1]!))
    }
    expect(maxXY).toBeLessThan(0.45)
  })

  it('has finite, unit-length normals on every vertex of every frame', () => {
    // Guards the guarded sqrt in surface(): r2 reaches 2 at the corners, where R*R - 0.25*r2 goes
    // negative and an unguarded sqrt gives NaN, which encodeOct turns into a PackError.
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    const pack = parsePack(written.bin, written.manifest)
    expect(pack).not.toBeInstanceOf(Error)
    if (pack instanceof Error) return
    for (let f = 0; f < pack.frameCount; f++) {
      const frame = decodeFrame(pack, f)
      expect(frame).not.toBeInstanceOf(Error)
      if (frame instanceof Error) return
      for (let i = 0; i < frame.normals.length; i += 3) {
        const x = frame.normals[i]!
        const y = frame.normals[i + 1]!
        const z = frame.normals[i + 2]!
        expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true)
        expect(Math.abs(Math.sqrt(x * x + y * y + z * z) - 1)).toBeLessThan(1e-2)
      }
    }
  })
})

describe('the committed synthetic fixture', () => {
  it('is byte-identical to what the generator produces today', () => {
    expect(written).not.toBeInstanceOf(Error)
    if (written instanceof Error) return
    const bytes = new Uint8Array(written.bin)
    if (process.env.WRITE_SYNTHETIC === '1') {
      mkdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url)), { recursive: true })
      writeFileSync(FIXTURE, bytes)
    }
    expect(existsSync(FIXTURE)).toBe(true)
    const committed = new Uint8Array(readFileSync(FIXTURE))
    expect(committed.length).toBe(539320)
    expect(firstDifference(bytes, committed)).toBe(-1)
  })

  it('lives outside the workspace glob, so no tarball can reach it', () => {
    const workspace = readFileSync(
      fileURLToPath(new URL('../../pnpm-workspace.yaml', import.meta.url)),
      'utf8',
    )
    expect(workspace).toMatch(/^\s*-\s*'packages\/\*'\s*$/m)
    expect(FIXTURE.replace(/\\/g, '/')).toContain('/tools/bake/fixtures/')
    expect(FIXTURE.replace(/\\/g, '/')).not.toContain('/packages/')
  })
})
