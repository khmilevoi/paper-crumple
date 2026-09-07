import { DWELL_MS, PackError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import { readPackBin } from '../test/packs.js'
import pack1x1 from './packs/1x1.js'
import pack2x3 from './packs/2x3.js'
import pack3x2 from './packs/3x2.js'
import { bakedMotion, type BakedClip, type BakedFit } from './source.js'

const MANIFEST_KEY_FRAMES = [0, 2, 4, 6, 8, 11]

function bytesFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const bucket = url.slice(url.lastIndexOf('/') + 1).replace('.bin', '')
    return new Response(readPackBin(bucket), { status: 200 })
  }) as typeof globalThis.fetch
}

function source() {
  return bakedMotion({ packs: [pack2x3, pack1x1, pack3x2], fetch: bytesFetch() })
}

function fitFor(s: ReturnType<typeof source>, w: number, h: number): BakedFit {
  const f = s.fit({ x: 0, y: 0, w, h })
  expect(f).not.toBeInstanceOf(Error)
  return f as BakedFit
}

async function load(s: ReturnType<typeof source>, w: number, h: number): Promise<BakedClip> {
  const clip = await s.load(fitFor(s, w, h))
  expect(clip).not.toBeInstanceOf(Error)
  expect(typeof clip).not.toBe('symbol')
  return clip as BakedClip
}

describe('packs(): what a pose editor reads', () => {
  it('lists the resident packs in the order they were supplied, and none before the first load', async () => {
    const s = source()
    expect(s.packs()).toEqual([])
    await load(s, 384, 256)
    await load(s, 256, 384)
    expect(s.packs().map((p) => p.bucket)).toEqual(['2x3', '3x2'])
  })

  it('exposes the stored frames and the manifest key frames the selects are built from', async () => {
    const s = source()
    await load(s, 256, 384)
    const [pack] = s.packs()
    expect(pack?.frameCount).toBe(12)
    expect(pack?.frames.map((f) => f.index)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44])
    expect(pack?.keyFrames).toEqual(MANIFEST_KEY_FRAMES)
  })

  it('drops a bucket when its last clip is released', async () => {
    const s = source()
    const clip = await load(s, 256, 384)
    await load(s, 256, 384)
    s.release(clip)
    expect(s.packs().map((p) => p.bucket)).toEqual(['2x3'])
    s.release(clip)
    expect(s.packs()).toEqual([])
  })
})

describe('setPoses: the runtime schedule', () => {
  it('starts with no override: every clip plays its manifest at DWELL_MS', async () => {
    const s = source()
    expect(s.poses).toBeNull()
    const clip = await load(s, 256, 384)
    expect(clip.keyFrames).toEqual(MANIFEST_KEY_FRAMES)
    expect(clip.dwells).toBeUndefined()
  })

  it('reaches a clip that was handed out before the call, without a re-load', async () => {
    const s = source()
    const clip = await load(s, 256, 384)
    expect(s.setPoses({ keyFrames: [0, 5, 11] })).toBeUndefined()
    expect(s.poses).toEqual({ keyFrames: [0, 5, 11], dwells: [95, 98, 90] })
    expect(clip.keyFrames).toEqual([0, 5, 11])
    expect(clip.dwells).toEqual([95, 98, 90])
    // The same object the stage holds in its sprite record — not a replacement.
    expect(await load(s, 256, 384)).toBe(clip)
  })

  it('applies to a bucket that loads later, and to every bucket alike', async () => {
    const s = source()
    await load(s, 256, 384)
    expect(s.setPoses({ keyFrames: [0, 11], dwells: [40, 60] })).toBeUndefined()
    const later = await load(s, 384, 256)
    expect(later.bucket).toBe('3x2')
    expect(later.keyFrames).toEqual([0, 11])
    expect(later.dwells).toEqual([40, 60])
  })

  it('a six-pose override carries DWELL_MS itself, so the stage keeps one controller', async () => {
    const s = source()
    const clip = await load(s, 256, 384)
    expect(s.setPoses({ keyFrames: [0, 1, 2, 3, 4, 5] })).toBeUndefined()
    expect(clip.dwells).toBe(DWELL_MS)
  })

  it('null restores the manifests, and the dwells go back to absent', async () => {
    const s = source()
    const clip = await load(s, 256, 384)
    s.setPoses({ keyFrames: [0, 11] })
    expect(s.setPoses(null)).toBeUndefined()
    expect(s.poses).toBeNull()
    expect(clip.keyFrames).toEqual(MANIFEST_KEY_FRAMES)
    expect(clip.dwells).toBeUndefined()
  })

  it("refuses an input that breaks setKeyFrames's rules, and changes nothing", async () => {
    const s = source()
    const clip = await load(s, 256, 384)
    s.setPoses({ keyFrames: [0, 4] })
    const refused = s.setPoses({ keyFrames: [0, 3, 2] })
    expect(PackError.is(refused)).toBe(true)
    expect(String(refused)).toMatch(/non-decreasing/)
    expect(s.poses).toEqual({ keyFrames: [0, 4], dwells: [95, 90] })
    expect(clip.keyFrames).toEqual([0, 4])
  })

  it('checks the slot bound against every resident pack, and names the bucket', async () => {
    const s = source()
    await load(s, 256, 384)
    const refused = s.setPoses({ keyFrames: [0, 12] })
    expect(PackError.is(refused)).toBe(true)
    expect((refused as Error).message).toContain("bucket '2x3'")
    expect((refused as Error).message).toMatch(/not a stored slot in 0 … 11/)
    expect(s.poses).toBeNull()
  })

  it('with no pack resident the structure is checked now and the bound at load()', async () => {
    const s = source()
    expect(PackError.is(s.setPoses({ keyFrames: [1] }))).toBe(true)
    expect(s.setPoses({ keyFrames: [0, 40] })).toBeUndefined()
    const r = await s.load(fitFor(s, 256, 384))
    expect(PackError.is(r)).toBe(true)
    expect((r as Error).message).toContain("bucket '2x3'")
    // The reference the failed load took was handed back: nothing is resident.
    expect(s.packs()).toEqual([])
    // A schedule the pack can play loads as before.
    expect(s.setPoses({ keyFrames: [0, 11] })).toBeUndefined()
    expect((await load(s, 256, 384)).keyFrames).toEqual([0, 11])
  })

  it('the count and the table agree by construction, which is what stage.ts relies on', async () => {
    const s = source()
    const clip = await load(s, 256, 384)
    s.setPoses({ keyFrames: [0, 2, 11] })
    // What `stage.ts` reads: `record.clip.keyFrames.length` for the pose count and
    // `record.clip.dwells` for the runner's table.
    expect(clip.keyFrames.length).toBe(clip.dwells?.length)
  })
})
