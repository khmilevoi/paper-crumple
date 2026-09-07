import { AssetError, PackError } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import { loadPack } from './load.js'
import { readTinyBin, readTinyManifest } from '../test/fixture.js'

/** A fetch that answers exactly one URL with the fixture bytes. */
function stubFetch(answer: (url: string) => Response | Promise<Response>): {
  fn: typeof globalThis.fetch
  calls: string[]
  init: (RequestInit | undefined)[]
} {
  const calls: string[] = []
  const init: (RequestInit | undefined)[] = []
  const fn = (async (input: RequestInfo | URL, o?: RequestInit): Promise<Response> => {
    calls.push(String(input))
    init.push(o)
    return answer(String(input))
  }) as typeof globalThis.fetch
  return { fn, calls, init }
}

const ok = (): Response => new Response(readTinyBin(), { status: 200 })

describe('loadPack', () => {
  it('fetches exactly the binUrl it was given and parses the result', async () => {
    const stub = stubFetch(ok)
    const pack = await loadPack({
      manifest: readTinyManifest(),
      binUrl: 'https://cdn.example/assets/tiny.a1b2c3.bin',
      fetch: stub.fn,
    })
    expect(pack).not.toBeInstanceOf(Error)
    if (pack instanceof Error) return
    expect(pack.vertexCount).toBe(9)
    expect(stub.calls).toEqual(['https://cdn.example/assets/tiny.a1b2c3.bin'])
  })

  it('never resolves manifest.bin, so a stale name in the manifest cannot 404 the load', async () => {
    const stub = stubFetch(ok)
    const manifest = { ...(readTinyManifest() as object), bin: 'not-the-hashed-name.bin' }
    const pack = await loadPack({
      manifest,
      binUrl: 'https://cdn.example/assets/tiny.a1b2c3.bin',
      fetch: stub.fn,
    })
    expect(PackError.is(pack)).toBe(false)
    expect(stub.calls).toEqual(['https://cdn.example/assets/tiny.a1b2c3.bin'])
  })

  it('accepts a URL object as well as a string', async () => {
    const stub = stubFetch(ok)
    await loadPack({
      manifest: readTinyManifest(),
      binUrl: new URL('https://cdn.example/x/tiny.bin'),
      fetch: stub.fn,
    })
    expect(stub.calls).toEqual(['https://cdn.example/x/tiny.bin'])
  })

  it('never passes cache: no-store — a per-bucket pack is exactly what a cache should keep', async () => {
    const stub = stubFetch(ok)
    await loadPack({ manifest: readTinyManifest(), binUrl: 'https://x/tiny.bin', fetch: stub.fn })
    expect(stub.init[0]?.cache).toBeUndefined()
  })

  it('is an AssetError when the transport fails', async () => {
    const stub = stubFetch(() => Promise.reject(new TypeError('network down')))
    const e = await loadPack({
      manifest: readTinyManifest(),
      binUrl: 'https://x/t.bin',
      fetch: stub.fn,
    })
    expect(AssetError.is(e)).toBe(true)
    expect(String((e as Error).message)).toMatch(/https:\/\/x\/t\.bin/)
  })

  it('is an AssetError on a non-2xx response, naming the status', async () => {
    const stub = stubFetch(() => new Response('nope', { status: 404 }))
    const e = await loadPack({
      manifest: readTinyManifest(),
      binUrl: 'https://x/t.bin',
      fetch: stub.fn,
    })
    expect(AssetError.is(e)).toBe(true)
    expect(String((e as Error).message)).toMatch(/404/)
  })

  it('is a PackError when the bytes arrive but do not parse', async () => {
    const stub = stubFetch(() => new Response(new ArrayBuffer(320), { status: 200 }))
    const e = await loadPack({
      manifest: readTinyManifest(),
      binUrl: 'https://x/t.bin',
      fetch: stub.fn,
    })
    expect(PackError.is(e)).toBe(true)
  })

  it('resolves to an Error and never rejects', async () => {
    const stub = stubFetch(() => Promise.reject(new Error('boom')))
    await expect(
      loadPack({ manifest: readTinyManifest(), binUrl: 'https://x/t.bin', fetch: stub.fn }),
    ).resolves.toBeInstanceOf(Error)
  })
})
