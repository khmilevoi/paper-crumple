import { ABORTED, AssetError, PackError, isAborted } from '@paper-crumple/core'
import { describe, expect, it, vi } from 'vitest'

import { readPackBin } from '../test/packs.js'
import type { Pack } from './pack.js'
import type { PackModule } from './pack-module.js'
import { createPackStore } from './pack-store.js'
import pack2x3 from './packs/2x3.js'
import pack1x1 from './packs/1x1.js'

/** A fetch that answers every request with the bucket named at the end of the URL. */
function bytesFetch(delayMs = 0): { fetch: typeof globalThis.fetch; calls: () => number } {
  let calls = 0
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    calls++
    const url = String(input)
    const bucket = url.slice(url.lastIndexOf('/') + 1).replace('.bin', '')
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    return new Response(readPackBin(bucket), { status: 200 })
  }) as typeof globalThis.fetch
  return { fetch, calls: () => calls }
}

function store(packs: readonly PackModule[], fetch?: typeof globalThis.fetch) {
  return createPackStore({ packs, fetch: fetch ?? bytesFetch().fetch })
}

describe('an unsupplied bucket (§14)', () => {
  it('is an AssetError naming the subpath the consumer forgot to import', async () => {
    const s = store([pack2x3])
    expect(s.has('2x3')).toBe(true)
    expect(s.has('1x1')).toBe(false)
    const r = await s.acquire('1x1')
    expect(AssetError.is(r)).toBe(true)
    expect((r as Error).message).toContain('@paper-crumple/motion/packs/1x1')
  })

  it('takes no reference for a bucket it could not supply', async () => {
    const s = store([pack2x3])
    await s.acquire('1x1')
    expect(s.refs('1x1')).toBe(0)
  })
})

describe('the concurrent-load dedupe (§5.3)', () => {
  it('shares one fetch between two overlapping acquires', async () => {
    const f = bytesFetch(5)
    const s = store([pack2x3], f.fetch)
    const [a, b] = await Promise.all([s.acquire('2x3'), s.acquire('2x3')])
    expect(f.calls()).toBe(1)
    expect(a).toBe(b)
    expect(s.refs('2x3')).toBe(2)
  })

  it('serves a resident pack without fetching again', async () => {
    const f = bytesFetch()
    const s = store([pack2x3], f.fetch)
    await s.acquire('2x3')
    await s.acquire('2x3')
    expect(f.calls()).toBe(1)
    expect(s.refs('2x3')).toBe(2)
  })

  it('caches only success: a failed fetch is retryable', async () => {
    let n = 0
    const fetch = (async (): Promise<Response> => {
      n++
      if (n === 1) return new Response('nope', { status: 503 })
      return new Response(readPackBin('2x3'), { status: 200 })
    }) as typeof globalThis.fetch
    const s = store([pack2x3], fetch)
    expect(AssetError.is(await s.acquire('2x3'))).toBe(true)
    expect(s.refs('2x3')).toBe(0)
    expect(await s.acquire('2x3')).not.toBeInstanceOf(Error)
    expect(n).toBe(2)
  })

  it('returns the parser error when the bytes are not a pack', async () => {
    const fetch = (async (): Promise<Response> =>
      new Response(new ArrayBuffer(64), { status: 200 })) as typeof globalThis.fetch
    const s = store([pack2x3], fetch)
    expect(PackError.is(await s.acquire('2x3'))).toBe(true)
  })
})

