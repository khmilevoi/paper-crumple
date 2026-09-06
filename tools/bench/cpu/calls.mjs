/**
 * GL call-count scenarios: the real `paperSheet`, `bakedMotion` and `createStage`, driven under
 * Node against the recording context in `recording-gl.mjs`. Each scenario returns the count of
 * every tracked GL call issued by ONE operation, warm (programs compiled, pools allocated, the
 * bucket's mesh built) unless the name says `.cold`.
 *
 *   calls.add.1024.hull   stage.add of a 1024x1024 artwork in hull mode (source + fit + load + build)
 *   calls.add.1024.torn   the same in torn mode
 *   calls.step.grid1|16|64  one dwell tick of stage.play over N views (N draws + N blits)
 *   calls.refresh         view.refresh(): one draw + blit at the current pose
 *
 * The counts are what the optimisation tasks are judged against: `syncQueries` is the sum of the
 * calls a browser cannot answer without a GPU-process round trip, and `captures` is how many
 * times `captureGlState` ran (33 getParameter + 5 isEnabled each).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { DWELL_MS } from '@paper-crumple/core'
import { cpuSdfFromAlpha, freezeOverscan, paperSheet } from '@paper-crumple/paper'
import { frontForArtwork } from '../../../packages/paper/src/handle.ts'
import { bakedMotion } from '@paper-crumple/motion'
import pack1x1 from '../../../packages/motion/src/packs/1x1.ts'
import pack2x3 from '../../../packages/motion/src/packs/2x3.ts'
import pack3x2 from '../../../packages/motion/src/packs/3x2.ts'
import { createStage } from '../../../packages/core/src/stage.ts'
import { logoArtwork } from './artworks.mjs'
import { createRecordingGl } from './recording-gl.mjs'
import { createBenchTimers } from './timers.mjs'

const ARTWORK = 1024
const MAX_SIZE = 1024

/** `loadPack` fetches the pack binary; under Node that is a file read. */
async function fileFetch(url) {
  const bytes = readFileSync(fileURLToPath(url))
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return { ok: true, status: 200, arrayBuffer: async () => buffer }
}

/** A distinct bitmap-like per sprite (paper keys its slot by object identity). */
function bitmapLike(size) {
  return { width: size, height: size, close() {} }
}

const ctx2d = { clearRect() {}, drawImage() {} }
function viewCanvas() {
  return {
    width: 64,
    height: 64,
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
  }
}

/**
 * Fix round 1 (Task 2): core's `EdgeParams` is now the single-radius shape (design 2026-09-05
 * §4.1) — `edgeParamsFrom` (paper-knobs.ts) still builds the OLD `{ mode, maxDist, ... }` shape
 * and is itself Task 4/7's rebuild, so this bench's direct `freezeOverscan` composition (bypassing
 * `paperSheet()`, used only to size the synthetic readback field below) cannot route through it
 * any more. Reproduces the plan's own library defaults instead — `widthRef 47`, `variance 0.53`,
 * zero finish terms under a clean finish — the same reserve `paperSheet()`'s defaults build once
 * Task 7 rewires it. Task 7 should revisit this once `edgeParamsFrom` exists in the new
 * vocabulary, so the bench derives its params the same way the library does.
 */
function readbackEdgeParams() {
  return { widthRef: 47, variance: 0.53, fiberLen: 0, deckleWidth: 0 }
}

/**
 * What `readPixels` hands back for pass A: the CPU signed field of the logo at the field's own
 * size, in FRONT pixels (`readBackField` divides by the texel size), with the artwork sitting
 * inside the front at the margin the mode's frozen reserve gives it (`frontForArtwork`, spec
 * 8.6) — so the silhouette plus the mode's paint radius stays inside the guard band exactly as
 * a real full-bleed artwork does. Memoised per mode and size — the hull trace is the point, not
 * the field's provenance.
 */
function readbackFor() {
  const reserve = freezeOverscan(readbackEdgeParams(), 0)
  const framing = frontForArtwork({
    overscan: reserve.overscan,
    srcW: ARTWORK,
    srcH: ARTWORK,
    maxSize: MAX_SIZE,
    exact: false,
  })
  const inset = framing.marginX / framing.front.w
  const fields = new Map()
  return (w, h, out) => {
    const key = `${w}x${h}`
    let field = fields.get(key)
    if (field === undefined) {
      const art = logoArtwork(w, { seed: 7, inset })
      const texel = framing.front.w / w
      field = cpuSdfFromAlpha(art.alpha01, w, h)
      for (let i = 0; i < field.length; i++) field[i] *= texel
      fields.set(key, field)
    }
    out.set(field.subarray(0, w * h))
  }
}

