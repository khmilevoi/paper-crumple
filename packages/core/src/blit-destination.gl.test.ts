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
import type { MotionSource } from './motion.js'
import { paperStage } from './stage.js'
import { fakeMotion, fakeSheet, type FakeMotion } from './testing/fake-slots.js'

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

async function blitStage(maxSize: number, motion: MotionSource = fakeMotion()) {
  const stage = await paperStage({
    sheet: fakeSheet(),
    motion,
    maxSize,
    present: 'blit',
  })
  if (stage instanceof Error || isAborted(stage)) return null
  live.push(stage)
  return stage
}

/**
 * `fakeMotion()` draws nothing at all, so every pixel it leaves on the GL surface is the
 * transparent black §4.3's scissored clear put there. That is enough for the sizing cases, and
 * **not** enough for the destination clear: a tile that reads `(0,0,0,0)` after a swap proves
 * nothing unless something opaque was there first. This wrapper paints the whole draw rect a flat
 * colour keyed on the sprite's own aspect — wide is red, narrow is green — so the probes below
 * can tell "the clear worked" apart from "nothing ever drew".
 *
 * It reaches the context through `mount()`, which is where the core hands every slot the
 * `GlContext` it is allowed to draw with; it injects no context of its own and edits nothing in
 * `fake-slots.ts`, which is P9's shared fixture.
 */
function paintingMotion(): MotionSource {
  const inner = fakeMotion()
  let gl: WebGL2RenderingContext | null = null
  const wrapper = Object.create(inner) as FakeMotion
  const wide: [number, number, number] = [1, 0, 0]
  const narrow: [number, number, number] = [0, 1, 0]
  Object.assign(wrapper, {
    mount(ctx: Parameters<MotionSource['mount']>[0]) {
      gl = ctx.gl
      return inner.mount(ctx)
    },
    draw(a: Parameters<FakeMotion['draw']>[0]) {
      const result = inner.draw(a)
      if (gl !== null) {
        const [r, g, b] = a.fit.frontSize.w >= a.fit.frontSize.h ? wide : narrow
        const d = a.out.dest
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(d.x, d.y, d.w, d.h)
        gl.clearColor(r, g, b, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.disable(gl.SCISSOR_TEST)
      }
      return result
    },
  })
  return wrapper as unknown as MotionSource
}

/** One texel of the destination, as `[r, g, b, a]`. */
function probe(el: HTMLCanvasElement, x: number, y: number): number[] | Error {
  const c2d = el.getContext('2d')
  if (c2d === null) return new Error('no 2D context on the destination')
  return Array.from(c2d.getImageData(x, y, 1, 1).data)
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

  it('caps the backing store at the front when the front is smaller than round(css x dpr)', async () => {
    const stage = await blitStage(256)
    if (stage === null) return expect.fail('stage refused')
    const el = tile({ w: 96, h: 96 })
    expect([el.width, el.height]).toEqual([300, 150])

    // A 32x32 source against the same 96 CSS px as the case above. `fakeSheet.source()` derives
    // the front from the bitmap, so this is what puts the front *under* the CSS size and makes
    // the `Math.min` bind — at dpr 1 the case above wants 96 against a 200x200 front, where the
    // cap can never be the smaller of the two and an implementation missing it entirely passes.
    const view = await stage.mount({ key: 'a', src: solidSource(32, 32), canvas: el })
    if (view instanceof Error || isAborted(view)) return expect.fail(String(view))

    const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1
    const wanted = Math.round(96 * dpr)
    // The premise, asserted rather than assumed: without this the case below could be passing
    // because the cap did not bind, exactly as the first case does.
    expect(view.idealSize.w).toBeLessThan(wanted)
    expect(view.idealSize.h).toBeLessThan(wanted)
    // Derived from the front the stage actually built, never from a literal.
    expect(el.width).toBe(view.idealSize.w)
    expect(el.height).toBe(view.idealSize.h)
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
    const stage = await blitStage(256, paintingMotion())
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

    // The premise the whole case rests on, asserted rather than assumed: the wide sprite really
    // did paint the left edge that the clear must later remove. Without this a blit that stopped
    // drawing altogether would leave the tile transparent and pass every probe below.
    expect(probe(el, 0, Math.floor(el.height / 2))).toEqual([255, 0, 0, 255])

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
    // And inside the narrow sprite's own band it is painted, so "the clear removed everything"
    // cannot pass either: the two probes above are about the pillarbox, not about the tile.
    expect(probe(el, Math.floor(el.width / 2), Math.floor(el.height / 2))).toEqual([0, 255, 0, 255])
  })
})

/**
 * A motion that places the sheet the way the real slot does — `packages/motion/src/source.ts`
 * scales the front into `out.dest` with ONE uniform factor and centres it there — and paints
 * that box green with a red marker over its top-left fifth. `paintingMotion()` floods the whole
 * `dest`, which cannot tell "the blit copied the box the sheet was drawn in" apart from "the blit
 * copied some other window of a surface that is flat colour everywhere"; the marker can, and it
 * also catches a vertical flip.
 *
 * Coordinates are GL's: origin bottom-left, y up, absolute on the surface, exactly what
 * `bindTarget` feeds to `gl.scissor`. The marker sits at the sheet's GL top, which `drawImage`
 * shows at the destination's top.
 */
