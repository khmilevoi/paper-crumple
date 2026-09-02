/**
 * # The amendment-10 seam, end to end (§8.5.1, §18 amendment 10)
 *
 * A re-fetch answered `200` must reach the **real** sheet slot as `replace()` semantics and bust
 * its hull-cache entry, so the new artwork gets its own torn edge rather than the polygon traced
 * from the image the key was registered with. The three parts of that chain are unit-tested
 * separately in three different packages; sync 4 recorded that nothing drove them together, and
 * this file does.
 *
 * **What the chain does on `develop`, read from the source.** `stage.replace()` calls
 * `sheet.release(handle)` before re-sourcing, and `paperSheet`'s `release()` calls
 * `cache.invalidate(handle.spriteKey)` unconditionally, so the hull entry is dropped. The stage
 * never calls `NormalizedSource.resupply()`, so the second request carries no `If-None-Match` and
 * `freshness` is not what drives the invalidation today. **That is pinned below rather than left
 * invisible**, so that the day someone wires `resupply()` into the stage, the assertion that
 * changes is a deliberate edit and not a silent one.
 *
 * The motion slot is a stub: `@paper-crumple/motion` does not resolve from this package and this
 * seam has nothing to do with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlError, isAborted, paperStage } from '@paper-crumple/core'
import type { DrawResult, KnobDescriptor, MotionSource, Rect } from '@paper-crumple/core'
import type { MotionClip, MotionFit } from '@paper-crumple/core/unstable'
import { paperSheet, type PaperSheet } from './sheet.js'
import type { PaperSheetHandle } from './handle.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'

let fixture: PaperGlFixture | null = null
const live: Array<{ dispose(): void }> = []
afterEach(() => {
  vi.unstubAllGlobals()
  while (live.length > 0) live.pop()?.dispose()
  fixture?.dispose()
  fixture = null
})

/** A `MotionSource` that loads nothing and draws nothing. This seam is not about motion. */
function stubMotion(): MotionSource {
  const fit = (rect: Rect): MotionFit =>
    ({
      frontSize: { w: 128, h: 128 },
      sortKey: 'stub',
      rect,
    }) as unknown as MotionFit
  return {
    knobs: [] as readonly KnobDescriptor[],
    mount: () => undefined,
    fit: (rect) => fit(rect),
    load: async () => ({ sortKey: 'stub' }) as unknown as MotionClip,
    draw: () => ({ sortKey: 'stub', frame: 0 }) as DrawResult,
    release: () => {},
    dispose: () => {},
  } as unknown as MotionSource
}

