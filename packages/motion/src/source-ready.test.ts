/**
 * P7 (spec 5.2 amendment) — `load()` waits for the sheet program's deferred link.
 *
 * `mount()` issues the compile and link without reading a status; on a driver with
 * `KHR_parallel_shader_compile` the outcome is `Program.ready()`'s. `load()` is the slot's
 * asynchronous path, so it awaits that outcome before the program's first use, and a failed link
 * reaches `load()`'s result as an `AssetError` whose `cause` is the `GlError` — `LoadError` has no
 * slot for a `GlError` (spec 5.3). The driver is a stand-in whose `program()` answers with a
 * `Program` of the test's choosing; nothing is rendered.
 */
import { AssetError, GlError, isAborted } from '@paper-crumple/core'
import type { GlContext, Program, Texture } from '@paper-crumple/core/unstable'
import { describe, expect, it } from 'vitest'

import { readPackBin } from '../test/packs.js'
import pack2x3 from './packs/2x3.js'
import { bakedMotion, type BakedFit } from './source.js'

function bytesFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    const bucket = url.slice(url.lastIndexOf('/') + 1).replace('.bin', '')
    return new Response(readPackBin(bucket), { status: 200 })
  }) as typeof globalThis.fetch
}

type LinkOutcome = InstanceType<typeof GlError> | undefined

/**
 * A `GlContext` whose `program()` hands back a program whose `ready()` is `link` — an outcome, or
 * a promise the test settles itself. The `gl` answers every enum with a number and every call
 * with nothing, which is all `mount()`'s fibre upload asks of it.
 */
function fakeContext(link: LinkOutcome | Promise<LinkOutcome>): {
  readonly ctx: GlContext
  readonly calls: { ready: number }
} {
  const calls = { ready: 0 }
  const linkOutcome = link instanceof Promise ? link : Promise.resolve(link)
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return 1
      return () => undefined
    },
  }) as unknown as WebGL2RenderingContext
  const program: Program = {
    handle: {} as WebGLProgram,
    label: 'sheet',
    uniformLocation: () => null,
    ready() {
      calls.ready += 1
      return linkOutcome
    },
    dispose() {},
  }
  const ctx: GlContext = {
    caps: { floatRT: true, maxTextureSize: 4096, timer: false },
    exactByteFetch: true,
    program: () => program,
    texture: (d) => {
      const texture: Texture = {
        handle: {} as WebGLTexture,
        width: d.width,
        height: d.height,
        format: d.format,
        bytes: d.width * d.height * 4,
        label: d.label ?? d.format,
        dispose() {},
      }
      return texture
    },
    target: () => new GlError('fake: no targets here'),
    scope: (fn) => fn({ bindTarget() {}, enable() {} }),
    gl,
  }
  return { ctx, calls }
}

function fitFor(source: ReturnType<typeof bakedMotion>): BakedFit {
  const f = source.fit({ x: 0, y: 0, w: 256, h: 384 })
  expect(f).not.toBeInstanceOf(Error)
  return f as BakedFit
}

describe('load() and the deferred sheet program link (P7, spec 5.2 amendment)', () => {
  it('delivers a link failure as an AssetError whose cause is the GlError, after a mount() that succeeded', async () => {
    const failure = new GlError('sheet: fragment shader did not compile: (driver log)')
    const { ctx, calls } = fakeContext(failure)
    const source = bakedMotion({ packs: [pack2x3], fetch: bytesFetch() })
    expect(source.mount(ctx)).toBeUndefined()

    const r = await source.load(fitFor(source))
    expect(AssetError.is(r)).toBe(true)
    if (!AssetError.is(r)) return
    expect(r.message).toBe('bakedMotion: the sheet program did not link')
    expect(r.cause).toBe(failure)
    expect(calls.ready).toBe(1)
    // No clip was handed out, so the next load() reports it again rather than drawing with a
    // program that never linked.
    const again = await source.load(fitFor(source))
    expect(AssetError.is(again)).toBe(true)
    source.dispose()
  })

  it('resolves the clip once the program has linked', async () => {
    const { ctx, calls } = fakeContext(undefined)
    const source = bakedMotion({ packs: [pack2x3], fetch: bytesFetch() })
    expect(source.mount(ctx)).toBeUndefined()
    const clip = await source.load(fitFor(source))
    expect(clip instanceof Error || isAborted(clip)).toBe(false)
    expect(calls.ready).toBe(1)
    source.dispose()
  })

  it('resolves ABORTED the moment the signal fires while the link is still pending, and the next load() succeeds once it links', async () => {
    let settleLink!: (outcome: LinkOutcome) => void
    let linkSettled = false
    const link = new Promise<LinkOutcome>((resolve) => {
      settleLink = (outcome) => {
        linkSettled = true
        resolve(outcome)
      }
    })
    const { ctx, calls } = fakeContext(link)
    const source = bakedMotion({ packs: [pack2x3], fetch: bytesFetch() })
    expect(source.mount(ctx)).toBeUndefined()
    const controller = new AbortController()
    const pending = source.load(fitFor(source), { signal: controller.signal })
    // Let the pack fetch resolve and load() reach the readiness wait; the link stays pending.
    await new Promise<void>((r) => setTimeout(r, 20))
    expect(calls.ready).toBe(1)
    expect(linkSettled).toBe(false)
    controller.abort()
    const r = await pending
    expect(isAborted(r)).toBe(true)
    expect(linkSettled).toBe(false)
    // The shared link was left alone; once it settles, the next load() hands the clip out.
    settleLink(undefined)
    const clip = await source.load(fitFor(source))
    expect(clip instanceof Error || isAborted(clip)).toBe(false)
    source.dispose()
  })

  it('honours a signal already aborted at the call', async () => {
    const { ctx } = fakeContext(undefined)
    const source = bakedMotion({ packs: [pack2x3], fetch: bytesFetch() })
    expect(source.mount(ctx)).toBeUndefined()
    const controller = new AbortController()
    controller.abort()
    expect(isAborted(await source.load(fitFor(source), { signal: controller.signal }))).toBe(true)
    source.dispose()
  })

  it('waits on no program before mount(): load() is pure and the clip is handed out', async () => {
    const source = bakedMotion({ packs: [pack2x3], fetch: bytesFetch() })
    const clip = await source.load(fitFor(source))
    expect(clip instanceof Error || isAborted(clip)).toBe(false)
    source.dispose()
  })
})
