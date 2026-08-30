import { describe, expect, it } from 'vitest'
import { ABORTED, isAborted } from './abort.js'
import { AssetError } from './errors.js'
import { bitmapSource, classifySource, elementSource } from './source.js'
import {
  asBitmap,
  blobOf,
  deferredDecode,
  fakeBitmap,
  failingDecode,
  fakeCanvas,
  fakeImage,
  stubDecode,
} from './testing/fake-source.js'

describe('classifySource, over the seven arms of the union (§4.1, amendment 9)', () => {
  it('collapses string and URL to one kind, because they normalise to the same fetch', () => {
    expect(classifySource('/sweater.png')).toEqual({ kind: 'url', src: '/sweater.png' })
    const u = new URL('https://cdn.example/sweater.png')
    expect(classifySource(u)).toEqual({ kind: 'url', src: u })
  })

  it('classifies a Blob, and a File with it — a File is a Blob and an upload is the real case', () => {
    const b = blobOf()
    expect(classifySource(b)).toEqual({ kind: 'blob', src: b })
    const f = new File([new Uint8Array([1])], 'sweater.png', { type: 'image/png' })
    expect(classifySource(f)).toEqual({ kind: 'blob', src: f })
  })

  it('classifies the three arms no re-supplier can be derived from', () => {
    const bitmap = fakeBitmap()
    const img = fakeImage()
    const canvas = fakeCanvas()
    expect(classifySource(bitmap)).toEqual({ kind: 'bitmap', src: bitmap })
    expect(classifySource(img)).toEqual({ kind: 'image', src: img })
    expect(classifySource(canvas)).toEqual({ kind: 'canvas', src: canvas })
  })

  it('classifies a supplier function', () => {
    const supply = async () => fakeBitmap() as unknown as ImageBitmap
    expect(classifySource(supply)).toEqual({ kind: 'supplier', src: supply })
  })

  it('falls back to shape when the object carries no Symbol.toStringTag', () => {
    // The tag is how a cross-realm bitmap — one an iframe produced — classifies correctly where
    // `instanceof` would answer false. The structural fallback is for the object that has neither.
    const untagged = { width: 8, height: 8, close: () => {} } as unknown as ImageBitmap
    expect(classifySource(untagged)).toEqual({ kind: 'bitmap', src: untagged })
    const bareCanvas = { nodeType: 1, tagName: 'canvas' } as unknown as HTMLCanvasElement
    expect(classifySource(bareCanvas)).toEqual({ kind: 'canvas', src: bareCanvas })
  })
})

describe('classifySource, over input that is not a source', () => {
  const HOSTILE: readonly unknown[] = [
    undefined,
    null,
    0,
    Number.NaN,
    true,
    Symbol('nope'),
    {},
    [],
    new Map(),
    new Date(),
  ]

  it('returns an AssetError and never throws', () => {
    for (const x of HOSTILE) {
      const r = classifySource(x)
      expect(AssetError.is(r)).toBe(true)
      expect(r).toBeInstanceOf(Error)
    }
  })

  it('names the union in the message, because the caller passed the wrong thing on purpose', () => {
    const r = classifySource(42)
    expect(r).toBeInstanceOf(Error)
    expect(String(r)).toContain('SpriteSource')
  })
})