describe('abort (§10.5, §18 amendment 1)', () => {
  it('returns the ABORTED sentinel and not an Error', async () => {
    const ac = new AbortController()
    ac.abort()
    const s = store([pack2x3])
    const r = await s.acquire('2x3', { signal: ac.signal })
    expect(r).toBe(ABORTED)
    expect(isAborted(r)).toBe(true)
    expect(r).not.toBeInstanceOf(Error)
  })

  it('takes no reference when it aborts, so no release is owed', async () => {
    const ac = new AbortController()
    ac.abort()
    const s = store([pack2x3])
    await s.acquire('2x3', { signal: ac.signal })
    expect(s.refs('2x3')).toBe(0)
  })

  it('never cancels the shared fetch: the other caller still gets its pack', async () => {
    const f = bytesFetch(10)
    const s = store([pack2x3], f.fetch)
    const ac = new AbortController()
    const cancelled = s.acquire('2x3', { signal: ac.signal })
    const survivor = s.acquire('2x3')
    ac.abort()
    expect(await cancelled).toBe(ABORTED)
    expect(await survivor).not.toBeInstanceOf(Error)
    expect(f.calls()).toBe(1)
    expect(s.refs('2x3')).toBe(1)
  })

  it('keeps the pack resident after an abort, so the scroll coming back is free', async () => {
    const f = bytesFetch(10)
    const s = store([pack2x3], f.fetch)
    const ac = new AbortController()
    const p = s.acquire('2x3', { signal: ac.signal })
    ac.abort()
    expect(await p).toBe(ABORTED)
    expect(await s.acquire('2x3')).not.toBeInstanceOf(Error)
    expect(f.calls()).toBe(1)
  })
})

describe('the refcount', () => {
  it('evicts at zero and re-fetches afterwards', async () => {
    const f = bytesFetch()
    const s = store([pack2x3], f.fetch)
    const evicted: string[] = []
    s.onEvict((bucket) => evicted.push(bucket))
    await s.acquire('2x3')
    await s.acquire('2x3')
    s.release('2x3')
    expect(evicted).toEqual([])
    expect(s.get('2x3')).toBeDefined()
    s.release('2x3')
    expect(evicted).toEqual(['2x3'])
    expect(s.get('2x3')).toBeUndefined()
    await s.acquire('2x3')
    expect(f.calls()).toBe(2)
  })

  it('ignores a release for a bucket it does not hold', () => {
    const s = store([pack2x3])
    expect(() => {
      s.release('2x3')
      s.release('1x1')
    }).not.toThrow()
    expect(s.refs('2x3')).toBe(0)
  })

  it('holds two buckets independently', async () => {
    const s = store([pack2x3, pack1x1])
    const a = (await s.acquire('2x3')) as Pack
    const b = (await s.acquire('1x1')) as Pack
    expect(a.bucket).toBe('2x3')
    expect(b.bucket).toBe('1x1')
    expect(s.refs('2x3')).toBe(1)
    expect(s.refs('1x1')).toBe(1)
  })

  it('evicts everything on dispose', async () => {
    const s = store([pack2x3, pack1x1])
    const evicted: string[] = []
    s.onEvict((bucket) => evicted.push(bucket))
    await s.acquire('2x3')
    await s.acquire('1x1')
    s.dispose()
    expect(evicted.sort()).toEqual(['1x1', '2x3'])
    expect(s.get('2x3')).toBeUndefined()
    expect(s.refs('1x1')).toBe(0)
  })

  it('does not resurrect a pack if in-flight fetch completes after dispose', async () => {
    const f = bytesFetch(20)
    const s = store([pack2x3], f.fetch)
    const inFlight = s.acquire('2x3')
    s.dispose()
    await inFlight
    expect(s.get('2x3')).toBeUndefined()
    expect(s.refs('2x3')).toBe(0)
  })
})

describe('the fetch itself (§14)', () => {
  it('never passes cache: no-store — a per-bucket pack is what a cache should keep', async () => {
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.cache).toBeUndefined()
      return new Response(readPackBin('2x3'), { status: 200 })
    })
    const s = store([pack2x3], spy as unknown as typeof globalThis.fetch)
    await s.acquire('2x3')
    expect(spy).toHaveBeenCalledOnce()
  })

  it('fetches binUrl and never manifest.bin resolved against anything', async () => {
    let seen = ''
    const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      seen = String(input)
      return new Response(readPackBin('2x3'), { status: 200 })
    }) as typeof globalThis.fetch
    const s = store([pack2x3], fetch)
    await s.acquire('2x3')
    expect(seen).toBe(String(pack2x3.binUrl))
  })
})