/**
 * `BENCH_CAPTURE_SITES=1` attributes every capture to its call site (costs a stack per capture);
 * `BENCH_TRACE_ALLOCATIONS=1` logs every `texStorage2D` with its format, size and caller.
 */
const traceCaptures = process.env.BENCH_CAPTURE_SITES === '1'
const traceAllocations = process.env.BENCH_TRACE_ALLOCATIONS === '1'

async function realStage(edgeMode) {
  const rec = createRecordingGl({
    readback: readbackFor(),
    traceCaptures,
    traceAllocations,
  })
  const timers = createBenchTimers()
  const sheet = paperSheet({ edgeMode, tiles: null })
  const motion = bakedMotion({ packs: [pack1x1, pack2x3, pack3x2], fetch: fileFetch })
  const stage = await createStage(
    { sheet, motion, maxSize: MAX_SIZE, present: 'blit' },
    {
      surface: {
        makeOffscreen: (w, h) => {
          rec.canvas.width = w
          rec.canvas.height = h
          return rec.canvas
        },
      },
      timers,
      dpr: 1,
    },
  )
  if (stage instanceof Error || typeof stage === 'symbol') return Promise.reject(stage)
  let n = 0
  const add = async () => {
    const key = `art-${n++}`
    const sprite = await stage.add(bitmapLike(ARTWORK), { key, pin: true })
    if (sprite instanceof Error || typeof sprite === 'symbol') return Promise.reject(sprite)
    return sprite
  }
  const show = (sprite) => {
    const view = stage.view({ canvas: viewCanvas(), tag: sprite.key })
    if (view instanceof Error) return Promise.reject(view)
    view.show(sprite)
    return view
  }
  return { rec, timers, stage, add, show }
}

async function measure(rec, fn) {
  rec.reset()
  const t0 = performance.now()
  await fn()
  const ms = performance.now() - t0
  return { ...rec.snapshot(), ms }
}

function addScenario(edgeMode) {
  return {
    name: `calls.add.1024.${edgeMode}`,
    note: `stage.add of a ${ARTWORK}x${ARTWORK} artwork at maxSize ${MAX_SIZE}, ${edgeMode} mode, warm`,
    run: async () => {
      const s = await realStage(edgeMode)
      const cold = await measure(s.rec, () => s.add())
      const warm = await measure(s.rec, () => s.add())
      s.stage.dispose()
      return { warm, cold }
    },
  }
}

function stepScenario(n) {
  return {
    name: `calls.step.grid${n}`,
    note: `one dwell tick of stage.play over ${n} views (hull mode), warm`,
    run: async () => {
      const s = await realStage('hull')
      const sprites = []
      for (let i = 0; i < n; i += 1) sprites.push(await s.add())
      const views = sprites.map((sprite) => s.show(sprite))
      if (views.some((v) => v instanceof Promise)) return Promise.reject(new Error('view refused'))
      // A full run first, so every bucket's mesh exists and the first draw's cost is out.
      s.stage.play('flat', 'ball')
      s.timers.advance(10_000)
      await null
      s.stage.play('flat', 'ball')
      // Tick 0 fired inside play(); tick 1 is the first timer-driven step.
      const warm = await measure(s.rec, async () => {
        s.timers.advance(DWELL_MS[0])
      })
      s.timers.advance(10_000)
      s.stage.dispose()
      return { warm }
    },
  }
}

const refreshScenario = {
  name: 'calls.refresh',
  note: 'view.refresh() on a shown view: one draw + one blit at the current pose, warm',
  run: async () => {
    const s = await realStage('hull')
    const sprite = await s.add()
    const view = s.show(sprite)
    if (view instanceof Promise) return view
    view.refresh()
    const warm = await measure(s.rec, async () => {
      view.refresh()
    })
    s.stage.dispose()
    return { warm }
  },
}

export const callScenarios = [
  addScenario('hull'),
  addScenario('torn'),
  stepScenario(1),
  stepScenario(16),
  stepScenario(64),
  refreshScenario,
]
