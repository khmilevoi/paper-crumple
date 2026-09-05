/**
 * `gl.pose.draw.64` — sixty-four pose draws through `bakedMotion`, each preceded by the scissored
 * clear `drawInto` in `stage.ts` performs and each inside its own `ctx.scope()`, which is what a
 * step on a sixteen-view grid costs the GL side before the blit. `gl.pose.draw.64.batched` puts
 * all sixty-four inside ONE scope (`stage.batch`), so the difference between the two rows is the
 * price of sixty-three capture/restore pairs. `gl.pose.draw.1` is one draw on its own.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { bakedMotion, GlError, isAborted, MOTION_KNOBS, pack2x3, uploadBytes } from './deps.js'
import type { DrawTarget, MotionKnobs, MotionLookKnobs, SheetFront } from './deps.js'
import { flush, measure, openFixture, silhouetteBytes } from './harness.js'

afterAll(flush)

const FRONT = { w: 256, h: 384 }
const SIDE = 512

describe('gl.pose', () => {
  it('gl.pose.draw.64', async () => {
    const f = openFixture(SIDE, SIDE)
    expect(f).not.toBeInstanceOf(Error)
    if (f instanceof Error) return
    const { gl } = f

    const source = bakedMotion({ packs: [pack2x3] })
    expect(source.mount(f.ctx)).toBeUndefined()
    const fit = source.fit({ x: 0, y: 0, w: FRONT.w, h: FRONT.h })
    expect(fit).not.toBeInstanceOf(Error)
    if (fit instanceof Error) return
    const clip = await source.load(fit)
    expect(clip).not.toBeInstanceOf(Error)
    if (clip instanceof Error || isAborted(clip)) return

    const frontTexture = f.ctx.texture({
      width: FRONT.w,
      height: FRONT.h,
      format: 'RGBA8',
      filter: 'LINEAR',
      label: 'front',
    })
    expect(GlError.is(frontTexture)).toBe(false)
    if (GlError.is(frontTexture)) return
    expect(
      f.ctx.scope(() => uploadBytes(gl, frontTexture, silhouetteBytes(FRONT.w, FRONT.h))),
    ).toBeUndefined()
    const front: SheetFront = {
      texture: frontTexture.handle,
      width: FRONT.w,
      height: FRONT.h,
      rect: { x: 0, y: 0, w: FRONT.w, h: FRONT.h },
      artwork: { x: 32, y: 48, w: 192, h: 288 },
      bytes: FRONT.w * FRONT.h * 4,
    }
    const knobs = {
      ...Object.fromEntries(MOTION_KNOBS.map((k) => [k.key, k.default])),
      paperColor: '#f7f4ed',
      paperBack: '#e8e2d4',
    } as unknown as Readonly<MotionKnobs<MotionLookKnobs>>

    const viewport = { x: 0, y: 0, w: SIDE, h: SIDE }
    const cells: DrawTarget[] = []
    for (let i = 0; i < 64; i++) {
      cells.push({
        framebuffer: null,
        viewport,
        dest: { x: (i % 8) * 64, y: Math.floor(i / 8) * 64, w: 64, h: 64 },
      })
    }

    /** `drawInto` in `stage.ts`, minus the knob projection: the scissored clear, then the slot. */
    const drawOne = (i: number, s: Parameters<Parameters<typeof f.ctx.scope>[0]>[0]): unknown => {
      const out = cells[i]
      s.bindTarget(out)
      gl.disable(gl.STENCIL_TEST)
      s.enable('SCISSOR_TEST', true)
      gl.scissor(out.dest.x, out.dest.y, out.dest.w, out.dest.h)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      s.enable('SCISSOR_TEST', false)
      return source.draw({
        clip,
        fit,
        frame: clip.keyFrames[i % clip.keyFrames.length],
        front,
        out,
        knobs,
      })
    }

    await measure('gl.pose.draw.64', {
      gl,
      timer: f.timer,
      run: () => {
        for (let i = 0; i < 64; i++) {
          const r = f.ctx.scope((s) => drawOne(i, s))
          if (r instanceof Error) return r
        }
        return undefined
      },
      extra: () => ({ indexCount: 24576, vertices: 4225 }),
      note: 'per draw: one ctx.scope (as stage.drawInto), scissored clear, then motion.draw with its own nested scope',
    })

    await measure('gl.pose.draw.64.batched', {
      gl,
      timer: f.timer,
      run: () =>
        f.ctx.scope((s) => {
          for (let i = 0; i < 64; i++) {
            const r = drawOne(i, s)
            if (r instanceof Error) return r
          }
          return undefined
        }),
      note: 'the same sixty-four draws inside ONE outer scope (stage.batch); motion.draw still opens its own',
    })

    await measure('gl.pose.draw.1', {
      gl,
      timer: f.timer,
      run: () => f.ctx.scope((s) => drawOne(0, s)),
    })

    frontTexture.dispose()
    source.dispose()
    f.dispose()
  })
})