describe('the bitmap arm: given, never obtained (§8.5.4)', () => {
  it('hands back the bitmap it was given, borrowed and unreclaimable', () => {
    const b = fakeBitmap()
    const rec = bitmapSource(asBitmap(b))
    expect(rec).not.toBeInstanceOf(Error)
    if (rec instanceof Error) return
    expect(rec.kind).toBe('bitmap')
    expect(rec.reclaimable).toBe(false)
    expect(rec.borrowed).toBe(asBitmap(b))
    expect(rec.resupply).toBeUndefined()
  })

  it('refuses a closed or detached bitmap with an AssetError and never rejects', () => {
    const b = fakeBitmap()
    b.close()
    const rec = bitmapSource(asBitmap(b))
    expect(AssetError.is(rec)).toBe(true)
    expect(String(rec)).toContain('closed')
  })

  it('closes nothing, ever: normalising and acquiring leave a given bitmap open', async () => {
    const b = fakeBitmap()
    const rec = bitmapSource(asBitmap(b))
    if (rec instanceof Error) return expect.fail('expected a record')
    const got = await rec.acquire()
    expect(isAborted(got)).toBe(false)
    if (got instanceof Error || isAborted(got)) return expect.fail('expected a bitmap')
    expect(got.bitmap).toBe(asBitmap(b))
    expect(got.owned).toBe(false)
    expect(b.closes).toBe(0)
  })

  it('refuses in acquire too, if the caller closed it after add() was called', async () => {
    const b = fakeBitmap()
    const rec = bitmapSource(asBitmap(b))
    if (rec instanceof Error) return expect.fail('expected a record')
    b.close()
    const got = await rec.acquire()
    expect(AssetError.is(got)).toBe(true)
  })

  it('the record owns nothing, so dispose() has nothing to close (§8.5.4)', () => {
    const rec = bitmapSource(asBitmap(fakeBitmap()))
    if (rec instanceof Error) return expect.fail('expected a record')
    expect('close' in rec).toBe(false)
    expect('dispose' in rec).toBe(false)
  })
})

describe('the element arms: the element is given, the bitmap is obtained', () => {
  it('mints a bitmap the stage owns, from the element the consumer kept', async () => {
    const el = fakeCanvas()
    const d = stubDecode()
    const rec = elementSource('canvas', el, { createImageBitmap: d.decode })
    expect(rec.kind).toBe('canvas')
    expect(rec.reclaimable).toBe(false)
    expect(rec.borrowed).toBeUndefined()
    expect(rec.resupply).toBeUndefined()
    const got = await rec.acquire()
    if (got instanceof Error || isAborted(got)) return expect.fail('expected a bitmap')
    expect(d.calls).toEqual([el])
    expect(got.owned).toBe(true)
    expect(got.bitmap).toBe(asBitmap(d.produced[0]))
  })

  it('does the same for an <img>', async () => {
    const el = fakeImage()
    const d = stubDecode()
    const rec = elementSource('image', el, { createImageBitmap: d.decode })
    const got = await rec.acquire()
    if (got instanceof Error || isAborted(got)) return expect.fail('expected a bitmap')
    expect(rec.kind).toBe('image')
    expect(d.calls).toEqual([el])
    expect(got.owned).toBe(true)
  })

  it('turns a decode failure into an AssetError carrying the cause, never a rejection', async () => {
    const boom = new TypeError('the source image could not be decoded')
    const rec = elementSource('image', fakeImage(), { createImageBitmap: failingDecode(boom) })
    const got = await rec.acquire()
    expect(AssetError.is(got)).toBe(true)
    expect((got as Error).cause).toBe(boom)
  })

  it('returns ABORTED without decoding when the signal has already fired', async () => {
    const d = stubDecode()
    const c = new AbortController()
    c.abort()
    const rec = elementSource('canvas', fakeCanvas(), { createImageBitmap: d.decode })
    const got = await rec.acquire({ signal: c.signal })
    expect(got).toBe(ABORTED)
    expect(d.calls).toEqual([])
  })

  it('closes the bitmap it obtained when the signal fires mid-decode (§8.5.4)', async () => {
    // The caller is not receiving it, so the caller cannot close it. This module obtained it, so
    // this module closes it — exactly once, on the abort path as on every other.
    const d = deferredDecode()
    const c = new AbortController()
    const rec = elementSource('canvas', fakeCanvas(), { createImageBitmap: d.decode })
    const pending = rec.acquire({ signal: c.signal })
    c.abort()
    d.release()
    expect(await pending).toBe(ABORTED)
    expect(d.produced[0].closes).toBe(1)
  })
})
