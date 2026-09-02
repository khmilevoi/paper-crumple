/**
 * # `identityView` — a smoke test for the sheet shader, not a resampling guarantee (§7.4.2)
 *
 * The specification names this test for what it is, and so does this file. The resampling
 * guarantee is over the **front texture** and is asserted in `packages/paper/src/front-identity.
 * gl.test.ts`; what is asserted here is only that the shading path is transparent at pose 0:
 * `uIdentity == 1` forces `shade` to exactly `1.0`, `uAlphaFloor == 0` makes `mix(x, paper, 0.0)`
 * return `x` bitwise, and `front.a == 1` makes the straight-alpha composite exact.
 *
 * Any deviation — a real garment's aspect, a clamped stretch, a display-derived view rect — voids
 * the claim, which is why every precondition is asserted before the pixels are.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { DrawTarget, MotionKnobs } from '@paper-crumple/core'
import { MOTION_KNOBS } from './knobs.js'
import type { MotionLookKnobs } from './knobs.js'
import pack1x1 from './packs/1x1.js'
import { bakedMotion, type BakedClip, type BakedFit } from './source.js'
import { createGlFixture, type GlFixture } from './testing/gl-fixture.js'
import {
  identityView,
  IDENTITY_BOX,
  IDENTITY_FRONT,
  IDENTITY_MARGIN,
} from './testing/identity-view.js'

let fixture: GlFixture | null = null
const live: Array<{ dispose(): void }> = []

afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

/** The bag the core would hand down: the slot's own defaults plus the two shared knobs (§5.5). */
const KNOBS = {
  ...Object.fromEntries(MOTION_KNOBS.map((k) => [k.key, k.default])),
  paperColor: '#f7f4ed',
  paperBack: '#e8e2d4',
} as unknown as Readonly<MotionKnobs<MotionLookKnobs>>

/** An RGBA8 colour target the test owns, cleared to zero, so nothing outside the sheet is noise. */
function ownTarget(gl: WebGL2RenderingContext): {
  target: DrawTarget
  read(): Uint8Array
  dispose(): void
} {
  const texture = gl.createTexture() as WebGLTexture
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, IDENTITY_FRONT, IDENTITY_FRONT)
  gl.bindTexture(gl.TEXTURE_2D, null)
  const framebuffer = gl.createFramebuffer() as WebGLFramebuffer
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  gl.clearColor(0, 0, 0, 0)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
  const box = { x: 0, y: 0, w: IDENTITY_FRONT, h: IDENTITY_FRONT }
  return {
    target: { framebuffer, viewport: box, dest: box },
    read() {
      const out = new Uint8Array(IDENTITY_FRONT * IDENTITY_FRONT * 4)
      // `DrawScope.bindTarget` binds DRAW_FRAMEBUFFER only; readPixels reads READ_FRAMEBUFFER.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer)
      gl.readPixels(0, 0, IDENTITY_FRONT, IDENTITY_FRONT, gl.RGBA, gl.UNSIGNED_BYTE, out)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      return out
    },
    dispose() {
      gl.deleteFramebuffer(framebuffer)
      gl.deleteTexture(texture)
    },
  }
}

