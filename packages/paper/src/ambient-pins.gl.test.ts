/**
 * # The three ambient pins after a whole pipeline run, and the byte-fetch probe at context
 * creation (§7.4.1, §11)
 *
 * §7.4.1 names three pieces of ambient state that "silently corrupt a byte and must be pinned":
 * `DITHER`, which ES 3.0 enables by default and permits to alter the written value;
 * `UNPACK_COLORSPACE_CONVERSION_WEBGL`, which colour-manages the upload; and
 * `UNPACK_FLIP_Y_WEBGL`, which the spike's own `engine.js` upload leaves true.
 *
 * Core asserts all three **at context creation** (`gl-context.gl.test.ts:56-58`). This file asserts
 * them **after a real `source()` and `build()`**, because the risk the pins exist for is a slot
 * that dirties them mid-pipeline, and nothing before this tier could have caught that.
 *
 * `exactByteFetch` is asserted `true` for a different reason, and in its **own** describe below:
 * on the level-2 lane's driver it is the normative path, and a driver regression that silently
 * flipped it to the canvas fallback would cost byte-fidelity for every fully transparent texel's
 * colour (§8.5.3) with no test going red. Here it goes red. It runs no pipeline and must not: the
 * value is computed once at `createGlContext` and nothing re-probes it, so a pipeline run would
 * decorate the case without adding anything it could catch.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError, isAborted } from '@paper-crumple/core'
import { defaultsFor } from './paper-knobs.js'
import { paperSheet } from './sheet.js'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'

let fixture: PaperGlFixture | null = null
afterEach(() => {
  fixture?.dispose()
  fixture = null
})

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

/**
 * A single opaque square, padded with a transparent border (§8.6's guard-band check).
 *
 * A 48x48 opaque square filling its own canvas edge-to-edge has no natural transparent margin, so
 * the hull's dilation (reserved by overscan but measured against the *source's own* silhouette)
 * reaches the guard band outright: measured directly, `source()` refused with "the hull reaches
 * 0.5000 of the front on axis x, inside the shader's guard band at 0.482". Centring the same 48x48
 * square inside a 192x192 canvas (`PAD = 72` on every side) reproduces task 5's fix — same opaque
 * geometry, a canvas four times the side so the silhouette spans a quarter of it — and clears the
 * guard band with the same identical pipeline behaviour this file is testing.
 */
async function sprite(): Promise<ImageBitmap> {
  const inner = 48
  const pad = 72
  const s = inner + 2 * pad
  const data = new Uint8ClampedArray(s * s * 4)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (x < pad || x >= pad + inner || y < pad || y >= pad + inner) continue
      const i = (y * s + x) * 4
      data[i] = 90
      data[i + 1] = 140
      data[i + 2] = 200
      data[i + 3] = 255
    }
  }
  return createImageBitmap(new ImageData(data, s, s), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

describe('the ambient pins survive a whole pipeline run (§7.4.1)', () => {
  it('leaves DITHER off, colourspace NONE and flip-y false after source() and build()', async () => {
    const f = open()
    const { ctx, gl } = f
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    const bitmap = await sprite()
    const handle = await sheet.source(bitmap, { maxSize: 128, exact: false })
    bitmap.close()
    if (GlError.is(handle) || SheetError.is(handle) || isAborted(handle)) {
      return expect.fail(`source() refused: ${String(handle)}`)
    }
    const front = sheet.build(handle, { w: 128, h: 128 }, defaultsFor('hull') as never)
    if (front instanceof Error) return expect.fail(front.message)

    expect(gl!.isEnabled(gl!.DITHER)).toBe(false)
    expect(gl!.getParameter(gl!.UNPACK_COLORSPACE_CONVERSION_WEBGL)).toBe(gl!.NONE)
    expect(gl!.getParameter(gl!.UNPACK_FLIP_Y_WEBGL)).toBe(false)
    // Never SRGB8_ALPHA8 (§7.4.1): a single-sample RGBA8 attachment is the whole rule.
    expect(gl!.getError()).toBe(gl!.NO_ERROR)

    sheet.releaseFront(front)
    sheet.dispose()
  })
})

describe('the byte-fetch probe, as `createGlContext` computed it (§8.5.3)', () => {
  it('reports exactByteFetch true, so a driver regression is a CI failure and not a drift', () => {
    const f = open()
    // The `usampler2D` form stays the normative definition and the fallback, so a `false` here
    // costs performance and never correctness — but it also silently changes what a fully
    // transparent texel's colour survives as (§8.5.3), which this tier's other files assert.
    expect(f.ctx.exactByteFetch).toBe(true)
  })
})
