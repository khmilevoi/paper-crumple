/**
 * `gl.sdf.build.<N>` — pass A, one `buildField` at an N x N field — and `gl.sdf.blur.<N>`, pass B
 * over it. The field size is the one named, not `sdfResFor(front)`: production fields cap at
 * `SDF_RES_MAX` (512), so the 1024 row is the algorithm's scaling, not a production configuration.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createScratchPools, createSdfBuilder, GlError, sigmaFor, uploadBytes } from './deps.js'
import type { Field, LooseField } from './deps.js'
import { flush, measure, openFixture, silhouetteBytes } from './harness.js'

afterAll(flush)

describe('gl.sdf', () => {
  for (const N of [512, 1024]) {
    it(`gl.sdf.build.${N}`, async () => {
      const f = openFixture()
      expect(f).not.toBeInstanceOf(Error)
      if (f instanceof Error) return

      const pools = createScratchPools({ gl: f.ctx, artwork: { w: N, h: N }, sdfRes: N })
      const artwork = pools.poolA.holdArtwork('bench', {
        width: N,
        height: N,
        format: 'RGBA8UI',
        filter: 'NEAREST',
        label: 'artwork:bench',
      })
      expect(GlError.is(artwork)).toBe(false)
      if (GlError.is(artwork)) return
      const uploaded = f.ctx.scope(() => uploadBytes(f.gl, artwork, silhouetteBytes(N, N)))
      expect(uploaded).toBeUndefined()

      const builder = createSdfBuilder(f.ctx, pools.poolA)
      expect(GlError.is(builder)).toBe(false)
      if (GlError.is(builder)) return

      let field: Field | null = null
      await measure(`gl.sdf.build.${N}`, {
        gl: f.gl,
        timer: f.timer,
        run: () => {
          const r = builder.buildField({
            artwork,
            artworkUv: [1, 1, 0, 0],
            width: N,
            height: N,
            sourceLongSide: N,
          })
          if (!GlError.is(r)) field = r
          return r
        },
        extra: () => ({
          passes: (field as Field | null)?.passes ?? 0,
          fieldBits: builder.contract.bits,
        }),
        note: 'two seed passes, two JFA schedules (log2 N + 1 steps each) and one resolve',
      })
      expect(field).not.toBeNull()
      if (field === null) return
      const tight: Field = field

      let loose: LooseField | null = null
      await measure(`gl.sdf.blur.${N}`, {
        gl: f.gl,
        timer: f.timer,
        run: () => {
          const r = builder.blurField({ field: tight, sigmaPx: sigmaFor(0.5, N), frontLongSide: N })
          if (!GlError.is(r)) loose = r
          return r
        },
        extra: () => ({
          radius: (loose as LooseField | null)?.radius ?? 0,
          taps: (loose as LooseField | null)?.taps ?? 0,
          looseSide: (loose as LooseField | null)?.width ?? 0,
        }),
        note: 'pass B: two separable Gaussian passes at 1/LOOSE_DIV of the field, looseness 0.5',
      })

      builder.dispose()
      pools.dispose()
      f.dispose()
    })
  }
})
