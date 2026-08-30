import { describe, expect, it } from 'vitest'
import { ABORTED, isAborted } from './abort.js'
import { AssetError } from './errors.js'
import { readValidator, urlSource } from './source.js'
import { asBitmap, blobOf, stubDecode, stubFetch } from './testing/fake-source.js'

const headersOf = (h: Record<string, string>) => ({
  get: (name: string) => {
    for (const [k, v] of Object.entries(h)) {
      if (k.toLowerCase() === name.toLowerCase()) return v
    }
    return null
  },
})

describe('readValidator (§8.5.1, amendment 10)', () => {
  it('records an ETag', () => {
    expect(readValidator(headersOf({ ETag: 'W/"v1"' }))).toEqual({
      etag: 'W/"v1"',
      lastModified: undefined,
    })
  })

  it('records a Last-Modified', () => {
    expect(readValidator(headersOf({ 'Last-Modified': 'Wed, 26 Aug 2026 10:00:00 GMT' }))).toEqual({
      etag: undefined,
      lastModified: 'Wed, 26 Aug 2026 10:00:00 GMT',
    })
  })

  it('is case-insensitive, because a real Headers is', () => {
    expect(readValidator(headersOf({ etag: '"v1"' }))?.etag).toBe('"v1"')
  })

  it('records nothing when a cross-origin response exposes neither header', () => {
    // Without `Access-Control-Expose-Headers: ETag` the header is present on the wire and absent
    // to script. There the contract is documented and unenforced, and this is where that starts.
    expect(readValidator(headersOf({ 'Content-Type': 'image/png' }))).toBeUndefined()
  })
})

describe('the url arm: the first acquisition', () => {
  it('fetches the input it was given, unchanged', async () => {
    const f = stubFetch([{ headers: { ETag: '"v1"' } }])
    const d = stubDecode()
    const rec = urlSource('/sweater.png', { fetch: f.fetch, createImageBitmap: d.decode })
    expect(rec.kind).toBe('url')
    expect(rec.reclaimable).toBe(true)
    expect(rec.borrowed).toBeUndefined()
    const got = await rec.acquire()
    if (got instanceof Error || isAborted(got)) return expect.fail('expected a bitmap')
    // The original string is handed to `fetch` verbatim: `new URL('/sweater.png')` throws without
    // a base and there is no base in Node, so resolving a relative path stays `fetch`'s job.
    expect(f.calls).toEqual([{ input: '/sweater.png', headers: {} }])
    expect(got.owned).toBe(true)
  })

  it('takes a URL object the same way', async () => {
    const u = new URL('https://cdn.example/sweater.png')
    const f = stubFetch([{}])
    const d = stubDecode()
    const rec = urlSource(u, { fetch: f.fetch, createImageBitmap: d.decode })
    await rec.acquire()
    expect(f.calls[0].input).toBe(u)
  })

  it('decodes the response body and owns the bitmap', async () => {
    const body = blobOf('sweater')
    const f = stubFetch([{ body }])
    const d = stubDecode()
    const rec = urlSource('/sweater.png', { fetch: f.fetch, createImageBitmap: d.decode })
    const got = await rec.acquire()
    if (got instanceof Error || isAborted(got)) return expect.fail('expected a bitmap')
    expect(d.calls).toEqual([body])
    expect(got.bitmap).toBe(asBitmap(d.produced[0]))
    expect(got.owned).toBe(true)
  })

  it('returns an AssetError naming the status on a 404, and never throws', async () => {
    const f = stubFetch([{ status: 404 }])
    const d = stubDecode()
    const rec = urlSource('/missing.png', { fetch: f.fetch, createImageBitmap: d.decode })
    const got = await rec.acquire()
    expect(AssetError.is(got)).toBe(true)
    expect(String(got)).toContain('404')
    expect(String(got)).toContain('/missing.png')
    expect(d.calls).toEqual([])
  })

  it('wraps a rejected fetch with its cause', async () => {
    const boom = new TypeError('Failed to fetch')
    const rec = urlSource('/sweater.png', {
      fetch: () => Promise.reject(boom),
      createImageBitmap: stubDecode().decode,
    })
    const got = await rec.acquire()
    expect(AssetError.is(got)).toBe(true)
    expect((got as Error).cause).toBe(boom)
  })

  it('reports an aborted fetch as ABORTED, not as an error', async () => {
    // This is the shape AbortController produces, and P2's `isAborted` is specified over it.
    const rec = urlSource('/sweater.png', {
      fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
      createImageBitmap: stubDecode().decode,
    })
    expect(await rec.acquire()).toBe(ABORTED)
  })

  it('returns ABORTED without issuing a request when the signal has already fired', async () => {
    const f = stubFetch([{}])
    const c = new AbortController()
    c.abort()
    const rec = urlSource('/sweater.png', {
      fetch: f.fetch,
      createImageBitmap: stubDecode().decode,
    })
    expect(await rec.acquire({ signal: c.signal })).toBe(ABORTED)
    expect(f.calls).toEqual([])
  })

  it('passes the signal through to fetch, so the request itself is cancellable', async () => {
    const f = stubFetch([{}])
    const c = new AbortController()
    const rec = urlSource('/sweater.png', {
      fetch: (input, init) => {
        expect(init?.signal).toBe(c.signal)
        return f.fetch(input, init)
      },
      createImageBitmap: stubDecode().decode,
    })
    await rec.acquire({ signal: c.signal })
    expect(f.calls).toHaveLength(1)
  })
})
