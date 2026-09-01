import { describe, expect, it } from 'vitest'
import { ABORTED, isAborted } from './abort.js'
import { AssetError } from './errors.js'
import { readValidator, staleSourceWarning, urlSource } from './source.js'
import { asBitmap, blobOf, deferredDecode, stubDecode, stubFetch } from './testing/fake-source.js'

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
    expect(d.produced[0].closes).toBe(0)
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

/**
 * Acquires once against a scripted first response, then leaves the rest for the re-supply.
 *
 * It asserts rather than throwing on a bad setup: §10.8's ban on `ThrowStatement` is
 * repository-wide and applies to test sources exactly as it applies to `src/`.
 */
const armed = async (script: Parameters<typeof stubFetch>[0]) => {
  const f = stubFetch(script)
  const d = stubDecode()
  const rec = urlSource('/sweater.png', { fetch: f.fetch, createImageBitmap: d.decode })
  const first = await rec.acquire()
  expect(first).not.toBeInstanceOf(Error)
  expect(isAborted(first)).toBe(false)
  return { f, d, rec }
}

describe('the conditional re-supply (§8.5.1, amendment 10)', () => {
  it('issues If-None-Match when an ETag was recorded', async () => {
    const { f, rec } = await armed([{ headers: { ETag: 'W/"v1"' } }, { status: 304 }])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    await rec.resupply({ key: 'sweater' })
    expect(f.calls[1]).toEqual({ input: '/sweater.png', headers: { 'If-None-Match': 'W/"v1"' } })
  })

  it('issues If-Modified-Since when only a Last-Modified was recorded', async () => {
    const when = 'Wed, 26 Aug 2026 10:00:00 GMT'
    const { f, rec } = await armed([{ headers: { 'Last-Modified': when } }, { status: 304 }])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    await rec.resupply({ key: 'sweater' })
    expect(f.calls[1].headers).toEqual({ 'If-Modified-Since': when })
  })

  it('issues both when both were recorded', async () => {
    const when = 'Wed, 26 Aug 2026 10:00:00 GMT'
    const { f, rec } = await armed([
      { headers: { ETag: '"v1"', 'Last-Modified': when } },
      { status: 304 },
    ])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    await rec.resupply({ key: 'sweater' })
    expect(f.calls[1].headers).toEqual({ 'If-None-Match': '"v1"', 'If-Modified-Since': when })
  })

  it('304 means unchanged, and the rebuild decodes the retained bytes (§8.5.3)', async () => {
    const body = blobOf('sweater-v1')
    const { f, d, rec } = await armed([{ headers: { ETag: '"v1"' }, body }, { status: 304 }])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    const r = await rec.resupply({ key: 'sweater' })
    if (r instanceof Error || isAborted(r)) return expect.fail('expected a report')
    expect(r.freshness).toBe('unchanged')
    expect(r.warning).toBeUndefined()
    expect(r.owned).toBe(true)
    // A 304 has no body by definition, so the retained bytes are what is decoded. The stub records
    // every body it actually handed out: exactly one, from the first response.
    expect(d.calls).toEqual([body, body])
    expect(f.bodies).toEqual([body])
  })

  it('200 means the bytes moved: changed, with the warning naming the key', async () => {
    const v1 = blobOf('sweater-v1')
    const v2 = blobOf('sweater-v2')
    const { d, rec } = await armed([
      { headers: { ETag: '"v1"' }, body: v1 },
      { status: 200, headers: { ETag: '"v2"' }, body: v2 },
    ])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    const r = await rec.resupply({ key: 'sweater' })
    if (r instanceof Error || isAborted(r)) return expect.fail('expected a report')
    expect(r.freshness).toBe('changed')
    expect(r.warning).toBe(staleSourceWarning('sweater', '/sweater.png'))
    expect(d.calls).toEqual([v1, v2])
  })

  it('re-records the validator from the 200, so the next request is conditional on the new one', async () => {
    const { f, rec } = await armed([
      { headers: { ETag: '"v1"' } },
      { status: 200, headers: { ETag: '"v2"' } },
      { status: 304 },
    ])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    await rec.resupply({ key: 'sweater' })
    await rec.resupply({ key: 'sweater' })
    expect(f.calls[1].headers).toEqual({ 'If-None-Match': '"v1"' })
    expect(f.calls[2].headers).toEqual({ 'If-None-Match': '"v2"' })
  })

  it('does not advance the validator through an attempt aborted mid-decode (§8.5.1)', async () => {
    // A re-supply that received a 200: if the validator advanced before the decode settled, an
    // abort firing mid-decode would lose the `changed` report for good — the next re-supply would
    // ask about the *new* bytes with `If-None-Match` and be answered 304, "unchanged".
    const f = stubFetch([
      { headers: { ETag: '"v1"' } },
      { status: 200, headers: { ETag: '"v2"' } },
      { status: 200, headers: { ETag: '"v2"' } },
    ])
    const d = deferredDecode()
    const rec = urlSource('/sweater.png', { fetch: f.fetch, createImageBitmap: d.decode })
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')

    // `deferredDecode` defers every call, so the first acquire needs releasing too.
    const first = rec.acquire()
    while (d.calls.length < 1) await Promise.resolve()
    d.release()
    const acquired = await first
    expect(acquired).not.toBeInstanceOf(Error)
    expect(isAborted(acquired)).toBe(false)

    // The second re-supply gets the 200 that would advance the validator to "v2" — then the
    // signal fires while the decode is still pending.
    const c = new AbortController()
    const aborted = rec.resupply({ key: 'sweater', signal: c.signal })
    while (d.calls.length < 2) await Promise.resolve()
    c.abort()
    d.release()
    expect(await aborted).toBe(ABORTED)

    // A third re-supply must still ask about "v1": the aborted attempt never committed "v2".
    const third = rec.resupply({ key: 'sweater' })
    while (d.calls.length < 3) await Promise.resolve()
    d.release()
    const r = await third
    if (r instanceof Error || isAborted(r)) return expect.fail('expected a report')
    expect(f.calls[2].headers).toEqual({ 'If-None-Match': '"v1"' })
    expect(r.freshness).toBe('changed')
  })

  it('a cross-origin response with both headers withheld re-supplies unverified', async () => {
    // Documented and unenforced (§8.5.1): the re-supply proceeds, nothing is asked, and a changed
    // image keeps the old hull. The honest report is `unverified`, never `unchanged`.
    const { f, rec } = await armed([
      { headers: { 'Content-Type': 'image/png' } },
      { headers: { 'Content-Type': 'image/png' } },
    ])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    const r = await rec.resupply({ key: 'sweater' })
    if (r instanceof Error || isAborted(r)) return expect.fail('expected a report')
    expect(r.freshness).toBe('unverified')
    expect(r.warning).toBeUndefined()
    expect(r.owned).toBe(true)
    // No conditional headers, because there was nothing to be conditional on.
    expect(f.calls[1].headers).toEqual({})
  })

  it('an empty ETag is treated as absent: re-supplies unverified with no If-None-Match', async () => {
    // `ETag: ''` is not the same as the header being withheld, but sending `If-None-Match: ''`
    // back would be an invalid conditional request. Blank is absent.
    const { f, rec } = await armed([{ headers: { ETag: '' } }, {}])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    const r = await rec.resupply({ key: 'sweater' })
    if (r instanceof Error || isAborted(r)) return expect.fail('expected a report')
    expect(r.freshness).toBe('unverified')
    expect(r.warning).toBeUndefined()
    expect(f.calls[1].headers).toEqual({})
  })

  it('returns an AssetError when the conditional request fails outright', async () => {
    const { rec } = await armed([{ headers: { ETag: '"v1"' } }, { status: 500 }])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    const r = await rec.resupply({ key: 'sweater' })
    expect(AssetError.is(r)).toBe(true)
    expect(String(r)).toContain('500')
  })

  it('returns ABORTED without issuing the conditional request when the signal fired', async () => {
    const { f, rec } = await armed([{ headers: { ETag: '"v1"' } }])
    if (rec.resupply === undefined) return expect.fail('a url source is reclaimable')
    const c = new AbortController()
    c.abort()
    expect(await rec.resupply({ key: 'sweater', signal: c.signal })).toBe(ABORTED)
    expect(f.calls).toHaveLength(1)
  })
})

describe('staleSourceWarning', () => {
  it('names the key and the source, because a warning nobody can act on is noise', () => {
    const w = staleSourceWarning('sweater', 'https://cdn.example/sweater.png')
    expect(w).toContain('sweater')
    expect(w).toContain('https://cdn.example/sweater.png')
  })
})
