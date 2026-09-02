/**
 * # The managed destination (§4.0.1, §18 amendment 13)
 *
 * Every other level-2 assertion in this run reads a framebuffer the test owns, so the managed
 * backing store cannot reach one. That argument is true and it is not enough: a headless page gives
 * a `<canvas>` a zero or arbitrary CSS size, so the rule gets its **own** cases here rather than
 * being left to leak into someone else's fixture.
 *
 * Fake slots, deliberately. The destination rule has nothing to do with which slot rendered — it is
 * about `canvas.width`, `canvas.height` and what `clearRect` left behind.
 *
 * Sources are real, decodable bitmaps built from raw `ImageData`, never from a Blob of arbitrary
 * bytes and never through an `OffscreenCanvas` `putImageData` round trip (Chromium's 2D canvas
 * stores premultiplied and zeroes RGB under zero alpha before the library sees it). `fakeSheet()`'s
 * `source()` derives the front size from `bitmap.width`/`bitmap.height`, so two differently-shaped
 * bitmaps are what gives the "wide" and "narrow" case below two different aspect ratios — a plain
 * `Blob` of arbitrary bytes would fail real decode before the rule under test ever ran, and
 * `fake-slots.ts` is P9's shared fixture and is not edited here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { paperStage } from './stage.js'
import { fakeMotion, fakeSheet } from './testing/fake-slots.js'

const live: Array<{ dispose(): void }> = []
const elements: HTMLCanvasElement[] = []
afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
  for (const el of elements.splice(0)) el.remove()
})

function tile(css: { w: number; h: number } | null): HTMLCanvasElement {
  const el = document.createElement('canvas')
  if (css === null) {
    el.style.display = 'none'
  } else {
    el.style.width = `${css.w}px`
    el.style.height = `${css.h}px`
  }
  document.body.append(el)
  elements.push(el)
  return el
}

/** A real, decodable bitmap of the given size and solid colour — never a Blob of arbitrary bytes. */
async function solidBitmap(
  w: number,
  h: number,
  rgba: readonly [number, number, number, number],
): Promise<ImageBitmap> {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i += 1) {
    data[i * 4] = rgba[0]
    data[i * 4 + 1] = rgba[1]
    data[i * 4 + 2] = rgba[2]
    data[i * 4 + 3] = rgba[3]
  }
  return createImageBitmap(new ImageData(data, w, h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

/** A `BitmapSupplier` (reclaimable by the caller's own promise) minting a fresh solid bitmap. */
function solidSource(
  w: number,
  h: number,
  rgba: readonly [number, number, number, number] = [255, 0, 0, 255],
) {
  return () => solidBitmap(w, h, rgba)
}

async function blitStage(maxSize: number) {
  const stage = await paperStage({
    sheet: fakeSheet(),
    motion: fakeMotion(),
    maxSize,
    present: 'blit',
  })
  if (stage instanceof Error || isAborted(stage)) return null
  live.push(stage)
  return stage
}

describe("size: 'managed' — the default (§4.0.1)", () => {
  it('sizes a destination with a real CSS size to round(css x dpr), capped at the front', async () => {
    const stage = await blitStage(256)
    if (stage === null) return expect.fail('stage refused')
    const el = tile({ w: 96, h: 96 })
    // Stock backing store before anything touches it.
    expect([el.width, el.height]).toEqual([300, 150])

    const view = await stage.mount({ key: 'a', src: solidSource(200, 200), canvas: el })
    if (view instanceof Error || isAborted(view)) return expect.fail(String(view))

    const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1
    const wanted = Math.round(96 * dpr)
    // The cap at the front size is what makes the 1:1 case reachable at all: a destination sized
    // past the front resamples through the 2D context's own filter, which the library does not
    // control. `view.idealSize` is the front's size, exposed for exactly this comparison.
    expect(el.width).toBe(Math.min(wanted, view.idealSize.w))
    expect(el.height).toBe(Math.min(wanted, view.idealSize.h))
  })

  it('leaves a zero CSS size alone, because a zero backing store is a destroyed one', async () => {
    const stage = await blitStage(256)
    if (stage === null) return expect.fail('stage refused')
    const el = tile(null)
    expect(el.getBoundingClientRect().width).toBe(0)

    const view = await stage.mount({ key: 'a', src: solidSource(64, 64), canvas: el })
    if (view instanceof Error || isAborted(view)) return expect.fail(String(view))

    expect([el.width, el.height]).toEqual([300, 150])
  })

  it("size: 'manual' never touches the element the consumer sized itself", async () => {
    const stage = await blitStage(256)
    if (stage === null) return expect.fail('stage refused')
    const el = tile({ w: 96, h: 96 })
    el.width = 77
    el.height = 33
    const view = stage.view({ canvas: el, size: 'manual' })
    if (view instanceof Error) return expect.fail(view.message)
    const sprite = await stage.add(solidSource(64, 64), { key: 'a' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail(String(sprite))
    expect(view.show(sprite)).toBeUndefined()
    expect([el.width, el.height]).toEqual([77, 33])
  })
})

describe("the destination clear under fit: 'contain' (§4.0.1, §4.3)", () => {
  it('leaves no edge of a wide sprite around a narrow successor', async () => {
    const stage = await blitStage(256)
    if (stage === null) return expect.fail('stage refused')
    const el = tile({ w: 96, h: 96 })
    el.width = 96
    el.height = 96
    const view = stage.view({ canvas: el, fit: 'contain', size: 'manual' })
    if (view instanceof Error) return expect.fail(view.message)

    // Wide first: under `contain` it letterboxes top and bottom and paints the full width.
    const wide = await stage.add(solidSource(200, 100, [255, 0, 0, 255]), { key: 'wide' })
    if (wide instanceof Error || isAborted(wide)) return expect.fail(String(wide))
    expect(view.show(wide)).toBeUndefined()

    // Then narrow: it pillarboxes left and right, so the wide sprite's left and right edges are
    // now outside the new sprite's box. Without the destination clear they stay on the tile —
    // §4.3's scissored clear covers the GL surface only and never touched the destination.
    const narrow = await stage.add(solidSource(100, 200, [0, 255, 0, 255]), { key: 'narrow' })
    if (narrow instanceof Error || isAborted(narrow)) return expect.fail(String(narrow))
    expect(view.show(narrow)).toBeUndefined()

    const c2d = el.getContext('2d')
    if (c2d === null) return expect.fail('no 2D context on the destination')
    const left = c2d.getImageData(0, Math.floor(el.height / 2), 1, 1).data
    const right = c2d.getImageData(el.width - 1, Math.floor(el.height / 2), 1, 1).data
    expect(Array.from(left)).toEqual([0, 0, 0, 0])
    expect(Array.from(right)).toEqual([0, 0, 0, 0])
  })
})
