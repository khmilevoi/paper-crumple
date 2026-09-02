import { GlError } from '@paper-crumple/core'
import type { DrawTarget, MotionKnobs, SheetFront } from '@paper-crumple/core'
import { afterEach, describe, expect, it } from 'vitest'

import { MOTION_KNOBS } from './knobs.js'
import type { MotionLookKnobs } from './knobs.js'
import pack2x3 from './packs/2x3.js'
import { bakedMotion, type BakedClip, type BakedFit } from './source.js'
import { createGlFixture, type GlFixture } from './testing/gl-fixture.js'

let fixture: GlFixture | null = null

afterEach(() => {
  fixture?.dispose()
  fixture = null
})

function open(): GlFixture {
  fixture = createGlFixture(128, 128)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

/** A 4x4 opaque red front standing in for a built sheet. */
function makeFront(gl: WebGL2RenderingContext): SheetFront {
  const texture = gl.createTexture() as WebGLTexture
  const texels = new Uint8Array(4 * 4 * 4)
  for (let i = 0; i < texels.length; i += 4) texels.set([255, 0, 0, 255], i)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, texels)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.bindTexture(gl.TEXTURE_2D, null)
  return { texture, width: 4, height: 4, rect: { x: 0, y: 0, w: 4, h: 4 }, bytes: 64 }
}

/**
 * The bag the core would hand down: the slot's six own defaults plus the two core-declared shared
 * knobs `MotionKnobs<K> = Flatten<SharedKnobs & K>` intersects in (§5.5, §6.2).
 */
const KNOBS = {
  ...Object.fromEntries(MOTION_KNOBS.map((k) => [k.key, k.default])),
  paperColor: '#f7f4ed',
  paperBack: '#e8e2d4',
} as unknown as Readonly<MotionKnobs<MotionLookKnobs>>

function target(gl: WebGL2RenderingContext): DrawTarget {
  const box = { x: 0, y: 0, w: gl.drawingBufferWidth, h: gl.drawingBufferHeight }
  return { framebuffer: null, viewport: box, dest: box }
}

async function ready(f: GlFixture): Promise<{
  source: ReturnType<typeof bakedMotion>
  fit: BakedFit
  clip: BakedClip
  front: SheetFront
}> {
  const source = bakedMotion({ packs: [pack2x3] })
  expect(source.mount(f.ctx)).toBeUndefined()
  const fit = source.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit
  const clip = (await source.load(fit)) as BakedClip
  expect(clip).not.toBeInstanceOf(Error)
  return { source, fit, clip, front: makeFront(f.gl) }
}

