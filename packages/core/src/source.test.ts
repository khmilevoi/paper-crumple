import { describe, expect, it } from 'vitest'
import { ABORTED, isAborted } from './abort.js'
import { AssetError } from './errors.js'
import {
  bitmapSource,
  blobSource,
  classifySource,
  elementSource,
  normalizeSource,
  supplierSource,
  urlSource,
} from './source.js'
import type { NormalizedSource, SourceKind, SpriteSource } from './source.js'
import {
  asBitmap,
  blobOf,
  deferredDecode,
  fakeBitmap,
  failingDecode,
  fakeCanvas,
  fakeImage,
  stubDecode,
  stubFetch,
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
    // typeof null === 'object', and null is one of the two likeliest values to arrive from
    // untyped JavaScript, so it is named rather than reported as "object".
    expect(String(classifySource(null))).toContain('null')
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
    expect(d.produced[0].closes).toBe(0)
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

describe('the blob arm: reclaimable, and immutable so nothing needs checking', () => {
  it('decodes the retained blob and owns the result', async () => {
    const b = blobOf()
    const d = stubDecode()
    const rec = blobSource(b, { createImageBitmap: d.decode })
    expect(rec.kind).toBe('blob')
    expect(rec.reclaimable).toBe(true)
    expect(rec.borrowed).toBeUndefined()
    const got = await rec.acquire()
    if (got instanceof Error || isAborted(got)) return expect.fail('expected a bitmap')
    expect(d.calls).toEqual([b])
    expect(got.owned).toBe(true)
  })

  it('re-supplies from the same blob and reports unchanged by construction (§8.5.1)', async () => {
    const b = blobOf()
    const d = stubDecode()
    const rec = blobSource(b, { createImageBitmap: d.decode })
    if (rec.resupply === undefined) return expect.fail('a blob is reclaimable')
    await rec.acquire()
    const r = await rec.resupply({ key: 'sweater' })
    if (r instanceof Error || isAborted(r)) return expect.fail('expected a report')
    // A Blob cannot change under the key, so there is no conditional request to issue and no
    // warning to raise. The freshness is a property of the arm, not the answer to a question.
    expect(r.freshness).toBe('unchanged')
    expect(r.warning).toBeUndefined()
    expect(r.owned).toBe(true)
    expect(d.calls).toEqual([b, b])
  })
})

describe('the supplier arm: the promise stays the caller, the bitmap becomes the stage (§8.5.4)', () => {
  it('owns what the supplier returns', async () => {
    const minted = fakeBitmap()
    const rec = supplierSource(async () => asBitmap(minted))
    expect(rec.kind).toBe('supplier')
    expect(rec.reclaimable).toBe(true)
    expect(rec.borrowed).toBeUndefined()
    const got = await rec.acquire()
    if (got instanceof Error || isAborted(got)) return expect.fail('expected a bitmap')
    expect(got.bitmap).toBe(asBitmap(minted))
    expect(got.owned).toBe(true)
  })

  it('calls the supplier again on re-supply, and reports unchanged: the promise is the caller', async () => {
    let calls = 0
    const rec = supplierSource(async () => {
      calls += 1
      return asBitmap(fakeBitmap())
    })
    if (rec.resupply === undefined) return expect.fail('a supplier is reclaimable')
    await rec.acquire()
    const r = await rec.resupply({ key: 'sweater' })
    if (r instanceof Error || isAborted(r)) return expect.fail('expected a report')
    expect(calls).toBe(2)
    expect(r.freshness).toBe('unchanged')
    expect(r.warning).toBeUndefined()
  })

  it('wraps an Error the supplier returns, so the return type stays inside AddError', async () => {
    const inner = new Error('the wardrobe service is down')
    const rec = supplierSource(async () => inner)
    const got = await rec.acquire()
    expect(AssetError.is(got)).toBe(true)
    expect((got as Error).cause).toBe(inner)
  })

  it('wraps a supplier that rejects, because a consumer function is not bound by §10.8', async () => {
    const boom = new RangeError('nope')
    const rec = supplierSource(() => Promise.reject(boom))
    const got = await rec.acquire()
    expect(AssetError.is(got)).toBe(true)
    expect((got as Error).cause).toBe(boom)
  })

  it('refuses a closed bitmap: a supplier must mint a fresh one per call', async () => {
    const stale = fakeBitmap()
    stale.close()
    const rec = supplierSource(async () => asBitmap(stale))
    const got = await rec.acquire()
    expect(AssetError.is(got)).toBe(true)
    expect(String(got)).toContain('fresh')
  })

  it('returns ABORTED without calling the supplier when the signal has already fired', async () => {
    let calls = 0
    const rec = supplierSource(async () => {
      calls += 1
      return asBitmap(fakeBitmap())
    })
    const c = new AbortController()
    c.abort()
    expect(await rec.acquire({ signal: c.signal })).toBe(ABORTED)
    expect(calls).toBe(0)
  })

  it('closes the bitmap a supplier returned when the signal fires while it was in flight', async () => {
    const minted = fakeBitmap()
    let settle = (): void => {}
    const rec = supplierSource(
      () =>
        new Promise<ImageBitmap>((resolve) => {
          settle = () => resolve(asBitmap(minted))
        }),
    )
    const c = new AbortController()
    const pending = rec.acquire({ signal: c.signal })
    c.abort()
    settle()
    expect(await pending).toBe(ABORTED)
    expect(minted.closes).toBe(1)
  })

  it('reports an aborted supplier as ABORTED rather than as an error', async () => {
    // A supplier that wired the signal through to its own fetch returns the DOMException shape.
    const rec = supplierSource(async () => new DOMException('aborted', 'AbortError'))
    expect(await rec.acquire()).toBe(ABORTED)
  })
})

describe('the invariant that ties reclaimability to the re-supplier', () => {
  it('reclaimable is exactly resupply !== undefined, on every arm (§8.8)', () => {
    const d = stubDecode()
    const records: NormalizedSource[] = [
      blobSource(blobOf(), { createImageBitmap: d.decode }),
      supplierSource(async () => asBitmap(fakeBitmap())),
      elementSource('image', fakeImage(), { createImageBitmap: d.decode }),
      elementSource('canvas', fakeCanvas(), { createImageBitmap: d.decode }),
      urlSource('/sweater.png', { createImageBitmap: d.decode }),
    ]
    for (const rec of records) {
      expect(rec.reclaimable).toBe(rec.resupply !== undefined)
    }
    const bitmapRec = bitmapSource(asBitmap(fakeBitmap()))
    if (bitmapRec instanceof Error) return expect.fail('expected a record')
    expect(bitmapRec.reclaimable).toBe(bitmapRec.resupply !== undefined)
    expect(bitmapRec.reclaimable).toBe(false)
  })
})

describe('normalizeSource: seven arms in, one shape out', () => {
  const env = () => ({ createImageBitmap: stubDecode().decode, fetch: stubFetch([{}]).fetch })

  it('resolves every arm of the union to a record', () => {
    const table: ReadonlyArray<readonly [SpriteSource, SourceKind, boolean]> = [
      ['/sweater.png', 'url', true],
      [new URL('https://cdn.example/sweater.png'), 'url', true],
      [blobOf(), 'blob', true],
      [asBitmap(fakeBitmap()), 'bitmap', false],
      [fakeImage(), 'image', false],
      [fakeCanvas(), 'canvas', false],
      [async () => asBitmap(fakeBitmap()), 'supplier', true],
    ]
    for (const [src, kind, reclaimable] of table) {
      const rec = normalizeSource(src, env())
      if (rec instanceof Error) return expect.fail(`${kind} did not normalise`)
      expect(rec.kind).toBe(kind)
      expect(rec.reclaimable).toBe(reclaimable)
      expect(rec.reclaimable).toBe(rec.resupply !== undefined)
      expect(rec.borrowed === undefined).toBe(kind !== 'bitmap')
    }
  })

  it('forwards the classification error rather than inventing a second one', () => {
    const r = normalizeSource(42 as unknown as SpriteSource)
    expect(AssetError.is(r)).toBe(true)
    expect(String(r)).toContain('SpriteSource')
  })

  it('forwards the detached-bitmap refusal', () => {
    const b = fakeBitmap()
    b.close()
    expect(AssetError.is(normalizeSource(asBitmap(b)))).toBe(true)
  })

  it('defaults its environment, so production calls it with one argument', () => {
    // No env: the record is built, and only a call that reaches the boundary needs the globals.
    const rec = normalizeSource('/sweater.png')
    expect(rec).not.toBeInstanceOf(Error)
  })
})
