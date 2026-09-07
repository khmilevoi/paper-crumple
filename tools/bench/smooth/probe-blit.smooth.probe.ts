/**
 * Isolation probe: the blit path alone, without the library. Thirty 2D canvases at the grid's
 * CSS size draw a sub-rect of one WebGL2 OffscreenCanvas (`preserveDrawingBuffer: true`, as the
 * stage's) once per wave, eleven waves a frame apart — the step waves of a burst — at the real
 * rows' geometries (DPR 1 and 2, the managed store, the front's downscale, the clear bars, the
 * stage's power preference) and at surface sizes up to 2048². Each configuration writes one
 * trace dump, so the `stalls` reader can count `ReadbackImagePixels` / `RasterCHROMIUM` per
 * blit and the GPU task time; the in-page summary travels out as a `probe-summary:` mark.
 *
 * Found with it (S10): a 2048² preserved surface costs one full-surface snapshot per `drawImage`
 * and produced 300–560 ms `GPUTask`s from 330 blits; at the rows' 192²–512² the same blits are
 * 0.1–0.3 ms each and never stall.
 *
 *   BENCH_GPU=1 BENCH_TRACE_DUMP=1 pnpm bench:smooth -- --probe -t probe-blit
 */
import { describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'

const cmd = commands as unknown as {
  smoothTrace: (action: 'start' | 'stop', label?: string) => Promise<unknown>
  smoothEmulate: (dpr: number, width: number, height: number) => Promise<void>
}

const VIEWS = 30
const CSS = { w: 125, h: 159 }
const WAVES = 11

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

interface Config {
  readonly name: string
  readonly dpr: number
  readonly store: { w: number; h: number }
  readonly surface: number
  /** The source rect, as `blitPlan` picks it: the front's box on the surface. Default: the store. */
  readonly src?: { w: number; h: number }
  /** `blitOut`'s clear bars before the draw. */
  readonly bars?: boolean
  /** The stage's `GL_ATTRIBUTES.powerPreference`. */
  readonly power?: WebGLPowerPreference
}

const CONFIGS: readonly Config[] = [
  // The real rows: the front as the sheet sizes it at each DPR, on a surface of the stage's size.
  {
    name: 'dpr1-real',
    dpr: 1,
    store: { w: 125, h: 159 },
    surface: 256,
    src: { w: 125, h: 159 },
    bars: true,
  },
  {
    name: 'dpr2-real',
    dpr: 2,
    store: { w: 250, h: 318 },
    surface: 512,
    src: { w: 249, h: 320 },
    bars: true,
  },
  {
    name: 'dpr2-real-highperf',
    dpr: 2,
    store: { w: 250, h: 318 },
    surface: 512,
    src: { w: 249, h: 320 },
    bars: true,
    power: 'high-performance',
  },
  {
    name: 'dpr1-real-highperf',
    dpr: 1,
    store: { w: 125, h: 159 },
    surface: 256,
    src: { w: 125, h: 159 },
    bars: true,
    power: 'high-performance',
  },
  // Bisect: the downscale alone, the bars alone, the surface alone.
  {
    name: 'dpr2-down-nobars',
    dpr: 2,
    store: { w: 250, h: 318 },
    surface: 512,
    src: { w: 249, h: 320 },
  },
  { name: 'dpr2-exact-bars', dpr: 2, store: { w: 250, h: 318 }, surface: 512, bars: true },
  { name: 'dpr1-down', dpr: 1, store: { w: 125, h: 159 }, surface: 256, src: { w: 125, h: 160 } },
  { name: 'dpr1-store125-surf2048', dpr: 1, store: { w: 125, h: 159 }, surface: 2048 },
]

async function runConfig(c: Config): Promise<string> {
  await cmd.smoothEmulate(c.dpr, 1400, 900)
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1400px;height:900px;display:grid;' +
    `grid-template-columns:repeat(10,${CSS.w}px);grid-auto-rows:${CSS.h}px;gap:8px;padding:8px;` +
    'box-sizing:border-box;background:#e9e6df;overflow:hidden'
  document.body.append(host)
  const canvases: HTMLCanvasElement[] = []
  const ctxs: CanvasRenderingContext2D[] = []
  for (let i = 0; i < VIEWS; i++) {
    const canvas = document.createElement('canvas')
    canvas.style.cssText = `display:block;width:${CSS.w}px;height:${CSS.h}px`
    host.append(canvas)
    const c2d = canvas.getContext('2d')
    if (c2d === null) return 'no 2d'
    canvas.width = c.store.w
    canvas.height = c.store.h
    canvases.push(canvas)
    ctxs.push(c2d)
  }
  const off = new OffscreenCanvas(c.surface, c.surface)
  const gl = off.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    ...(c.power === undefined ? {} : { powerPreference: c.power }),
  })
  if (gl === null) return 'no webgl2'
  gl.clearColor(0.2, 0.4, 0.6, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.finish()
  await nextFrame()
  await nextFrame()

  await cmd.smoothTrace('start')
  await nextFrame()
  performance.mark('smooth:storm:start')
  const t0 = performance.now()
  const waveMs: number[] = []
  for (let w = 0; w < WAVES; w++) {
    const tw = performance.now()
    for (let i = 0; i < VIEWS; i++) {
      // The step's own draw: a small scissored clear into the surface, as the stage's draw would.
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(0, 0, CSS.w, CSS.h)
      gl.clearColor((w * 30 + i) / 330, 0.5, 0.5, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.disable(gl.SCISSOR_TEST)
      const src = c.src ?? c.store
      if (c.bars === true) {
        ctxs[i].clearRect(0, 0, c.store.w, 1)
        ctxs[i].clearRect(0, c.store.h - 1, c.store.w, 1)
      }
      ctxs[i].drawImage(off, 0, 0, src.w, src.h, 0, 0, c.store.w, c.store.h)
    }
    waveMs.push(performance.now() - tw)
    await nextFrame()
  }
  const frames: number[] = []
  let last = performance.now()
  for (let k = 0; k < 6; k++) {
    const now = await nextFrame()
    frames.push(now - last)
    last = now
  }
  const total = performance.now() - t0
  performance.mark('smooth:storm:end')
  const summary = `probe ${c.name}: total ${total.toFixed(1)} ms, wave js ms [${waveMs.map((x) => x.toFixed(1)).join(' ')}], settle frames [${frames.map((x) => x.toFixed(1)).join(' ')}]`
  performance.mark(`probe-summary:${summary}`)
  await cmd.smoothTrace('stop', `probe.${c.name}`)
  host.remove()
  await cmd.smoothEmulate(1, 1400, 900)
  return summary
}

describe('probe-blit', () => {
  it('runs every configuration', async () => {
    const out: string[] = []
    for (const c of CONFIGS) out.push(await runConfig(c))
    // The summaries travel out through the trace marks; this assertion only keeps the run honest.
    expect(out.every((s) => s.startsWith('probe '))).toBe(true)
  }, 600_000)
})
