import { GlError } from '@paper-crumple/core'
import type { DrawTarget, MotionKnobs, SheetFront } from '@paper-crumple/core'
import { afterEach, describe, expect, it } from 'vitest'

import { MOTION_KNOBS } from './knobs.js'
import type { MotionLookKnobs } from './knobs.js'
import pack1x1 from './packs/1x1.js'
import pack2x3, { manifest as manifest2x3 } from './packs/2x3.js'
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
 * A 4x4 front with alpha 0 everywhere: a sheet that lies entirely OUTSIDE the torn/hull
 * silhouette, which is what the baked ball's outer shell is made of. NEAREST, so the sampled
 * alpha is exactly 0 and never a filtered in-between.
 */
function makeClearFront(gl: WebGL2RenderingContext): SheetFront {
  const texture = gl.createTexture() as WebGLTexture
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
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

  it('is a GlError when clip.bucket and fit.bucket disagree, even when both buckets are loaded', async () => {
    const f = open()
    const source = bakedMotion({ packs: [pack2x3, pack1x1] })
    expect(source.mount(f.ctx)).toBeUndefined()
    const fit2x3 = source.fit({ x: 0, y: 0, w: 256, h: 384 }) as BakedFit
    const fit1x1 = source.fit({ x: 0, y: 0, w: 256, h: 256 }) as BakedFit
    const clip2x3 = (await source.load(fit2x3)) as BakedClip
    const clip1x1 = (await source.load(fit1x1)) as BakedClip
    expect(clip2x3).not.toBeInstanceOf(Error)
    expect(clip1x1).not.toBeInstanceOf(Error)
    const front = makeFront(f.gl)
    const r = f.ctx.scope(() =>
      // Both buckets are loaded, so neither the "not loaded" nor the "frame out of range" guard
      // fires — without the clip/fit bucket-mismatch guard this would draw silently, with the
      // VAO from clip2x3.bucket but the sortKey from fit1x1.sortKey (Fix round item 7).
      source.draw({ clip: clip2x3, fit: fit1x1, frame: 0, front, out: target(f.gl), knobs: KNOBS }),
    )
    expect(GlError.is(r)).toBe(true)
    source.dispose()
  })

  it('builds the mesh inside its own scope: a bucket drawn for the first time with no outer ctx.scope() leaves the caller VAO untouched', async () => {
    const f = open()
    const { gl } = f
    const { source, fit, clip, front } = await ready(f)
    const callerVao = gl.createVertexArray()
    gl.bindVertexArray(callerVao)
    // No outer f.ctx.scope() here: this is the bucket's first draw, so meshFor() must build the
    // twelve VAOs. If that build runs outside draw()'s own scope it leaves VERTEX_ARRAY_BINDING
    // reset to null with nothing left to restore it (Fix round: BLOCKING 1).
    const r = source.draw({ clip, fit, frame: 0, front, out: target(gl), knobs: KNOBS })
    expect(r).not.toBeInstanceOf(Error)
    expect(gl.getParameter(gl.VERTEX_ARRAY_BINDING)).toBe(callerVao)
    gl.deleteVertexArray(callerVao)
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

/**
 * The draw runs with BLEND off under a depth-tested discard (§3.1), so a fragment that survives
 * the alpha test is written to the framebuffer as-is: a partial alpha there is not "half paper
 * over the fold behind" but "half page background through the ball", because the canvas is
 * `alpha: true` and the browser composites whatever alpha the sheet left. The compaction floor
 * (§9.1) therefore has exactly two legal outcomes per fragment on a shaded pose — discarded, or
 * solid — and the ramp's middle band (floor 0.4 … 1: pose 4 dwells there for 135 ms every run)
 * must produce the second, never a translucent shell.
 */
describe('the compaction shell under the no-blend draw (§3.1, §9.1)', () => {
  /** Every RGBA8 pixel of the fixture, plus the counts the assertions are phrased in. */
  function readAll(gl: WebGL2RenderingContext): {
    px: Uint8Array
    written: number
    partial: number
  } {
    const px = new Uint8Array(128 * 128 * 4)
    gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let written = 0
    let partial = 0
    for (let i = 3; i < px.length; i += 4) {
      if (px[i]! > 0) written++
      if (px[i]! > 0 && px[i]! < 255) partial++
    }
    return { px, written, partial }
  }

  function drawPose(
    f: GlFixture,
    r: Awaited<ReturnType<typeof ready>>,
    pose: number,
    front: SheetFront,
  ): void {
    f.gl.clearColor(0, 0, 0, 0)
    f.gl.clear(f.gl.COLOR_BUFFER_BIT | f.gl.DEPTH_BUFFER_BIT)
    const drawn = f.ctx.scope(() =>
      r.source.draw({
        clip: r.clip,
        fit: r.fit,
        frame: r.clip.keyFrames[pose]!,
        front,
        out: target(f.gl),
        knobs: KNOBS,
      }),
    )
    expect(drawn).not.toBeInstanceOf(Error)
  }

  it('the 2x3 ramp puts pose 3 below the alpha test and pose 4 inside the middle band', async () => {
    const f = open()
    const r = await ready(f)
    // The two poses the next tests draw, pinned to the floors that make them the interesting
    // ones: a change to the pack's ramp should fail here, by name, and not in a pixel count.
    expect(manifest2x3.frames[r.clip.keyFrames[3]!]!.alphaFloor).toBeLessThan(0.4)
    expect(manifest2x3.frames[r.clip.keyFrames[4]!]!.alphaFloor).toBeGreaterThanOrEqual(0.4)
    expect(manifest2x3.frames[r.clip.keyFrames[4]!]!.alphaFloor).toBeLessThan(1)
    r.source.dispose()
  })

  it('below the alpha test the floor still discards: a fully transparent front draws nothing at pose 3 (the documented early-flap gaps)', async () => {
    const f = open()
    const r = await ready(f)
    drawPose(f, r, 3, makeClearFront(f.gl))
    expect(readAll(f.gl).written).toBe(0)
    r.source.dispose()
  })

  it('once the floor clears the alpha test the out-of-silhouette sheet is solid paper: pose 4 writes no partial alpha', async () => {
    const f = open()
    const r = await ready(f)
    drawPose(f, r, 4, makeClearFront(f.gl))
    const shell = readAll(f.gl)
    expect(shell.written).toBeGreaterThan(0)
    expect(shell.partial).toBe(0)
    r.source.dispose()
  })

  it('at pose 4 the lifted shell covers exactly the pixels an opaque sheet covers', async () => {
    const f = open()
    const r = await ready(f)
    drawPose(f, r, 4, makeClearFront(f.gl))
    const lifted = readAll(f.gl).px
    drawPose(f, r, 4, makeFront(f.gl))
    const opaque = readAll(f.gl).px
    // Same mesh, same depth test, so the same fragments survive; only their colour may differ.
    // Comparing the alpha planes says the compaction paper is written with an opaque sheet's
    // coverage — nothing discarded that an opaque sheet keeps, nothing left half-covered.
    let differ = 0
    for (let i = 3; i < lifted.length; i += 4) if (lifted[i] !== opaque[i]) differ++
    expect(differ).toBe(0)
    r.source.dispose()
  })
})
