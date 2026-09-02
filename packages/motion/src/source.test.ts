import { ABORTED, AssetError, MotionError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import { readPackBin } from '../test/packs.js'
import { MOTION_KNOBS } from './knobs.js'
import pack1x1 from './packs/1x1.js'
import pack2x3 from './packs/2x3.js'
import pack3x2 from './packs/3x2.js'
import { bakedMotion, type BakedClip, type BakedFit } from './source.js'

function bytesFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const bucket = url.slice(url.lastIndexOf('/') + 1).replace('.bin', '')
    return new Response(readPackBin(bucket), { status: 200 })
  }) as typeof globalThis.fetch
}

function source(packs = [pack2x3, pack1x1, pack3x2]) {
  return bakedMotion({ packs, fetch: bytesFetch() })
}

function fit(w: number, h: number, override?: string | null): BakedFit {
  const f = source().fit({ x: 0, y: 0, w, h }, override)
  expect(f).not.toBeInstanceOf(Error)
  return f as BakedFit
}

describe('the slot surface (§5.3)', () => {
  it('exposes the six descriptors and nothing else', () => {
    expect(source().knobs).toEqual(MOTION_KNOBS)
  })
})

describe('fit is pure (§5.3, §5.4)', () => {
  it('picks the bucket and returns a front sized to cover the rect', () => {
    const f = fit(256, 384)
    expect(f.bucket).toBe('2x3')
    expect(f.frontSize).toEqual({ w: 256, h: 384 })
    expect(f.sheetW).toBeCloseTo(256, 9)
    expect(f.sheetH).toBeCloseTo(384, 9)
    expect(fit(384, 384).frontSize).toEqual({ w: 384, h: 384 })
    expect(fit(384, 256).frontSize).toEqual({ w: 384, h: 256 })
  })

  it('rounds the front up, never down: the sheet must cover the box', () => {
    const f = fit(300, 600)
    expect(f.frontSize.w).toBeGreaterThanOrEqual(f.sheetW)
    expect(f.frontSize.h).toBeGreaterThanOrEqual(f.sheetH)
    expect(Number.isInteger(f.frontSize.w)).toBe(true)
    expect(Number.isInteger(f.frontSize.h)).toBe(true)
  })

  it('sorts on the bucket, which is what gives §8.4 its 36 VAO binds and one program bind', () => {
    expect(fit(256, 384).sortKey).toBe('2x3')
    expect(fit(200, 300).sortKey).toBe('2x3')
    expect(fit(384, 384).sortKey).toBe('1x1')
    expect(fit(384, 256).sortKey).toBe('3x2')
  })

  it('carries the stretch and its clamp flag through from fitSheet (§9.3)', () => {
    expect(fit(480, 600).clamped).toBe(false)
    expect(fit(300, 600).clamped).toBe(true)
    expect(fit(300, 600).stretch).toBeCloseTo(1 / 1.2, 12)
  })

  it('honours an override, and null means auto-pick', () => {
    expect(fit(400, 600, '1x1').bucket).toBe('1x1')
    expect(fit(400, 600, null).bucket).toBe('2x3')
    expect(fit(400, 600).bucket).toBe('2x3')
  })

  it('is a MotionError for a degenerate rect and for an unknown override', () => {
    const s = source()
    expect(MotionError.is(s.fit({ x: 0, y: 0, w: 0, h: 10 }))).toBe(true)
    expect(MotionError.is(s.fit({ x: 0, y: 0, w: 10, h: NaN }))).toBe(true)
    expect(MotionError.is(s.fit({ x: 0, y: 0, w: 400, h: 600 }, 'nope'))).toBe(true)
  })

  it('does not care whether the bucket it picked was supplied — that is load’s error', () => {
    const only2x3 = bakedMotion({ packs: [pack2x3], fetch: bytesFetch() })
    const f = only2x3.fit({ x: 0, y: 0, w: 384, h: 384 })
    expect(f).not.toBeInstanceOf(Error)
    expect((f as BakedFit).bucket).toBe('1x1')
  })

  it('never touches the source: two fits are independent and equal', () => {
    const s = source()
    const a = s.fit({ x: 0, y: 0, w: 256, h: 384 })
    const b = s.fit({ x: 0, y: 0, w: 256, h: 384 })
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
  })
})

describe('load (§5.3, §18 amendment 1)', () => {
  it('resolves to a clip carrying this bucket’s frame count and key frames', async () => {
    const s = source()
    const f = s.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit
    const clip = (await s.load(f)) as BakedClip
    expect(clip).not.toBeInstanceOf(Error)
    expect(clip.bucket).toBe('2x3')
    expect(clip.frameCount).toBe(12)
    expect(clip.keyFrames).toEqual([0, 2, 4, 6, 8, 11])
  })

  it('keeps per-bucket state in a Map: two loaded buckets do not overwrite each other', async () => {
    const s = source()
    const a = (await s.load(s.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit)) as BakedClip
    const b = (await s.load(s.fit({ x: 0, y: 0, w: 384, h: 256 }) as BakedFit)) as BakedClip
    expect(a.bucket).toBe('2x3')
    expect(b.bucket).toBe('3x2')
    expect(a.frameCount).toBe(12)
    expect(b.frameCount).toBe(12)
    expect(a).not.toBe(b)
  })

  it('names the missing subpath when a bucket was not supplied (§14)', async () => {
    const s = bakedMotion({ packs: [pack2x3], fetch: bytesFetch() })
    const r = await s.load(s.fit({ x: 0, y: 0, w: 384, h: 384 }) as BakedFit)
    expect(AssetError.is(r)).toBe(true)
    expect((r as Error).message).toContain('@paper-crumple/motion/packs/1x1')
  })

  it('returns ABORTED on cancellation, and not an AbortedError', async () => {
    const s = source()
    const ac = new AbortController()
    ac.abort()
    const r = await s.load(s.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit, { signal: ac.signal })
    expect(r).toBe(ABORTED)
    expect(r).not.toBeInstanceOf(Error)
  })

  it('hands the same clip to two loads of one bucket, and refcounts them', async () => {
    const s = source()
    const f = s.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit
    const [a, b] = await Promise.all([s.load(f), s.load(f)])
    expect(a).toBe(b)
    // Two loads, two releases: the first must not evict.
    s.release(a as BakedClip)
    expect(await s.load(f)).toBe(a)
    s.release(a as BakedClip)
    s.release(a as BakedClip)
  })

  it('never rejects: a fetch that throws resolves to an AssetError', async () => {
    const s = bakedMotion({
      packs: [pack2x3],
      // ESLint bans `throw` outside eslint.boundaries.js's allow-list (§10), which this test file
      // is not on; a rejected promise is the observable equivalent of an async function throwing.
      fetch: (() =>
        Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch,
    })
    const r = await s.load(s.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit)
    expect(AssetError.is(r)).toBe(true)
  })
})

describe('release and dispose', () => {
  it('ignores a release for a clip whose bucket is already gone', async () => {
    const s = source()
    const f = s.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit
    const clip = (await s.load(f)) as BakedClip
    s.release(clip)
    expect(() => s.release(clip)).not.toThrow()
  })

  it('drops every bucket on dispose, and a load afterwards is an Error', async () => {
    const s = source()
    const f = s.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit
    await s.load(f)
    s.dispose()
    expect(await s.load(f)).toBeInstanceOf(Error)
  })
})
