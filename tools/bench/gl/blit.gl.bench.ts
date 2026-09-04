/**
 * `gl.blit.64` — sixty-four `present: 'blit'` copies out of one owned surface into sixty-four
 * destination canvases, exactly the sequence `blitOut` in `stage.ts` runs per view per step:
 * `getBoundingClientRect`, the managed backing-store rule, `clearRect`, `drawImage`.
 *
 * Two rows: `gl.blit.64` is a grid of 96 px CSS tiles (the managed store shrinks to 96²), and
 * `gl.blit.64.1to1` sizes each tile to the front so the store is the front's own 256x384.
 *
 * The WebGL side is idle here, so `finishMs` is ~0; the 2D canvases' own raster is drained by a
 * 1x1 `getImageData` on the last destination after each run and reported as `drain2dMs`.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { GL_ATTRIBUTES } from './deps.js'
import { flush, measure, stats } from './harness.js'

afterAll(flush)

const FRONT = { w: 256, h: 384 }
const SURFACE = 1024

function paintSurface(gl: WebGL2RenderingContext): void {
  gl.disable(gl.SCISSOR_TEST)
  gl.clearColor(0.9, 0.85, 0.7, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.enable(gl.SCISSOR_TEST)
  for (let i = 0; i < 16; i++) {
    gl.scissor(0, i * 24, FRONT.w, 12)
    gl.clearColor(i / 16, 0.2, 1 - i / 16, i % 2 === 0 ? 1 : 0.5)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  gl.disable(gl.SCISSOR_TEST)
  gl.finish()
}

function tiles(
  cssW: number,
  cssH: number,
): { host: HTMLDivElement; canvases: HTMLCanvasElement[] } {
  const host = document.createElement('div')
  host.style.display = 'flex'
  host.style.flexWrap = 'wrap'
  host.style.width = `${cssW * 8}px`
  const canvases: HTMLCanvasElement[] = []
  for (let i = 0; i < 64; i++) {
    const c = document.createElement('canvas')
    c.style.width = `${cssW}px`
    c.style.height = `${cssH}px`
    host.append(c)
    canvases.push(c)
  }
  document.body.append(host)
  return { host, canvases }
}

/** `blitOut` from `stage.ts`, with `managedBackingStore` and `blitPlan` (fit `contain`) inlined. */
function blitOne(surface: OffscreenCanvas, canvas: HTMLCanvasElement, dpr: number): void {
  const c2d = canvas.getContext('2d')
  if (c2d === null) return
  const rect = canvas.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) {
    const boxW = Math.max(1, Math.round(rect.width * dpr))
    const boxH = Math.max(1, Math.round(rect.height * dpr))
    const k = Math.min(1, Math.max(FRONT.w / boxW, FRONT.h / boxH))
    const w = Math.max(1, Math.round(boxW * k))
    const h = Math.max(1, Math.round(boxH * k))
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w
      canvas.height = h
    }
  }
  const scale = Math.min(canvas.width / FRONT.w, canvas.height / FRONT.h)
  const dw = Math.round(FRONT.w * scale)
  const dh = Math.round(FRONT.h * scale)
  const dx = Math.round((canvas.width - dw) / 2)
  const dy = Math.round((canvas.height - dh) / 2)
  c2d.clearRect(0, 0, canvas.width, canvas.height)
  c2d.drawImage(surface, 0, SURFACE - FRONT.h, FRONT.w, FRONT.h, dx, dy, dw, dh)
}

describe('gl.blit', () => {
  it('gl.blit.64', async () => {
    const surface = new OffscreenCanvas(SURFACE, SURFACE)
    const gl = surface.getContext('webgl2', GL_ATTRIBUTES)
    expect(gl).not.toBeNull()
    if (gl === null) return
    paintSurface(gl)
    const dpr = globalThis.devicePixelRatio || 1

    for (const [name, cssW, cssH] of [
      ['gl.blit.64', 96, 96],
      ['gl.blit.64.1to1', FRONT.w, FRONT.h],
    ] as const) {
      const { host, canvases } = tiles(cssW, cssH)
      const drains: number[] = []
      await measure(name, {
        gl,
        run: () => {
          for (const canvas of canvases) blitOne(surface, canvas, dpr)
        },
        after: () => {
          const last = canvases[canvases.length - 1].getContext('2d')
          const t = performance.now()
          last?.getImageData(0, 0, 1, 1)
          drains.push(performance.now() - t)
        },
        extra: () => ({
          drain2dMs: stats(drains).median,
          store: `${canvases[0].width}x${canvases[0].height}`,
          perBlitUs: 0,
        }),
        note: 'getBoundingClientRect + managed store + clearRect + drawImage(WebGL canvas) x64; drain2dMs is a 1x1 getImageData on the last tile',
      })
      host.remove()
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  })
})
