/**
 * `gl.front.render.<N>.<mode>` — one `renderFront` into an N x N front, in hull and torn mode.
 *
 * The fields are at `sdfResFor(N)` — 256 for 512, 512 for 1024 — which is what `build()` uses for
 * a front of that long side. The artwork sits centred at 72 % of the front, roughly what the hull
 * mode's default reserve leaves. The hull field is the artwork's own field built into the
 * `hullField` slot: `build()` builds it from the polygon mask, but the shader's cost does not
 * depend on which silhouette the field encodes. The tiles are the neutral 1x1 ones; the fetch
 * count is the same as with the 512² planes, only the cache behaviour differs.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  createPaperRenderer,
  createScratchPools,
  createSdfBuilder,
  defaultsFor,
  descriptorsFor,
  drawTargetFor,
  GlError,
  SDF_POOL_SLOTS,
  sdfResFor,
  sigmaFor,
  uploadBytes,
} from './deps.js'
import type { EdgeSpec, GlContext, MountedTiles, Texture } from './deps.js'
import { flush, measure, openFixture, silhouetteBytes } from './harness.js'

afterAll(flush)

/**
 * The four neutral 1x1 `R8` planes `paperSheet` mounts before the tiles land (`mountNeutralTiles`
 * in `paper-tiles.ts`, which the package does not export). MIRRORED_REPEAT is irrelevant to a
 * 1x1 plane and is not set.
 */
function neutralTiles(ctx: GlContext): MountedTiles | Error {
  const made: Texture[] = []
  const byte = new Uint8Array([128])
  for (const name of ['crumpleR', 'crumpleG', 'crumpleA', 'fibreA']) {
    const t = ctx.texture({
      width: 1,
      height: 1,
      format: 'R8',
      filter: 'LINEAR',
      wrap: 'REPEAT',
      label: name,
    })
    if (GlError.is(t)) return t
    const up = ctx.scope(() => uploadBytes(ctx.gl, t, byte))
    if (up !== undefined) return up
    made.push(t)
  }
  return {
    crumpleR: made[0],
    crumpleG: made[1],
    crumpleA: made[2],
    fibreA: made[3],
    dispose() {
      for (const t of made) t.dispose()
    },
  }
}

describe('gl.front', () => {
  for (const N of [512, 1024]) {
    it(`gl.front.render.${N}`, async () => {
      const f = openFixture()
      expect(f).not.toBeInstanceOf(Error)
      if (f instanceof Error) return

      const A = Math.round(N * 0.72)
      const placement = { x: Math.round((N - A) / 2), y: Math.round((N - A) / 2), w: A, h: A }
      const res = sdfResFor(N)

      const pools = createScratchPools({ gl: f.ctx, artwork: { w: A, h: A }, sdfRes: res })
      const artwork = pools.poolA.holdArtwork('bench', {
        width: A,
        height: A,
        format: 'RGBA8UI',
        filter: 'NEAREST',
        label: 'artwork:bench',
      })
      expect(GlError.is(artwork)).toBe(false)
      if (GlError.is(artwork)) return
      expect(f.ctx.scope(() => uploadBytes(f.gl, artwork, silhouetteBytes(A, A)))).toBeUndefined()

      const builder = createSdfBuilder(f.ctx, pools.poolA)
      expect(GlError.is(builder)).toBe(false)
      if (GlError.is(builder)) return

      // `artworkUvFor(placement, front)` in sheet.ts: field uv -> artwork uv.
      const artworkUv: readonly [number, number, number, number] = [
        N / A,
        N / A,
        -placement.x / A,
        -placement.y / A,
      ]
      const tight = builder.buildField({
        artwork,
        artworkUv,
        width: res,
        height: res,
        sourceLongSide: N,
      })
      expect(GlError.is(tight)).toBe(false)
      if (GlError.is(tight)) return
      const loose = builder.blurField({ field: tight, sigmaPx: sigmaFor(0.5, N), frontLongSide: N })
      expect(GlError.is(loose)).toBe(false)
      if (GlError.is(loose)) return
      const paperField = builder.buildField({
        artwork,
        artworkUv,
        width: res,
        height: res,
        sourceLongSide: N,
        slot: SDF_POOL_SLOTS.hullField,
      })
      expect(GlError.is(paperField)).toBe(false)
      if (GlError.is(paperField)) return

      const front = f.ctx.texture({
        width: N,
        height: N,
        format: 'RGBA8',
        filter: 'LINEAR',
        label: 'front',
      })
      expect(GlError.is(front)).toBe(false)
      if (GlError.is(front)) return
      const target = f.ctx.target(front)
      expect(GlError.is(target)).toBe(false)
      if (GlError.is(target)) return

      const renderer = createPaperRenderer(f.ctx)
      expect(GlError.is(renderer)).toBe(false)
      if (GlError.is(renderer)) return
      const tiles = neutralTiles(f.ctx)
      expect(tiles).not.toBeInstanceOf(Error)
      if (tiles instanceof Error) return

      // design 2026-09-05 §6's two extreme cells: `smooth`/`clean` binds the polygon's own field
      // to both `uSdf*` slots and draws no decoration, `torn`/`paper` binds the artwork's pair and
      // draws every one. The pair that used to be `edgeMode` `hull` and `torn`.
      for (const [cell, spec] of [
        ['smooth', { shape: 'smooth', finish: 'clean', widthUnit: 'px' }],
        ['torn', { shape: 'torn', finish: 'paper', widthUnit: 'px' }],
      ] as const satisfies ReadonlyArray<readonly [string, EdgeSpec]>) {
        await measure(`gl.front.render.${N}.${cell}`, {
          gl: f.gl,
          timer: f.timer,
          profile: N === 1024,
          run: () =>
            renderer.renderFront(tiles, {
              target: drawTargetFor(target),
              front: { w: N, h: N },
              artworkRect: placement,
              artwork,
              tight,
              loose,
              paperField: spec.shape === 'smooth' ? paperField : null,
              edgeSpec: spec,
              // design 2026-09-05 §3.1: the width reaches `renderFront` already resolved to
              // reference px. Under the `'px'` unit `paperSheet`'s own `widthRefFrom` is the
              // identity on the knob, so the descriptor default IS what the library would pass.
              widthRef: Number(defaultsFor(spec).edgeWidth),
              values: defaultsFor(spec),
              descriptors: descriptorsFor(spec),
            }),
          extra: () => ({ sdfRes: res, artworkSide: A, cell }),
          note: 'one fullscreen triangle through PAPER_FS; clear + 8 texture binds + ~60 uniforms',
        })
      }

      tiles.dispose()
      renderer.dispose()
      target.dispose()
      front.dispose()
      builder.dispose()
      pools.dispose()
      f.dispose()
    })
  }
})
