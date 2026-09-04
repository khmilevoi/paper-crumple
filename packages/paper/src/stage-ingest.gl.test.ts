/**
 * # The ingest lane against the real sheet (spec §8.10)
 *
 * The research memo's §1.3 probe, promoted into a test and driven through the public API. Two
 * same-size `source()` calls interleaved at the microtask level share Pool A's one artwork slot
 * and one tight-field slot (§8.1): the first caller's hull rect came back as the second's, and its
 * `build()` answered `SourceExpiredError`. At stage level that was 29 of 30 concurrent `add()`s
 * resolving to a `SheetError` and a silently wrong hull on the one that did not. The lane holds
 * at most one sprite between `source()` and `build()`, so thirty adds through `Promise.all`
 * succeed with the rects a sequential run would give.
 *
 * Core cannot import paper, so this level-2 pin lives here. The motion slot is a stub, as in
 * `resupply-seam.gl.test.ts`: the hazard is the sheet's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { isAborted, paperStage } from '@paper-crumple/core'
import type { DrawResult, KnobDescriptor, MotionSource, Rect, Sprite } from '@paper-crumple/core'
import type { MotionClip, MotionFit } from '@paper-crumple/core/unstable'
import { paperSheet } from './sheet.js'

const live: Array<{ dispose(): void }> = []
afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

/** A `MotionSource` that loads nothing and draws nothing. */
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
    fit: (rect: Rect) => fit(rect),
    load: async () => ({ sortKey: 'stub' }) as unknown as MotionClip,
    draw: () => ({ sortKey: 'stub', frame: 0 }) as DrawResult,
    release: () => {},
    dispose: () => {},
  } as unknown as MotionSource
}

/** Two silhouettes at one size: a big ellipse and a small centred square (the memo's probe). */
async function shape(kind: 'ellipse' | 'square', w: number, h = w): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside =
        kind === 'ellipse'
          ? ((x - w / 2) / (w / 2.2)) ** 2 + ((y - h / 2) / (h / 2.2)) ** 2 <= 1
          : Math.abs(x - w / 2) < w / 8 && Math.abs(y - h / 2) < h / 8
      const p = (y * w + x) * 4
      data[p] = 200
      data[p + 1] = 120
      data[p + 2] = 60
      data[p + 3] = inside ? 255 : 0
    }
  }
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d')!.putImageData(new ImageData(data, w, h), 0, 0)
  return createImageBitmap(canvas, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

describe('the ingest lane against paperSheet (spec §8.10)', () => {
  it('30 concurrent bitmap adds on a real sheet all succeed with distinct hull rects', async () => {
    const stage = await paperStage({
      sheet: paperSheet(),
      motion: stubMotion(),
      maxSize: 128,
      present: 'blit',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    live.push(stage)
    const bitmaps = await Promise.all(
      Array.from({ length: 30 }, (_, i) => shape(i % 2 ? 'square' : 'ellipse', 96 - (i % 5))),
    )
    const results = await Promise.all(
      bitmaps.map((b, i) => stage.add(b, { key: `k${String(i)}`, pin: true })),
    )
    expect(results.filter((r) => r instanceof Error).map((e) => (e as Error).message)).toEqual([])
    // 2 shapes x 5 sizes: every sprite got the rect its own silhouette traces, none its neighbour's.
    expect(new Set(results.map((r) => JSON.stringify((r as Sprite).rect))).size).toBe(10)
  })
})