function open(): GlFixture {
  fixture = createGlFixture(IDENTITY_FRONT, IDENTITY_FRONT)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

describe('identityView (§7.4.2) — a smoke test for the sheet shader, not a resampling guarantee', () => {
  it('is built at exactly a bucket aspect, so stretch is 1 and clamped is false', async () => {
    const f = open()
    const view = identityView(f.gl)
    live.push(view)
    const source = bakedMotion({ packs: [pack1x1] })
    live.push(source)
    expect(source.mount(f.ctx)).toBeUndefined()
    const fit = source.fit(view.bbox) as BakedFit
    expect(fit).not.toBeInstanceOf(Error)
    expect(fit.bucket).toBe('1x1')
    expect(fit.stretch).toBe(1)
    expect(fit.clamped).toBe(false)
    expect(fit.sheetW).toBe(IDENTITY_BOX)
    expect(fit.sheetH).toBe(IDENTITY_BOX)
  })

  it('has an integer margin and an artwork rect A === (0, 0, w, h)', () => {
    const f = open()
    const view = identityView(f.gl)
    live.push(view)
    expect(Number.isInteger(view.margin)).toBe(true)
    expect(view.margin).toBe(IDENTITY_MARGIN)
    // A is the whole front: the transparent field is part of the artwork, not a reserved margin.
    expect(view.front.width).toBe(IDENTITY_FRONT)
    expect(view.front.height).toBe(IDENTITY_FRONT)
    expect(view.bytes.length).toBe(IDENTITY_FRONT * IDENTITY_FRONT * 4)
  })

  it('draws pose 0 as the front, texel for texel, over the sheet box', async () => {
    const f = open()
    const view = identityView(f.gl)
    live.push(view)
    const out = ownTarget(f.gl)
    live.push(out)
    const source = bakedMotion({ packs: [pack1x1] })
    live.push(source)
    expect(source.mount(f.ctx)).toBeUndefined()
    const fit = source.fit(view.bbox) as BakedFit
    const clip = (await source.load(fit)) as BakedClip
    expect(clip).not.toBeInstanceOf(Error)

    // Cover-scale is exactly 1 because the destination is exactly the front's size.
    expect(out.target.dest.w).toBe(view.front.width)
    expect(out.target.dest.h).toBe(view.front.height)

    const drawn = f.ctx.scope(() =>
      source.draw({ clip, fit, frame: 0, front: view.front, out: out.target, knobs: KNOBS }),
    )
    expect(drawn).not.toBeInstanceOf(Error)
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR)

    const got = out.read()
    const differing: string[] = []
    for (let y = 0; y < IDENTITY_FRONT; y++) {
      for (let x = 0; x < IDENTITY_FRONT; x++) {
        const p = (y * IDENTITY_FRONT + x) * 4
        const inside =
          x >= IDENTITY_MARGIN &&
          x < IDENTITY_MARGIN + IDENTITY_BOX &&
          y >= IDENTITY_MARGIN &&
          y < IDENTITY_MARGIN + IDENTITY_BOX
        if (inside) {
          // Inside the box: the fixture's own texels are the oracle, texel for texel.
          for (let c = 0; c < 4; c++) {
            if (got[p + c] !== view.bytes[p + c]) {
              differing.push(
                `(${x},${y}).${'rgba'[c]}: ${got[p + c]} != ${view.bytes[p + c]} (inside box)`,
              )
            }
          }
        } else {
          // Outside the box: `view.bytes` varies RGB at alpha 0 there (§ identity-view.ts), but pose
          // 0 discards outside the box, so the framebuffer must still read the cleared 0,0,0,0 — not
          // the fixture's stored RGB, which the shader was never meant to emit.
          for (let c = 0; c < 4; c++) {
            if (got[p + c] !== 0) {
              differing.push(`(${x},${y}).${'rgba'[c]}: ${got[p + c]} != 0 (outside box)`)
            }
          }
        }
      }
    }
    expect(differing.slice(0, 8)).toEqual([])
    expect(differing.length).toBe(0)
  })

  it('starts from a target cleared to zero, so a non-zero field after the draw is the shader and not the target', () => {
    const f = open()
    const view = identityView(f.gl)
    live.push(view)
    const out = ownTarget(f.gl)
    live.push(out)
    const got = out.read()
    // Read before any draw: the target was cleared to zero, which is what the corners must still
    // read after the draw in the case above. Asserted here so a target that came back non-zero
    // for its own reasons is not mistaken for a shader that failed to discard.
    expect([got[0], got[1], got[2], got[3]]).toEqual([0, 0, 0, 0])
  })
})
