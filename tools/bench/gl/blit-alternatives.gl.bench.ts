/**
 * `gl.blit.alt.*` — the same sixty-four-tile copy-out done four ways, so the blit path can be
 * chosen on numbers rather than on folklore:
 *
 * - `drawImage`: today's `blitOut` — `drawImage(surface, srcRect, destRect)` from the stage's
 *   `preserveDrawingBuffer: true` surface into a 2D destination.
 * - `drawImage.noPreserve`: the same from a surface created with `preserveDrawingBuffer: false`,
 *   to see whether the preserve attribute changes the copy path.
 * - `transferToImageBitmap`: `surface.transferToImageBitmap()` + `bitmaprenderer` on the
 *   destination. The transfer takes the WHOLE surface and resets it, so this variant runs from a
 *   front-sized surface (the stage's 1024² one cannot be transferred per view without resizing,
 *   which §7.3 forbids) and repaints it before every transfer — the repaint is inside the timed
 *   window and is a handful of clears.
 * - `createImageBitmap.crop`: `createImageBitmap(surface, sx, sy, w, h)` — the sub-rect crop the
 *   stage would need — for all sixty-four tiles, awaited together, then `transferFromImageBitmap`.
 *   Asynchronous by nature; `callMs` is the wall-clock of the whole batch.
 *
 * "Time to visible" has no API in a headless page. What is reported as `drainMs` is a 1x1
 * readback of the LAST destination through a scratch 2D canvas after each run, which forces that
 * destination's contents to be resolved: the nearest available proxy for "the pixels exist".
 */
import { afterAll, describe, expect, it } from 'vitest'
import { GL_ATTRIBUTES } from './deps.js'
import { flush, measure, stats } from './harness.js'

afterAll(flush)

const FRONT = { w: 256, h: 384 }
const SURFACE = 1024
const TILE = 96