function placingMotion(): MotionSource {
  const inner = fakeMotion()
  let gl: WebGL2RenderingContext | null = null
  const wrapper = Object.create(inner) as FakeMotion
  Object.assign(wrapper, {
    mount(ctx: Parameters<MotionSource['mount']>[0]) {
      gl = ctx.gl
      return inner.mount(ctx)
    },
    draw(a: Parameters<FakeMotion['draw']>[0]) {
      const result = inner.draw(a)
      if (gl !== null) {
        const { front, out } = a
        const k = Math.min(out.dest.w / front.width, out.dest.h / front.height)
        const w = front.width * k
        const h = front.height * k
        const x = out.dest.x + (out.dest.w - w) / 2
        const y = out.dest.y + (out.dest.h - h) / 2
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(Math.round(x), Math.round(y), Math.round(w), Math.round(h))
        gl.clearColor(0, 1, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.scissor(Math.round(x), Math.round(y + h * 0.8), Math.round(w * 0.2), Math.round(h * 0.2))
        gl.clearColor(1, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.disable(gl.SCISSOR_TEST)
      }
      return result
    },
  })
  return wrapper as unknown as MotionSource
}

const GREEN = [0, 255, 0, 255]
const RED = [255, 0, 0, 255]
const CLEAR = [0, 0, 0, 0]

/**
 * The window `blitPlan()` copies out is the front-sized corner of the surface, `(0, 0, w, h)` in
 * GL coordinates. The box the view hands the motion to draw in must be that same window — for a
 * non-square front a whole-surface box centres the sheet somewhere else on the square surface,
 * and the copy shows a shifted, cropped slice of it. `fakeSheet()` builds the front at the
 * bitmap's own size, so a 200x100 bitmap on a 256x256 surface is exactly the case.
 */
describe("the copied window is the box the sheet was drawn in (§4.0.1, fit: 'contain')", () => {
  it('lands a non-square front where contain says it lands, marker and all', async () => {
    const stage = await blitStage(256, placingMotion())
    if (stage === null) return expect.fail('stage refused')
    const el = tile({ w: 96, h: 96 })
    el.width = 96
    el.height = 96
    const view = stage.view({ canvas: el, fit: 'contain', size: 'manual' })
    if (view instanceof Error) return expect.fail(view.message)

    const wide = await stage.add(solidSource(200, 100), { key: 'wide' })
    if (wide instanceof Error || isAborted(wide)) return expect.fail(String(wide))
    expect(view.show(wide)).toBeUndefined()
    // The premise: the front is non-square, so the corner window and a centred box differ.
    expect(view.idealSize).toEqual({ w: 200, h: 100 })

    // contain: scale min(96/200, 96/100) = 0.48, a 96x48 band at y = 24.
    expect(probe(el, 48, 47)).toEqual(GREEN) // its centre
    expect(probe(el, 90, 68)).toEqual(GREEN) // its bottom-right
    expect(probe(el, 8, 28)).toEqual(RED) // the marker, top-left fifth: x < 19, 24 <= y < 34
    expect(probe(el, 8, 66)).toEqual(GREEN) // and not at the bottom-left: no vertical flip
    expect(probe(el, 48, 10)).toEqual(CLEAR) // the letterbox bars stay clear
    expect(probe(el, 48, 85)).toEqual(CLEAR)
  })

  it('follows the front across a show() of the other aspect on the same view', async () => {
    const stage = await blitStage(256, placingMotion())
    if (stage === null) return expect.fail('stage refused')
    const el = tile({ w: 96, h: 96 })
    el.width = 96
    el.height = 96
    const view = stage.view({ canvas: el, fit: 'contain', size: 'manual' })
    if (view instanceof Error) return expect.fail(view.message)

    const wide = await stage.add(solidSource(200, 100), { key: 'wide' })
    if (wide instanceof Error || isAborted(wide)) return expect.fail(String(wide))
    expect(view.show(wide)).toBeUndefined()
    expect(probe(el, 48, 47)).toEqual(GREEN)

    // The view's target was resolved once, at view() time, when no front existed yet; the box it
    // draws in has to follow the front it draws, not the first front it ever saw.
    const tall = await stage.add(solidSource(100, 200), { key: 'tall' })
    if (tall instanceof Error || isAborted(tall)) return expect.fail(String(tall))
    expect(view.show(tall)).toBeUndefined()
    expect(view.idealSize).toEqual({ w: 100, h: 200 })

    // contain: scale 0.48 again, a 48x96 band at x = 24.
    expect(probe(el, 47, 48)).toEqual(GREEN) // its centre
    expect(probe(el, 68, 90)).toEqual(GREEN) // its bottom-right
    expect(probe(el, 28, 8)).toEqual(RED) // the marker: 24 <= x < 34, y < 19
    expect(probe(el, 28, 88)).toEqual(GREEN) // no vertical flip
    expect(probe(el, 10, 48)).toEqual(CLEAR) // the pillarbox bars stay clear
    expect(probe(el, 85, 48)).toEqual(CLEAR)
  })
})
