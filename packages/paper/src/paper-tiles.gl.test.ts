import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from '@paper-crumple/core'
import { drawTargetFor } from '@paper-crumple/core/unstable'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { mountNeutralTiles, NEUTRAL_TILE_BYTE, TILE_NAMES } from './paper-tiles.js'

let fixture: PaperGlFixture | null = null

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open(): PaperGlFixture {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

describe('the neutral tile textures', () => {
  it('mounts four 1x1 R8 textures', () => {
    const { ctx } = open()
    const tiles = mountNeutralTiles(ctx)
    expect(GlError.is(tiles)).toBe(false)
    if (GlError.is(tiles)) return
    for (const name of TILE_NAMES) {
      expect(tiles[name].width).toBe(1)
      expect(tiles[name].height).toBe(1)
      expect(tiles[name].format).toBe('R8')
      expect(tiles[name].bytes).toBe(1)
    }
    tiles.dispose()
  })

  it('holds the derived neutral byte, read back off a target over the texture', () => {
    const { ctx } = open()
    const tiles = mountNeutralTiles(ctx)
    expect(GlError.is(tiles)).toBe(false)
    if (GlError.is(tiles)) return
    const target = ctx.target(tiles.crumpleR)
    expect(GlError.is(target)).toBe(false)
    if (GlError.is(target)) return
    const out = new Uint8Array(4)
    ctx.scope((s) => {
      s.bindTarget(drawTargetFor(target))
      // `DrawScope.bindTarget` binds `DRAW_FRAMEBUFFER` only; `readPixels` reads
      // `READ_FRAMEBUFFER`, which core's own resample fixture binds explicitly for the same
      // reason (`testing/gl-resample.ts`).
      ctx.gl.bindFramebuffer(ctx.gl.READ_FRAMEBUFFER, target.framebuffer)
      ctx.gl.readPixels(0, 0, 1, 1, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, out)
    })
    expect(out[0]).toBe(NEUTRAL_TILE_BYTE)
    target.dispose()
    tiles.dispose()
  })

  it('wraps MIRRORED_REPEAT, because the tiles are crops whose edges do not match', () => {
    const { ctx, gl } = open()
    const tiles = mountNeutralTiles(ctx)
    expect(GlError.is(tiles)).toBe(false)
    if (GlError.is(tiles)) return
    ctx.scope(() => {
      gl!.bindTexture(gl!.TEXTURE_2D, tiles.fibreA.handle)
      expect(gl!.getTexParameter(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S)).toBe(gl!.MIRRORED_REPEAT)
      expect(gl!.getTexParameter(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T)).toBe(gl!.MIRRORED_REPEAT)
    })
    tiles.dispose()
  })
})