function paint(gl: WebGL2RenderingContext, w: number, h: number): void {
  gl.disable(gl.SCISSOR_TEST)
  gl.viewport(0, 0, w, h)
  gl.clearColor(0.9, 0.85, 0.7, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.enable(gl.SCISSOR_TEST)
  for (let i = 0; i < 16; i++) {
    gl.scissor(0, i * 24, FRONT.w, 12)
    gl.clearColor(i / 16, 0.2, 1 - i / 16, i % 2 === 0 ? 1 : 0.5)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  gl.disable(gl.SCISSOR_TEST)
}

function tiles(): { host: HTMLDivElement; canvases: HTMLCanvasElement[] } {
  const host = document.createElement('div')
  host.style.display = 'flex'
  host.style.flexWrap = 'wrap'
  host.style.width = `${TILE * 8}px`
  const canvases: HTMLCanvasElement[] = []
  for (let i = 0; i < 64; i++) {
    const c = document.createElement('canvas')
    c.style.width = `${TILE}px`
    c.style.height = `${TILE}px`
    c.width = TILE
    c.height = TILE
    host.append(c)
    canvases.push(c)
  }
  document.body.append(host)
  return { host, canvases }
}

function contain(canvas: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(canvas.width / FRONT.w, canvas.height / FRONT.h)
  const w = Math.round(FRONT.w * scale)
  const h = Math.round(FRONT.h * scale)
  return { x: Math.round((canvas.width - w) / 2), y: Math.round((canvas.height - h) / 2), w, h }
}

function drawImageBlit(
  surface: OffscreenCanvas,
  surfaceH: number,
  canvases: readonly HTMLCanvasElement[],
): void {
  for (const canvas of canvases) {
    const c2d = canvas.getContext('2d')
    if (c2d === null) continue
    canvas.getBoundingClientRect()
    const d = contain(canvas)
    c2d.clearRect(0, 0, canvas.width, canvas.height)
    c2d.drawImage(surface, 0, surfaceH - FRONT.h, FRONT.w, FRONT.h, d.x, d.y, d.w, d.h)
  }
}

/** Forces the last destination to resolve: draw it into a scratch 2D canvas and read one texel. */
function drainLast(
  canvases: readonly HTMLCanvasElement[],
  scratch: CanvasRenderingContext2D,
): number {
  const t = performance.now()
  scratch.drawImage(canvases[canvases.length - 1], 0, 0)
  scratch.getImageData(0, 0, 1, 1)
  return performance.now() - t
}

describe('gl.blit.alternatives', () => {
  it('gl.blit.alt', async () => {
    const scratchCanvas = document.createElement('canvas')
    scratchCanvas.width = TILE
    scratchCanvas.height = TILE
    const scratch = scratchCanvas.getContext('2d')
    expect(scratch).not.toBeNull()
    if (scratch === null) return

    // (a) today's path.
    const surface = new OffscreenCanvas(SURFACE, SURFACE)
    const gl = surface.getContext('webgl2', GL_ATTRIBUTES)
    expect(gl).not.toBeNull()
    if (gl === null) return
    paint(gl, SURFACE, SURFACE)
    gl.finish()
    {
      const { host, canvases } = tiles()
      const drains: number[] = []
      await measure('gl.blit.alt.drawImage', {
        gl,
        run: () => drawImageBlit(surface, SURFACE, canvases),
        after: () => {
          drains.push(drainLast(canvases, scratch))
        },
        extra: () => ({ drainMs: stats(drains).median }),
        note: 'drawImage(preserveDrawingBuffer surface, front sub-rect) into 64 2D canvases — blitOut today',
      })
      host.remove()
    }

    // (b) the same from a surface without preserveDrawingBuffer.
    const surfaceNp = new OffscreenCanvas(SURFACE, SURFACE)
    const glNp = surfaceNp.getContext('webgl2', { ...GL_ATTRIBUTES, preserveDrawingBuffer: false })
    expect(glNp).not.toBeNull()
    if (glNp === null) return
    {
      const { host, canvases } = tiles()
      const drains: number[] = []
      await measure('gl.blit.alt.drawImage.noPreserve', {
        gl: glNp,
        before: () => {
          // Without preserve the buffer may be cleared once presented; repaint inside the
          // same task, as a draw-then-blit step would.
          paint(glNp, SURFACE, SURFACE)
        },
        run: () => drawImageBlit(surfaceNp, SURFACE, canvases),
        after: () => {
          drains.push(drainLast(canvases, scratch))
        },
        extra: () => ({ drainMs: stats(drains).median }),
        note: 'drawImage from a preserveDrawingBuffer: false surface, repainted before each run',
      })
      host.remove()
    }

    // (c) transferToImageBitmap from a front-sized surface + bitmaprenderer.
    const small = new OffscreenCanvas(FRONT.w, FRONT.h)
    const glSmall = small.getContext('webgl2', GL_ATTRIBUTES)
    expect(glSmall).not.toBeNull()
    if (glSmall === null) return
    {
      const { host, canvases } = tiles()
      const renderers = canvases.map((c) => c.getContext('bitmaprenderer'))
      const drains: number[] = []
      await measure('gl.blit.alt.transferToImageBitmap', {
        gl: glSmall,
        run: () => {
          for (const r of renderers) {
            if (r === null) continue
            paint(glSmall, FRONT.w, FRONT.h)
            r.transferFromImageBitmap(small.transferToImageBitmap())
          }
        },
        after: () => {
          drains.push(drainLast(canvases, scratch))
        },
        extra: () => ({ drainMs: stats(drains).median, surface: `${FRONT.w}x${FRONT.h}` }),
        note: 'per tile: repaint a front-sized surface, transferToImageBitmap(), transferFromImageBitmap() on a bitmaprenderer destination; the destination shows the whole bitmap, no contain',
      })
      host.remove()
    }

    // (d) createImageBitmap crop of the big surface + bitmaprenderer.
    {
      const { host, canvases } = tiles()
      const renderers = canvases.map((c) => c.getContext('bitmaprenderer'))
      const drains: number[] = []
      await measure('gl.blit.alt.createImageBitmap.crop', {
        gl,
        run: async () => {
          const bitmaps = await Promise.all(
            renderers.map(() =>
              createImageBitmap(surface, 0, SURFACE - FRONT.h, FRONT.w, FRONT.h, {
                resizeWidth: TILE,
                resizeHeight: TILE,
              }),
            ),
          )
          for (let i = 0; i < renderers.length; i++)
            renderers[i]?.transferFromImageBitmap(bitmaps[i])
        },
        after: () => {
          drains.push(drainLast(canvases, scratch))
        },
        extra: () => ({ drainMs: stats(drains).median }),
        note: '64 x createImageBitmap(surface, front sub-rect, resize to the tile) awaited together, then transferFromImageBitmap',
      })
      host.remove()
    }

    for (const g of [gl, glNp, glSmall]) g.getExtension('WEBGL_lose_context')?.loseContext()
  })
})