describe('draw (§5.3, §7.3, §8.4)', () => {
  it('reports the sortKey and the stored frame it bound', async () => {
    const f = open()
    const { source, fit, clip, front } = await ready(f)
    const r = f.ctx.scope(() => {
      const out = target(f.gl)
      return source.draw({ clip, fit, frame: clip.keyFrames[0], front, out, knobs: KNOBS })
    })
    expect(r).not.toBeInstanceOf(Error)
    expect(r).toEqual({ sortKey: '2x3', frame: 0 })
    source.dispose()
  })

  it('draws all six poses without a GL error', async () => {
    const f = open()
    const { source, fit, clip, front } = await ready(f)
    f.ctx.scope(() => {
      const out = target(f.gl)
      for (const frame of clip.keyFrames) {
        expect(source.draw({ clip, fit, frame, front, out, knobs: KNOBS })).not.toBeInstanceOf(
          Error,
        )
      }
    })
    expect(f.gl.getError()).toBe(f.gl.NO_ERROR)
    source.dispose()
  })

  it('restores every bit of §5.1 state the scope saved', async () => {
    const f = open()
    const { gl } = f
    const { source, fit, clip, front } = await ready(f)
    const before = {
      program: gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null,
      vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null,
      depth: gl.isEnabled(gl.DEPTH_TEST),
      blend: gl.isEnabled(gl.BLEND),
      cull: gl.isEnabled(gl.CULL_FACE),
      fbo: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null,
    }
    f.ctx.scope(() => source.draw({ clip, fit, frame: 0, front, out: target(gl), knobs: KNOBS }))
    expect(gl.getParameter(gl.CURRENT_PROGRAM)).toBe(before.program)
    expect(gl.getParameter(gl.VERTEX_ARRAY_BINDING)).toBe(before.vao)
    expect(gl.isEnabled(gl.DEPTH_TEST)).toBe(before.depth)
    expect(gl.isEnabled(gl.BLEND)).toBe(before.blend)
    expect(gl.isEnabled(gl.CULL_FACE)).toBe(before.cull)
    expect(gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)).toBe(before.fbo)
    source.dispose()
  })

  it('never resizes the canvas from inside a draw (§7.3)', async () => {
    const f = open()
    const { source, fit, clip, front } = await ready(f)
    const size = [f.canvas.width, f.canvas.height]
    f.ctx.scope(() => source.draw({ clip, fit, frame: 0, front, out: target(f.gl), knobs: KNOBS }))
    expect([f.canvas.width, f.canvas.height]).toEqual(size)
    source.dispose()
  })

  it('leaves the pixels outside dest alone — it clears nothing (§7.3)', async () => {
    const f = open()
    const { gl } = f
    const { source, fit, clip, front } = await ready(f)
    // Paint the whole buffer green, then draw into the top-right quarter only.
    gl.clearColor(0, 1, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    const box = { x: 64, y: 64, w: 64, h: 64 }
    f.ctx.scope((s) => {
      // Enabling SCISSOR_TEST here stands in for the view (spec 7.3): a real render always has
      // a view perform a scissored clear over its own rect before calling draw. draw() itself
      // never touches SCISSOR_TEST — that bookkeeping belongs to the view, not the slot.
      s.enable('SCISSOR_TEST', true)
      return source.draw({
        clip,
        fit,
        frame: clip.keyFrames[5],
        front,
        out: { framebuffer: null, viewport: { x: 0, y: 0, w: 128, h: 128 }, dest: box },
        knobs: KNOBS,
      })
    })
    const px = new Uint8Array(4)
    gl.readPixels(4, 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    expect([...px]).toEqual([0, 255, 0, 255])
    source.dispose()
  })

  it('puts paper and nothing else on the screen at the ball, where alphaFloor is 1 (§4.2)', async () => {
    const f = open()
    const { gl } = f
    const { source, fit, clip, front } = await ready(f)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    f.ctx.scope(() =>
      source.draw({
        clip,
        fit,
        frame: clip.keyFrames[5],
        front,
        out: target(gl),
        knobs: KNOBS,
      }),
    )
    // The front is pure red. At floor 1 the shader returns mix(anything, paper, 1.0), so no red
    // channel dominance can survive anywhere in the ball.
    const px = new Uint8Array(128 * 128 * 4)
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let redDominant = 0
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 0 && px[i] > px[i + 1] + 40 && px[i] > px[i + 2] + 40) redDominant++
    }
    expect(redDominant).toBe(0)
    source.dispose()
  })

  it('is a GlError before mount, and a GlError after dispose', async () => {
    const f = open()
    const source = bakedMotion({ packs: [pack2x3] })
    const fit = source.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit
    const front = makeFront(f.gl)
    const clip: BakedClip = { bucket: '2x3', frameCount: 12, keyFrames: [0, 2, 4, 6, 8, 11] }
    expect(
      GlError.is(source.draw({ clip, fit, frame: 0, front, out: target(f.gl), knobs: KNOBS })),
    ).toBe(true)
    expect(source.mount(f.ctx)).toBeUndefined()
    source.dispose()
    expect(
      GlError.is(source.draw({ clip, fit, frame: 0, front, out: target(f.gl), knobs: KNOBS })),
    ).toBe(true)
  })

  it('is a GlError for a stored frame outside the clip, and for an unloaded bucket', async () => {
    const f = open()
    const { source, fit, clip, front } = await ready(f)
    f.ctx.scope(() => {
      const out = target(f.gl)
      expect(GlError.is(source.draw({ clip, fit, frame: 12, front, out, knobs: KNOBS }))).toBe(true)
      expect(GlError.is(source.draw({ clip, fit, frame: -1, front, out, knobs: KNOBS }))).toBe(true)
      const other: BakedClip = { bucket: '1x1', frameCount: 12, keyFrames: clip.keyFrames }
      expect(
        GlError.is(source.draw({ clip: other, fit, frame: 0, front, out, knobs: KNOBS })),
      ).toBe(true)
    })
    source.dispose()
  })

  it('builds the twelve VAOs once and reuses them across every later draw (§8.4)', async () => {
    const f = open()
    const { gl } = f
    const { source, fit, clip, front } = await ready(f)
    let created = 0
    const original = gl.createVertexArray.bind(gl)
    gl.createVertexArray = () => {
      created++
      return original()
    }
    f.ctx.scope(() => {
      const out = target(gl)
      for (const frame of clip.keyFrames)
        source.draw({ clip, fit, frame, front, out, knobs: KNOBS })
      for (const frame of clip.keyFrames)
        source.draw({ clip, fit, frame, front, out, knobs: KNOBS })
    })
    expect(created).toBe(12)
    gl.createVertexArray = original
    source.dispose()
  })

  it('returns a GlError, and not a raw KnobError, for a malformed paperColor/paperBack', async () => {
    const f = open()
    const { source, fit, clip, front } = await ready(f)
    const badKnobs = { ...KNOBS, paperColor: 'not a colour' } as never
    const r = f.ctx.scope(() => {
      const out = target(f.gl)
      return source.draw({ clip, fit, frame: 0, front, out, knobs: badKnobs })
    })
    expect(GlError.is(r)).toBe(true)
    source.dispose()
  })
})
