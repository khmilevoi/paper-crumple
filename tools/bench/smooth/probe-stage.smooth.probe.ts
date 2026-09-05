/**
 * Isolation probe: the real stage without the bench around it. Thirty mounted views take one
 * wave — `crumpleTo(sprite)` of sprites already resident (no ingest), `swapTo(url)` issued in one
 * synchronous loop (the burst as the bench issues it), or the same thirty `swapTo(url)` one task
 * apart — at DPR 1 and 2, with the stage's own `EXT_disjoint_timer_query_webgl2` around the wave
 * (`gpu` in the summary: the GPU's time on the stage's context, the 2D canvases' raster
 * excluded). One trace dump per configuration; the summary is a `probe-summary:` mark.
 *
 * Found with it (S10): a 30-URL wave is 168–331 ms of GPU time (5–11 ms per ingest) and 200–260
 * `getError` round trips; the storm's first `getError` (the allocation check in `resample`)
 * waited 230–408 ms behind one `GPUTask` in three of four synchronous-loop runs and never when
 * the thirty `swapTo` were a task apart.
 *
 *   BENCH_GPU=1 BENCH_TRACE_DUMP=1 pnpm bench:smooth -- --probe -t probe-stage
 */
import { describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
import { timerFor } from '../gl/harness.js'
import { artworkBlob } from './artwork.js'
import {
  bakedMotion,
  isAborted,
  pack1x1,
  pack2x3,
  pack3x2,
  paperSheet,
  paperStage,
  tiles,
} from './deps.js'
import type { BlitStage, Sprite, View } from './deps.js'

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve))
}

const cmd = commands as unknown as {
  smoothTrace: (action: 'start' | 'stop', label?: string) => Promise<unknown>
  smoothEmulate: (dpr: number, width: number, height: number) => Promise<void>
}

const VIEWS = 30
const CSS = { w: 125, h: 159 }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Config {
  readonly name: string
  readonly dpr: number
  readonly context2d: 'stage' | 'wrf-false' | 'wrf-true'
  /** `getImageData` on every canvas this many times before the traced wave. */
  readonly readbacksBefore: number
  /** `resident`: `crumpleTo(sprite)` of a sprite added before the wave; `url`: `swapTo(url)`;
   *  `url-spread`: the same thirty `swapTo(url)`, one per task (`setTimeout 0` apart). */
  readonly wave: 'resident' | 'url' | 'url-spread'
}

const CONFIGS: readonly Config[] = [
  { name: 'stage-dpr2-url', dpr: 2, context2d: 'stage', readbacksBefore: 0, wave: 'url' },
  {
    name: 'stage-dpr2-url-spread',
    dpr: 2,
    context2d: 'stage',
    readbacksBefore: 0,
    wave: 'url-spread',
  },
  { name: 'stage-dpr1-url', dpr: 1, context2d: 'stage', readbacksBefore: 0, wave: 'url' },
  {
    name: 'stage-dpr1-url-spread',
    dpr: 1,
    context2d: 'stage',
    readbacksBefore: 0,
    wave: 'url-spread',
  },
]

/** The bench's own pool: `makePool(8)` — 240 artworks drawn on 1024² OffscreenCanvases. */
const POOL_SLICES = 8

let urls: string[] = []

