/**
 * # P7 — `source()` waits for the deferred program link (spec 5.2 amendment)
 *
 * `mount()` issues the paper program's compile and link and returns without reading
 * `LINK_STATUS`; on a driver with `KHR_parallel_shader_compile` that read would have frozen the
 * page for the whole HLSL compile (`report-hang-repro.md`). The link's outcome is
 * `Program.ready()`'s, and `paperSheet`'s `source()` awaits it at its start, so:
 *
 *   - a `source()` issued before the link completes resolves only after it, and two such calls
 *     resolve in call order;
 *   - a link failure is the first `source()`'s error value — a `GlError` with the message the
 *     synchronous `mount()` used to return — and `mount()` itself has succeeded;
 *   - `build()` never meets a pending program, because it needs a handle from a `source()` that
 *     passed the wait.
 *
 * SwiftShader does not offer the extension in the level-2 launch (its link is synchronous and
 * takes milliseconds), so the wait is driven from the test: the context's `program()` is wrapped
 * to hand the sheet a `Program` whose `ready()` is a promise the test settles. Everything else —
 * the real renderer, resampler, fields and front — runs as shipped.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import type { CoreGlContext, Program } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { defaultsFor } from './paper-knobs.js'
import { paperSheet } from './sheet.js'

let fixture: PaperGlFixture | null = null

afterEach(() => {
  fixture?.dispose()
  fixture = null
})

function open(): CoreGlContext {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture.ctx
}

interface Deferred {
  readonly promise: Promise<InstanceType<typeof GlError> | undefined>
  resolve(outcome: InstanceType<typeof GlError> | undefined): void
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve']
  const promise = new Promise<InstanceType<typeof GlError> | undefined>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * The same context, with the program labelled `label` handed back with `ready()` replaced by the
 * test's own promise — the shape a driver with the extension produces while its link is still
 * running. `CoreGlContext` is a bag of closures over one `gl`, so a spread with one method
 * replaced is the same context (see `paper-shader-early-out.gl.test.ts`'s `withPaperShader`).
 */
function withPendingLink(ctx: CoreGlContext, label: string, link: Deferred): CoreGlContext {
  return {
    ...ctx,
    program: (vs, fs, l) => {
      const program = ctx.program(vs, fs, l)
      if (GlError.is(program) || l !== label) return program
      const pending: Program = { ...program, ready: () => link.promise }
      return pending
    },
  }
}

/** A 48x32 sprite: an opaque ellipse, clear of the edges (as `sheet.gl.test.ts`'s). */
async function sprite(w = 48, h = 32): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = ((x - w / 2) / (w / 3)) ** 2 + ((y - h / 2) / (h / 3)) ** 2 <= 1
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 120
      data[p + 2] = 60
      data[p + 3] = inside ? 255 : 0
    }
  }
  return createImageBitmap(new ImageData(data, w, h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

/** A few macrotasks, so anything that was going to settle has had every chance to. */
async function turns(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0))
}

describe('source() and the deferred paper program link (P7, spec 5.2 amendment)', () => {
  it('resolves a source() issued before the link completes only after it, two of them in call order', async () => {
    const link = deferred()
    const ctx = withPendingLink(open(), 'paper', link)
    const sheet = paperSheet()
    // mount() succeeds without waiting for the driver.
    expect(sheet.mount(ctx)).toBeUndefined()

    // Two sprites of one size, as a grid of tiles is: they share the scratch pools. (Two
    // concurrent source() calls of DIFFERENT sizes re-size the pools under each other, before
    // P7 as after it; the stage never issues that pair.)
    const a = await sprite()
    const b = await sprite()
    const settled: string[] = []
    const first = sheet.source(a, { maxSize: 128, exact: false }).then((r) => {
      settled.push('first')
      return r
    })
    const second = sheet.source(b, { maxSize: 128, exact: false }).then((r) => {
      settled.push('second')
      return r
    })
    await turns()
    expect(settled).toEqual([])

    link.resolve(undefined)
    const [r1, r2] = await Promise.all([first, second])
    expect(settled).toEqual(['first', 'second'])
    expect(r1 instanceof Error || isAborted(r1)).toBe(false)
    expect(r2 instanceof Error || isAborted(r2)).toBe(false)
    if (r1 instanceof Error || isAborted(r1) || r2 instanceof Error || isAborted(r2)) return
    // build() after the wait finds a linked program: the front renders.
    const front = sheet.build(r2, { w: 128, h: 128 }, defaultsFor('hull') as never)
    expect(front).not.toBeInstanceOf(Error)
    if (!(front instanceof Error)) sheet.releaseFront(front)
    sheet.release(r1)
    sheet.release(r2)
    a.close()
    b.close()
    sheet.dispose()
  }, 60_000)

  it('delivers a link failure as the first source() error value, after a mount() that succeeded', async () => {
    const link = deferred()
    const ctx = withPendingLink(open(), 'paper', link)
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()

    const a = await sprite()
    const pending = sheet.source(a, { maxSize: 128, exact: false })
    const failure = new GlError('paper: program did not link: (driver log)')
    link.resolve(failure)
    const r = await pending
    expect(GlError.is(r)).toBe(true)
    expect(r).toBe(failure)
    // And the next source() reports the same, rather than building on a program that never linked.
    const again = await sheet.source(a, { maxSize: 128, exact: false })
    expect(again).toBe(failure)
    a.close()
    sheet.dispose()
  }, 60_000)

  it('reports a dispose() that ran during the wait as a SheetError, not a throw', async () => {
    const link = deferred()
    const ctx = withPendingLink(open(), 'paper', link)
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const a = await sprite()
    const pending = sheet.source(a, { maxSize: 128, exact: false })
    await turns()
    sheet.dispose()
    link.resolve(undefined)
    const r = await pending
    expect(SheetError.is(r)).toBe(true)
    expect((r as Error).message).toContain('dispose()')
    a.close()
  }, 60_000)

  it('returns ABORTED the moment the signal fires, without waiting for the link, and leaves the link to the next caller', async () => {
    const link = deferred()
    const ctx = withPendingLink(open(), 'paper', link)
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const a = await sprite()
    const controller = new AbortController()
    const pending = sheet.source(a, { maxSize: 128, exact: false, signal: controller.signal })
    await turns()
    controller.abort()
    // The fake link is still pending: a superseded swap or a dispose() must not hold the ingest
    // lane's slot for the rest of a 2-3 s D3D11 compile.
    expect(isAborted(await pending)).toBe(true)
    // The wait left nothing on the signal, and the shared link still serves the next source().
    link.resolve(undefined)
    const next = await sheet.source(a, { maxSize: 128, exact: false })
    expect(next instanceof Error || isAborted(next)).toBe(false)
    if (!(next instanceof Error) && !isAborted(next)) sheet.release(next)
    a.close()
    sheet.dispose()
  }, 60_000)

  it('honours a signal already aborted when source() is called, before any wait', async () => {
    const link = deferred()
    const ctx = withPendingLink(open(), 'paper', link)
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const a = await sprite()
    const controller = new AbortController()
    controller.abort()
    expect(
      isAborted(await sheet.source(a, { maxSize: 128, exact: false, signal: controller.signal })),
    ).toBe(true)
    a.close()
    sheet.dispose()
  }, 60_000)
})
