/**
 * `gl.resample.1024` — the artwork resampler on a 1024² decoded bitmap: the `ImageBitmap` upload,
 * the byte-fetch pass into the dedicated `RGBA8UI` staging texture, and `RESAMPLE_FS` into the
 * Pool A artwork slot. The sprite key is fresh per run, as it is for every `add()`, so Pool B's
 * staging is reallocated each time exactly as it is in production.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createResampler, createScratchPools, GlError } from './deps.js'
import { flush, measure, openFixture, silhouetteBitmap } from './harness.js'

afterAll(flush)

describe('gl.resample', () => {
  it('gl.resample.1024', async () => {
    const f = openFixture()
    expect(f).not.toBeInstanceOf(Error)
    if (f instanceof Error) return
    const S = 1024

    const bitmap = await silhouetteBitmap(S, S)
    expect(bitmap).not.toBeInstanceOf(Error)
    if (bitmap instanceof Error) return

    const pools = createScratchPools({ gl: f.ctx, artwork: { w: S, h: S }, sdfRes: 512 })
    const resampler = createResampler(f.ctx)
    expect(GlError.is(resampler)).toBe(false)
    if (GlError.is(resampler)) return

    let key = 'bench:0'
    for (const [name, A] of [
      ['gl.resample.1024', 1024],
      ['gl.resample.1024.to768', 768],
    ] as const) {
      await measure(name, {
        gl: f.gl,
        timer: f.timer,
        before: (i) => {
          key = `${name}:${i}`
        },
        run: () =>
          resampler.resample({
            spriteKey: key,
            bitmap,
            srcRect: { x: 0, y: 0, w: S, h: S },
            artwork: { w: A, h: A },
            poolA: pools.poolA,
            poolB: pools.poolB,
          }),
        extra: () => ({ source: S, artwork: A, exactByteFetch: f.ctx.exactByteFetch ? 1 : 0 }),
        note: 'texSubImage2D(ImageBitmap) + EXACT_BYTE_FETCH_FS + RESAMPLE_FS; one RGBA8UI staging texture allocated and freed per call',
      })
    }

    resampler.dispose()
    pools.dispose()
    bitmap.close()
    f.dispose()
  })
})