/** Two different opaque squares, so the two responses genuinely carry different bytes. */
async function pngBytes(shift: number): Promise<Uint8Array | Error> {
  const canvas = new OffscreenCanvas(64, 64)
  const c2d = canvas.getContext('2d')
  if (c2d === null) return new GlError('resupply-seam: no 2D context for the fixture')
  c2d.clearRect(0, 0, 64, 64)
  c2d.fillStyle = '#3aa06a'
  // A different silhouette, not merely different colours: the hull is traced from alpha.
  c2d.fillRect(8 + shift, 8, 40 - shift, 48)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

interface Recorded {
  readonly headers: Record<string, string> | undefined
}

/**
 * A `SheetRenderer` that delegates to the real `paperSheet()` and records the handle each
 * `source()` produced, so the test can ask whether the second trace produced the **same polygon
 * object** as the first (a cache hit) or a fresh one (a re-trace). It also records every
 * `release()` call's `spriteKey`, so the test can prove `stage.replace()` actually reached the
 * D3 entry point (`sheet.release(handle)`) that busts the hull cache, rather than inferring it
 * only from the fresh key a brand-new `ImageBitmap` would mint anyway.
 */
function recordingSheet(
  inner: PaperSheet,
): PaperSheet & { readonly handles: PaperSheetHandle[]; readonly releases: string[] } {
  const handles: PaperSheetHandle[] = []
  const releases: string[] = []
  const wrapper = Object.create(inner) as PaperSheet & {
    handles: PaperSheetHandle[]
    releases: string[]
  }
  wrapper.handles = handles
  wrapper.releases = releases
  wrapper.source = async (bitmap, o) => {
    const got = await inner.source(bitmap, o)
    if (!(got instanceof Error) && !isAborted(got)) handles.push(got)
    return got
  }
  wrapper.release = (handle) => {
    releases.push(handle.spriteKey)
    inner.release(handle)
  }
  return wrapper
}

describe("a conditional re-supply answered 200 busts the real slot's hull entry", () => {
  it('re-traces the hull instead of serving the polygon the key was registered with', async () => {
    fixture = createGlFixture(8, 8)
    expect(
      fixture.gl,
      'no WebGL2 context — check the SwiftShader launch flags (§11)',
    ).not.toBeNull()

    const v1 = await pngBytes(0)
    const v2 = await pngBytes(12)
    if (v1 instanceof Error) return expect.fail(v1.message)
    if (v2 instanceof Error) return expect.fail(v2.message)
    expect(Array.from(v1)).not.toEqual(Array.from(v2))

    const seen: Recorded[] = []
    const bodies = [v1, v2]
    // A stub that **does** return ETag and Last-Modified, which is exactly what the existing test
    // named for this amendment does not do.
    vi.stubGlobal('fetch', async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ headers: init?.headers })
      const body = bodies[Math.min(seen.length - 1, bodies.length - 1)]!
      return new Response(body, {
        status: 200,
        headers: {
          ETag: `"v${seen.length}"`,
          'Last-Modified': `Mon, 0${seen.length} Sep 2026 00:00:00 GMT`,
          'Content-Type': 'image/png',
        },
      })
    })

    const inner = paperSheet()
    const sheet = recordingSheet(inner)
    const stage = await paperStage({
      gl: fixture.gl!,
      sheet,
      motion: stubMotion(),
      maxSize: 128,
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail(String(stage))
    live.push(stage)

    const first = await stage.add('/sweater.png', { key: 'sweater' })
    if (first instanceof Error || isAborted(first)) return expect.fail(String(first))

    const again = await stage.replace('sweater', '/sweater.png')
    if (again instanceof Error || isAborted(again)) return expect.fail(String(again))

    expect(seen).toHaveLength(2)
    expect(sheet.handles).toHaveLength(2)
    const [a, b] = sheet.handles as [PaperSheetHandle, PaperSheetHandle]

    // The whole point: the second trace is not the cached polygon. `sheet.gl.test.ts` uses the
    // same identity comparison for the cache-hit case, so this is the negative of that test.
    expect(b.hull).not.toBe(a.hull)

    // The entry point itself was reached: `replace()`'s own D3 comment says `release(handle)` is
    // where the hull entry is busted, so this proves the real slot's `release()` ran against the
    // *first* handle rather than merely that a fresh bitmap minted a fresh key regardless.
    expect(sheet.releases).toContain(a.spriteKey)

    // And the bust actually landed, not merely was attempted: a live entry for `a.spriteKey`
    // would make this call return the dropped-variant count (`sheet.gl.test.ts`'s own
    // `toBeGreaterThan(0)` pattern for a fresh entry); `release()` having already invalidated it
    // makes it 0 — nothing left to drop.
    expect(sheet.invalidateHull(a.spriteKey)).toBe(0)

    // And it says so out loud (§8.5.1: "with a warning naming the key").
    expect(stage.warnings.some((w) => w.message.includes('sweater'))).toBe(true)
  })

  it('pins what the second request actually carried, so the gap is visible rather than assumed', async () => {
    fixture = createGlFixture(8, 8)
    expect(fixture.gl).not.toBeNull()
    const v1 = await pngBytes(0)
    const v2 = await pngBytes(12)
    if (v1 instanceof Error) return expect.fail(v1.message)
    if (v2 instanceof Error) return expect.fail(v2.message)

    const seen: Recorded[] = []
    const bodies = [v1, v2]
    vi.stubGlobal('fetch', async (_input: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ headers: init?.headers })
      const body = bodies[Math.min(seen.length - 1, bodies.length - 1)]!
      return new Response(body, {
        status: 200,
        headers: { ETag: `"v${seen.length}"`, 'Content-Type': 'image/png' },
      })
    })

    const stage = await paperStage({
      gl: fixture.gl!,
      sheet: paperSheet(),
      motion: stubMotion(),
      maxSize: 128,
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail(String(stage))
    live.push(stage)
    const first = await stage.add('/sweater.png', { key: 'sweater' })
    if (first instanceof Error || isAborted(first)) return expect.fail(String(first))
    await stage.replace('sweater', '/sweater.png')

    // **This is the gap, pinned.** `stage.replace()` normalises a fresh source and calls
    // `acquire()`, never `resupply()`, so no conditional request is issued and `SourceFreshness`
    // is not what drives the invalidation today — `sheet.release(handle)` is. The hull is still
    // busted (the case above proves it), so the behaviour is right; the mechanism is not the one
    // §8.5.1 describes. Wiring `resupply()` into the stage is a P9 change and a closeout decision;
    // when it lands, this expectation is a deliberate edit rather than a silent one.
    expect(seen[1]?.headers?.['If-None-Match']).toBeUndefined()
  })
})