async function runConfig(c: Config): Promise<string> {
  await cmd.smoothEmulate(c.dpr, 1400, 900)
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1400px;height:900px;display:grid;' +
    `grid-template-columns:repeat(10,${CSS.w}px);grid-auto-rows:${CSS.h}px;gap:8px;padding:8px;` +
    'box-sizing:border-box;background:#e9e6df;overflow:hidden'
  document.body.append(host)
  const canvases: HTMLCanvasElement[] = []
  for (let i = 0; i < VIEWS; i++) {
    const canvas = document.createElement('canvas')
    canvas.style.cssText = `display:block;width:${CSS.w}px;height:${CSS.h}px`
    host.append(canvas)
    if (c.context2d === 'wrf-false') canvas.getContext('2d', { willReadFrequently: false })
    if (c.context2d === 'wrf-true') canvas.getContext('2d', { willReadFrequently: true })
    canvases.push(canvas)
  }
  const sheet = paperSheet({ edgeMode: 'hull', tiles, overscanHeadroom: 0.25 })
  const motion = bakedMotion({ packs: [pack1x1, pack2x3, pack3x2] })
  const stage = await paperStage({
    sheet,
    motion,
    artworkCssPx: 150,
    budget: 64 * 1024 * 1024,
    present: 'blit',
    onError: () => undefined,
  })
  if (stage instanceof Error || isAborted(stage)) return `probe ${c.name}: no stage`
  const s = stage as BlitStage
  const views: View[] = []
  for (let i = 0; i < VIEWS; i++) {
    const view = await s.mount({ key: `v${i}`, src: urls[i], canvas: canvases[i], fit: 'contain' })
    if (view instanceof Error || isAborted(view)) return `probe ${c.name}: mount failed`
    views.push(view)
  }
  const resident: Sprite[] = []
  for (let i = 0; c.wave === 'resident' && i < VIEWS; i++) {
    const sprite = await s.add(urls[VIEWS + i], { key: `r${i}` })
    if (sprite instanceof Error || isAborted(sprite)) return `probe ${c.name}: add failed`
    resident.push(sprite)
  }
  await sleep(300)
  for (let k = 0; k < c.readbacksBefore; k++) {
    for (const canvas of canvases) canvas.getContext('2d')?.getImageData(0, 0, 4, 4)
    await sleep(20)
  }
  await sleep(100)
  const surface = `${String(s.surface.width)}x${String(s.surface.height)}`
  // The GPU's own time for the wave on the stage's context (the 2D canvases' raster is outside).
  const glCanvas = s.surface.canvas as OffscreenCanvas
  const gl = glCanvas.getContext('webgl2')
  const timer = gl === null ? null : timerFor(gl)

  await cmd.smoothTrace('start')
  await sleep(50)
  performance.mark('smooth:storm:start')
  const t0 = performance.now()
  timer?.begin()
  const runs: PromiseLike<unknown>[] = []
  for (let i = 0; i < VIEWS; i++) {
    if (c.wave === 'url-spread' && i > 0) await sleep(0)
    runs.push(
      c.wave === 'resident'
        ? views[i].crumpleTo(resident[i], { duration: 500 })
        : views[i].swapTo(urls[VIEWS + i], { duration: 500 }),
    )
  }
  const settled = await Promise.all(runs)
  const total = performance.now() - t0
  timer?.end()
  let gpuMs: number | undefined
  for (let k = 0; k < 120 && gpuMs === undefined && timer !== null; k++) {
    await nextFrame()
    gpuMs = timer.poll()
  }
  await sleep(50)
  performance.mark('smooth:storm:end')
  const failed = settled.filter((r) => r instanceof Error).length
  const summary = `probe ${c.name}: surface ${surface}, wave ${total.toFixed(1)} ms, gpu ${gpuMs === undefined ? '-' : gpuMs.toFixed(1)} ms, failed ${String(failed)}`
  performance.mark(`probe-summary:${summary}`)
  await cmd.smoothTrace('stop', `probe.${c.name}`)
  timer?.dispose()
  s.dispose()
  host.remove()
  await cmd.smoothEmulate(1, 1400, 900)
  return summary
}

describe('probe-stage', () => {
  it('runs every configuration', async () => {
    const made = await Promise.all(
      Array.from({ length: POOL_SLICES * VIEWS }, (_, i) => artworkBlob(1000 + i, 1024)),
    )
    const failed = made.find((b) => b instanceof Error)
    expect(failed).toBeUndefined()
    for (const b of made) if (!(b instanceof Error)) urls.push(URL.createObjectURL(b))
    const out: string[] = []
    for (const c of CONFIGS) out.push(await runConfig(c))
    for (const url of urls) URL.revokeObjectURL(url)
    urls = []
    expect(out.every((x) => x.startsWith('probe '))).toBe(true)
  }, 600_000)
})
