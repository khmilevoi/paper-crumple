/**
 * swap-30 — thirty on-screen views swapping images: smoothness and input blocking.
 *
 * **Scenario.** A 6×5 grid of 30 `{ canvas }` views on a `present: 'blit'` stage built the way the
 * playground builds one (`examples/playground/src/config.ts`): `paperSheet({ edgeMode: 'hull',
 * tiles, overscanHeadroom: 0.25 })`, `bakedMotion` with the three packs, `artworkCssPx`, a 64 MiB
 * budget. Every view shows a distinct synthetic 1024² artwork (`artwork.ts` — per-image variation,
 * so the hull cache never answers a swap). "Swap" is the call the playground makes when the reader
 * picks another image: `view.swapTo(url, { duration: 900 })` (`ui/App.tsx:349`,
 * `SWAP_DURATION_MS`), which is `stage.add(url, { key })` + `view.crumpleTo(pending)` (spec §4.2,
 * `stage.ts` `swapToMethod`) — here on a blob URL, so the fetch and the decode are the real ones.
 * The `bitmap` rows swap from pre-decoded `ImageBitmap`s through the same composition spelled
 * out — `view.crumpleTo(stage.add(bitmap, { key, pin: true }), { duration })` — because `swapTo`
 * mints no `pin` and a bare bitmap needs one (§4.1). The canvas box is fixed and the front is
 * `fit: 'contain'`ed into it; the playground's per-step `frameHero` re-layout is not replicated,
 * so the layout-read cost here is the floor a page pays, not the ceiling.
 *
 * **Rows (cadences).** The five the smooth-swap plan requires, plus three the bench also keeps.
 *   - `sequential` (`smooth.sequential.dpr1`) — **the ideal**: thirty `await stage.add(url_i,
 *     { key })` one after another, on a stage with **no views** at all. Nothing overlaps, so its
 *     per-add median is what the same thirty images cost when nothing is contended, and
 *     `sequentialIdealMs = 30 × that median` is the floor every other row's storm is judged
 *     against. Its own task / frame / input columns say how smooth the ideal itself is.
 *   - `burst-url` (`smooth.burst.url.dpr1`) — all 30 `swapTo(url)` calls in one synchronous block
 *     (a "next page" click).
 *   - `burst-bitmap` (`smooth.burst.bitmap.dpr1`) — the 30 bitmaps are decoded with
 *     `createImageBitmap` **before** the timed window; the window is one synchronous loop of 30
 *     `stage.add(bitmap, { key, pin: true })`, then `Promise.all`, then one `view.crumpleTo(sprite)`
 *     per view. That exact shape is what reproduces the §1.3 hazard (29 of 30 adds settle
 *     `SheetError`); a loop that awaits, or bitmaps decoded inside the window, does not.
 *   - `stream` (`smooth.stream.dpr1`) — one swap every 100 ms, 30 of them (a gallery cycling).
 *   - `double-swap` (`smooth.double.dpr1`) — every view `swapTo(a)` then `swapTo(b)`, the second
 *     wave 50 ms after the first: supersession. The first wave's runs settle `ABORTED`; every
 *     `sheet.source` call beyond one per view is a **wasted ingest** (`wastedIngests`), which is
 *     what the lane must drive to 0 — the aborted count is 30 both before and after.
 *   - Also: `idle` — 2 s of nothing, the control that calibrates the recorders and shows machine
 *     contention; `burst-drag` — the URL burst while a draw-class knob is written on one view every
 *     frame (`view.set`); `burst-url@dpr2` and `stream@dpr2` at DPR 2
 *     (`Emulation.setDeviceMetricsOverride`; the fronts scale as on a HiDPI screen).
 *
 * Each row: one cold storm, then `BENCH_ITER` timed ones (2 — "run twice, keep the better"), and
 * with `BENCH_PROFILE=1` one more under the CDP sampling profiler for `profile-phases.mjs`. The
 * better timed storm is the one with the lowest task max, then the lowest task p95; **every**
 * reported column comes from that one storm, so the row is internally consistent but its frame and
 * input columns inherit the optimism of a best-of-two on tasks — the per-storm lines are printed
 * beneath the headline so the spread is visible. Before the storms every row runs its own
 * **sequential probe**: 30 awaited `stage.add`s of the row's source kind, removed as they go, no
 * sleeps — the plan's `sequential`, measured for this row's source kind, since a bitmap ingest and
 * a URL ingest are not the same number. `sequentialIdealMs = 30 × its median`, and
 * `idealMs = max(issue span, sequentialIdealMs)` is what `stormRatio` divides by (for `stream` the
 * 2.9 s issue span dominates, so its ratio is ~1 by construction and bites only when the stream
 * falls behind).
 *
 * **Metrics, per storm.** Storm time (first call → the last view's `end`; for `sequential`, the
 * loop itself), ingest time (first call → the last `sheet.build` return, every new front resident)
 * and adopt time (first call → the last view's first `step` drawn with its new sprite);
 * `stormRatio = ingest / idealMs`. Main-thread tasks two ways: **`taskP95Ms` comes from CDP
 * tracing** — every top-level `RunTask` on the page's main thread between the `smooth:storm:start`
 * / `:end` user-timing marks (`disabled-by-default-devtools.timeline` + `blink.user_timing`),
 * overlap and not containment, so the task the storm was issued from is counted; nested `RunTask`s
 * are counted once at the outer length. The quantile is over the **work tasks — those of 1 ms or
 * more**: a storm's window also holds tens of sub-millisecond tasks (timer ticks, input dispatch,
 * empty animation frames) that cannot block anything and would pin any quantile to zero. `max` and
 * `over50` are over *every* task, and the time-weighted p95 (the length under which 95 % of the
 * busy time falls) is reported beside the plain one. The in-page `PerformanceObserver({ type:
 * 'longtask' })` runs alongside as the independent cross-check (50 ms floor, so it can only confirm
 * `over50`). Frame times from a `requestAnimationFrame` recorder: p50 / p95 / max, frames dropped
 * at 60 Hz. Input latency at a **capturing `window` handler** for the CDP-synthesised mouse moves,
 * clicks and keys — `performance.now() − event.timeStamp`, i.e. dispatch (the timestamp the browser
 * stamped when it created the event) → handler entry, so a blocked main thread shows up as latency
 * exactly as a real user's would; the `idle` row's p50 (12–16 ms) is the rAF-aligned dispatch floor
 * these thresholds sit on top of, and the CDP send → ack round trip is kept as the outside
 * cross-check. `longestGapMs` is the longest interval with no input handled, head and tail of the
 * window included. Outcomes: ok / failed (rolled back) / aborted (superseded); `distinctRects` =
 * distinct `${rect.x},${rect.y},${rect.w},${rect.h}` over the sprites the **successful** adds
 * produced, `distinctPixels` = distinct FNV-1a hashes of the swapped canvases as its robust twin;
 * `wastedIngests`. Wrapped-method phase timers — `sheet.source` and `build`, `motion.draw`, the 2D
 * `drawImage` blit, `getBoundingClientRect`, `readPixels`, texture uploads, shader link,
 * `createImageBitmap` — as the in-page side of the phase breakdown the profile completes.
 *
 * **Acceptance thresholds — D3D11 (`BENCH_GPU=1`), the better of the timed storms of every row
 * (`docs/superpowers/plans/2026-09-05-smooth-swap.md`, task S0 step 3, verbatim):**
 *   - longest task ≤ 50 ms;
 *   - task p95 ≤ 10 ms;
 *   - frame p95 ≤ 20 ms;
 *   - input p95 ≤ 50 ms;
 *   - no input gap > 100 ms;
 *   - storm ≤ 1.5 × `sequentialIdealMs`;
 *   - `burst-bitmap` 30/30 ok with 30 distinct rects;
 *   - `double-swap` 30 aborted + 30 ok.
 * SwiftShader is report-only (raster-bound; spec §11). `BENCH_CHECK=1` makes the run exit non-zero
 * when any D3D11 row misses (`--check`; `BENCH_GATE` / `--gate` is the old spelling and still
 * works). The `30/30 ok` and `30 distinct rects` checks are applied to **every** swapping row, not
 * only `burst-bitmap`: a row that silently stopped swapping must not pass on smoothness.
 *
 * **Why no check can pass vacuously.** Every row's verdict opens with a `probe` check that fails
 * unless the trace actually delivered tasks (`tasks.source === 'tracing'`), the synthesised user
 * was handled (≥ 10 events inside the window), the rAF recorder saw frames (≥ 5 intervals) and the
 * expected number of runs settled. Without it the three quiet failure modes all read as passes: a
 * trace that returned nothing leaves `tasks.max` falling back to `longTasks.maxMs = 0`; an input
 * driver that never connected leaves no latency samples; and a storm that issued nothing has
 * neither tasks nor frames to fail on. The remaining metrics fail closed on their own — an empty
 * quantile is `NaN` and `NaN <= limit` is `false` — but the `probe` line says *why*.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commands } from 'vitest/browser'
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
import { NO_STALLS } from './types.js'
import type {
  AddStats,
  Cadence,
  Check,
  FrameStats,
  InputPlan,
  InputReport,
  LongTasks,
  Quantiles,
  RowResult,
  RowSummary,
  SmoothMeta,
  SourceKind,
  StormResult,
  TaskStats,
  TraceReport,
  Verdict,
} from './types.js'

declare module 'vitest/browser' {
  interface BrowserCommands {
    smoothWrite: (rows: RowResult[], meta: SmoothMeta) => Promise<string>
    smoothInput: (action: 'start' | 'stop', plan?: InputPlan) => Promise<InputReport | undefined>
    smoothTrace: (action: 'start' | 'stop', label?: string) => Promise<TraceReport | undefined>
    smoothEmulate: (dpr: number, width: number, height: number) => Promise<void>
    smoothProfile: (action: 'start' | 'stop', label: string) => Promise<string | undefined>
  }
}

declare const __BENCH_ITER__: number
declare const __BENCH_GPU__: boolean
declare const __BENCH_PROFILE__: boolean
declare const __BENCH_FILTER__: string
declare const __BENCH_CHECK__: boolean

const ITERATIONS: number = __BENCH_ITER__
const REAL_GPU: boolean = __BENCH_GPU__
const PROFILE: boolean = __BENCH_PROFILE__
const FILTER: readonly string[] = __BENCH_FILTER__.split(',').filter(Boolean)
/** `BENCH_CHECK=1` (`--check`; `BENCH_GATE` / `--gate` is the old spelling). */
const CHECK: boolean = __BENCH_CHECK__
const BACKEND: 'd3d11' | 'swiftshader' = REAL_GPU ? 'd3d11' : 'swiftshader'

// --- the scenario ----------------------------------------------------------------------------

const VIEWPORT = { w: 1400, h: 900 } as const
const COLS = 6
const GRID_ROWS = 5
const GAP = 8
const VIEWS = COLS * GRID_ROWS
const CELL_W = Math.floor((VIEWPORT.w - GAP * (COLS + 1)) / COLS)
const CELL_H = Math.floor((VIEWPORT.h - GAP * (GRID_ROWS + 1)) / GRID_ROWS)
const ARTWORK_PX = 1024
/** The artwork's on-screen long side, as the playground's `artworkCssPx` — sized to the cell. */
const ARTWORK_CSS_PX = 150
const BUDGET_BYTES = 64 * 1024 * 1024
/** `examples/playground/src/ui/App.tsx` `SWAP_DURATION_MS`. */
const SWAP_DURATION_MS = 900
const STREAM_PERIOD_MS = 100
const DOUBLE_GAP_MS = 50
const IDLE_MS = 2000
const SETTLE_MS = 400
/** The other source kind's probe: reported for comparison, never the row's ideal. */
const SHORT_PROBE = 3
const FRAME_MS = 1000 / 60
const MARK_START = 'smooth:storm:start'
const MARK_END = 'smooth:storm:end'
/** The measurement is worthless below these; `probe` fails and the row's verdict with it. */
const MIN_INPUT_EVENTS = 10
const MIN_FRAME_INTERVALS = 5

/** The plan's numbers (task S0 step 3). Nothing here is tuned to what the code does today. */
const THRESHOLDS = {
  taskMaxMs: 50,
  taskP95Ms: 10,
  frameP95Ms: 20,
  inputP95Ms: 50,
  inputGapMs: 100,
  stormRatio: 1.5,
} as const

interface RowSpec {
  readonly name: string
  /** The plan's row id, and `RowSummary.row`. */
  readonly row: string
  readonly cadence: Cadence
  readonly source: SourceKind
  readonly drag: boolean
  readonly dpr: number
}

const ROWS: readonly RowSpec[] = [
  { name: 'smooth.idle.dpr1', row: 'idle', cadence: 'idle', source: 'url', drag: false, dpr: 1 },
  {
    name: 'smooth.sequential.dpr1',
    row: 'sequential',
    cadence: 'sequential',
    source: 'url',
    drag: false,
    dpr: 1,
  },
  {
    name: 'smooth.burst.url.dpr1',
    row: 'burst-url',
    cadence: 'burst',
    source: 'url',
    drag: false,
    dpr: 1,
  },
  {
    name: 'smooth.burst.bitmap.dpr1',
    row: 'burst-bitmap',
    cadence: 'burst',
    source: 'bitmap',
    drag: false,
    dpr: 1,
  },
  {
    name: 'smooth.stream.dpr1',
    row: 'stream',
    cadence: 'stream',
    source: 'url',
    drag: false,
    dpr: 1,
  },
  {
    name: 'smooth.double.dpr1',
    row: 'double-swap',
    cadence: 'double',
    source: 'url',
    drag: false,
    dpr: 1,
  },
  {
    name: 'smooth.burst.drag.dpr1',
    row: 'burst-drag',
    cadence: 'burst',
    source: 'url',
    drag: true,
    dpr: 1,
  },
  {
    name: 'smooth.burst.url.dpr2',
    row: 'burst-url@dpr2',
    cadence: 'burst',
    source: 'url',
    drag: false,
    dpr: 2,
  },
  {
    name: 'smooth.stream.dpr2',
    row: 'stream@dpr2',
    cadence: 'stream',
    source: 'url',
    drag: false,
    dpr: 2,
  },
]

/** The rows that mount the 6×5 grid; `idle` needs it on screen, `sequential` must not have it. */
function hasViews(cadence: Cadence): boolean {
  return cadence !== 'sequential'
}

/** How long the cadence itself takes to issue its swaps — the floor `idealMs` cannot go under. */
function issueSpanMs(cadence: Cadence): number {
  if (cadence === 'stream') return STREAM_PERIOD_MS * (VIEWS - 1)
  if (cadence === 'double') return DOUBLE_GAP_MS
  return 0
}

// --- small helpers ---------------------------------------------------------------------------

function quantiles(xs: readonly number[]): Quantiles {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  const at = (q: number): number => {
    if (n === 0) return NaN
    const pos = (n - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)
  }
  return {
    n,
    p50: at(0.5),
    p95: at(0.95),
    max: n === 0 ? NaN : s[n - 1],
    mean: n === 0 ? NaN : s.reduce((a, b) => a + b, 0) / n,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve))

// --- the phase timers --------------------------------------------------------------------------

type Acc = Record<string, number>

/**
 * Wraps `target[method]` so `acc` accumulates the milliseconds inside it: `<key>Ms` for a
 * synchronous return, `<key>WallMs` (awaits included) for a promise, `<key>Calls` either way,
 * and `<key>LastEndAt` — the `performance.now()` the last call returned or settled at.
 */
function wrap<T extends object>(
  target: T,
  method: string,
  acc: Acc,
  key: string,
  restore: (() => void)[],
): void {
  const holder = target as Record<string, unknown>
  const original = holder[method] as ((this: unknown, ...args: unknown[]) => unknown) | undefined
  if (typeof original !== 'function') return
  holder[method] = function wrapped(this: unknown, ...args: unknown[]): unknown {
    const t = performance.now()
    const r = original.apply(this, args)
    acc[`${key}Calls`] = (acc[`${key}Calls`] ?? 0) + 1
    if (r instanceof Promise) {
      return r.finally(() => {
        const now = performance.now()
        acc[`${key}WallMs`] = (acc[`${key}WallMs`] ?? 0) + (now - t)
        acc[`${key}LastEndAt`] = now
      })
    }
    const now = performance.now()
    acc[`${key}Ms`] = (acc[`${key}Ms`] ?? 0) + (now - t)
    acc[`${key}LastEndAt`] = now
    return r
  }
  restore.push(() => {
    holder[method] = original
  })
}

/**
 * The library's own seams (the slot methods, as `gl.e2e.*` wraps them) and the handful of
 * platform calls that are the known sync points. Each is rare enough per storm that the closure
 * is noise beside what it times; nothing on the per-GL-call hot path is touched.
 */
function installPhaseTimers(sheet: object, motion: object, acc: Acc): () => void {
  const restore: (() => void)[] = []
  wrap(sheet, 'source', acc, 'source', restore)
  wrap(sheet, 'build', acc, 'build', restore)
  wrap(motion, 'draw', acc, 'draw', restore)
  wrap(motion, 'load', acc, 'load', restore)
  wrap(CanvasRenderingContext2D.prototype, 'drawImage', acc, 'blit', restore)
  wrap(Element.prototype, 'getBoundingClientRect', acc, 'rect', restore)
  const gl = WebGL2RenderingContext.prototype
  wrap(gl, 'readPixels', acc, 'readPixels', restore)
  wrap(gl, 'texImage2D', acc, 'upload', restore)
  wrap(gl, 'texSubImage2D', acc, 'upload', restore)
  wrap(gl, 'texStorage2D', acc, 'texStorage', restore)
  wrap(gl, 'linkProgram', acc, 'shader', restore)
  wrap(gl, 'compileShader', acc, 'shader', restore)
  wrap(gl, 'getProgramParameter', acc, 'shader', restore)
  wrap(gl, 'getShaderParameter', acc, 'shader', restore)
  wrap(gl, 'getBufferSubData', acc, 'sync', restore)
  wrap(gl, 'clientWaitSync', acc, 'sync', restore)
  wrap(gl, 'finish', acc, 'sync', restore)
  wrap(globalThis, 'createImageBitmap', acc, 'decode', restore)
  return () => {
    for (const r of restore.reverse()) r()
  }
}

// --- the recorders -----------------------------------------------------------------------------

interface Recorded {
  readonly longTasks: LongTasks
  readonly frames: FrameStats
  readonly inputTimes: readonly number[]
  readonly inputLatency: readonly number[]
}

interface Recorders {
  stop(t0: number, tEnd: number): Promise<Recorded>
}

const INPUT_EVENTS = ['mousemove', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup'] as const

function startRecorders(onFrame?: (now: number) => void): Recorders {
  const tasks: PerformanceEntry[] = []
  const observer = new PerformanceObserver((list) => {
    tasks.push(...list.getEntries())
  })
  const observing = PerformanceObserver.supportedEntryTypes.includes('longtask')
  if (observing) observer.observe({ type: 'longtask', buffered: false })

  let running = true
  const stamps: number[] = []
  const loop = (now: number): void => {
    if (!running) return
    stamps.push(now)
    onFrame?.(now)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  const times: number[] = []
  const latency: number[] = []
  const handler = (e: Event): void => {
    const now = performance.now()
    times.push(now)
    latency.push(now - e.timeStamp)
  }
  for (const t of INPUT_EVENTS)
    window.addEventListener(t, handler, { capture: true, passive: true })

  return {
    async stop(t0, tEnd) {
      running = false
      for (const t of INPUT_EVENTS) window.removeEventListener(t, handler, { capture: true })
      // `longtask` entries land asynchronously, at a rendering opportunity after the task.
      await nextFrame()
      await nextFrame()
      if (observing) tasks.push(...observer.takeRecords())
      observer.disconnect()

      const inWindow = tasks.filter((e) => e.startTime + e.duration >= t0 && e.startTime <= tEnd)
      const durations = inWindow.map((e) => e.duration)
      const longTasks: LongTasks = {
        count: inWindow.length,
        maxMs: durations.length === 0 ? 0 : Math.max(...durations),
        totalMs: durations.reduce((a, b) => a + b, 0),
        entries: inWindow.map((e) => [e.startTime - t0, e.duration] as const),
      }

      const inFrames = stamps.filter((s) => s >= t0 && s <= tEnd)
      const dts: number[] = []
      for (let i = 1; i < inFrames.length; i++) dts.push(inFrames[i] - inFrames[i - 1])
      const q = quantiles(dts)
      const frames: FrameStats = {
        ...q,
        dropped: dts.reduce((a, dt) => a + Math.max(0, Math.round(dt / FRAME_MS) - 1), 0),
        longestGapMs: dts.length === 0 ? tEnd - t0 : Math.max(...dts),
      }

      const idx = times.map((t, i) => [t, i] as const).filter(([t]) => t >= t0 && t <= tEnd)
      return {
        longTasks,
        frames,
        inputTimes: idx.map(([t]) => t),
        inputLatency: idx.map(([, i]) => latency[i]),
      }
    },
  }
}

/** Tasks under this are bookkeeping — a timer tick, an input dispatch, an empty frame. */
const WORK_TASK_MS = 1

function taskStats(trace: TraceReport | undefined): TaskStats {
  const tasks = trace?.tasks ?? []
  const work = tasks.filter((t) => t >= WORK_TASK_MS)
  const totalMs = tasks.reduce((a, b) => a + b, 0)
  // The length under which 95 % of the busy time falls.
  const sorted = [...tasks].sort((a, b) => a - b)
  let cumulative = 0
  let p95Weighted = NaN
  for (const t of sorted) {
    cumulative += t
    if (cumulative >= 0.95 * totalMs) {
      p95Weighted = t
      break
    }
  }
  return {
    ...quantiles(work),
    max: tasks.length === 0 ? NaN : Math.max(...tasks),
    all: tasks.length,
    p95Weighted,
    over50: tasks.filter((t) => t > 50).length,
    totalMs,
    source: trace !== undefined && trace.tasks.length > 0 ? 'tracing' : 'none',
  }
}

/**
 * One scratch canvas every hash reads through, so the views' own canvases never see a
 * `getImageData`. Chromium demotes a 2D canvas to software raster once it is read back (the
 * `willReadFrequently` heuristic), and a software canvas copies the WebGL surface through the CPU
 * on every `drawImage` — `stalls: readback` in the row block, 1–2 ms a blit inside `Paint`, which
 * is what turned the late rows' frames into 35 ms ones (S10). Declared `willReadFrequently` so the
 * scratch itself is software from the start and the read is a plain memcpy.
 */
let hashScratch: OffscreenCanvasRenderingContext2D | null = null

/** A cheap FNV-1a over the canvas's pixels, so two views showing the same front hash alike. */
function pixelHash(canvas: HTMLCanvasElement): string | null {
  if (canvas.width === 0 || canvas.height === 0) return null
  if (hashScratch === null) {
    hashScratch = new OffscreenCanvas(canvas.width, canvas.height).getContext('2d', {
      willReadFrequently: true,
    })
    if (hashScratch === null) return null
  }
  const c2d = hashScratch
  c2d.canvas.width = canvas.width
  c2d.canvas.height = canvas.height
  c2d.drawImage(canvas, 0, 0)
  const data = c2d.getImageData(0, 0, canvas.width, canvas.height).data
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i += 4) {
    h ^= data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16) ^ (data[i + 3] << 24)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${canvas.width}x${canvas.height}:${h.toString(16)}`
}

// --- the storm ---------------------------------------------------------------------------------

interface Cell {
  readonly view: View
  readonly canvas: HTMLCanvasElement
}

/** One wave of swap targets, one per view: blob URLs, or bitmaps already decoded. */
type Wave = readonly string[] | readonly ImageBitmap[]

interface StormRequest {
  readonly spec: RowSpec
  readonly stage: BlitStage
  readonly cells: readonly Cell[]
  /** `double` has two waves; everything else one. Each target is new to the stage. */
  readonly waves: readonly Wave[]
  readonly iteration: number
  readonly acc: Acc
  readonly errors: string[]
  readonly plan: InputPlan
  readonly idealMs: number
  readonly profileLabel?: string
}

let swapCounter = 0

/**
 * The playground's swap for a URL; the same composition spelled out for a pinned bitmap. Every
 * sprite a **successful** run produced is pushed into `sprites`, which is where `distinctRects`
 * comes from: for a bitmap the `stage.add` promise hands it over directly (so a row where 29 of 30
 * adds fail counts one sprite, not one view), and for a URL `view.swapTo` resolves to `undefined`
 * (`SwapResult`), so the sprite is read off the view once the run has settled.
 */
function swap(
  stage: BlitStage,
  view: View,
  target: string | ImageBitmap,
  sprites: Sprite[],
): PromiseLike<unknown> {
  if (typeof target === 'string') {
    return view.swapTo(target, { duration: SWAP_DURATION_MS }).then((r) => {
      const s = view.sprite
      if (!(r instanceof Error) && !isAborted(r) && s !== null) sprites.push(s)
      return r
    })
  }
  swapCounter += 1
  const pending = stage.add(target, { key: `bitmap:${String(swapCounter)}`, pin: true })
  void pending.then((s) => {
    if (!(s instanceof Error) && !isAborted(s)) sprites.push(s)
  })
  return view.crumpleTo(pending, { duration: SWAP_DURATION_MS })
}

/** `sprite.rect` — the silhouette's box in source pixels; 30 artworks must give 30 of these. */
function rectKey(sprite: Sprite): string {
  const r = sprite.rect
  return `${r.x},${r.y},${r.w},${r.h}`
}

async function runStorm(o: StormRequest): Promise<StormResult> {
  const { spec, stage, cells, waves, acc } = o
  for (const k of Object.keys(acc)) acc[k] = 0
  const before: (Sprite | null)[] = cells.map((c) => c.view.sprite)
  let completed = 0
  let lastEndAt = 0
  let lastAdoptAt = 0
  const adopted = new Set<number>()
  const offs: (() => void)[] = []
  cells.forEach((c, i) => {
    offs.push(
      c.view.on('end', (e) => {
        if (e.completed) completed += 1
        lastEndAt = performance.now()
      }),
    )
    offs.push(
      c.view.on('step', () => {
        if (adopted.has(i) || c.view.sprite === before[i]) return
        adopted.add(i)
        lastAdoptAt = performance.now()
      }),
    )
  })
  const errorsBefore = o.errors.length
  let dragRefused = 0
  const onFrame =
    spec.drag && cells.length > 0
      ? (now: number): void => {
          const r = cells[0].view.set({ ambient: 0.5 + 0.3 * Math.sin(now / 200) } as never)
          if (r instanceof Error) dragRefused += 1
        }
      : undefined

  if (o.profileLabel !== undefined) await commands.smoothProfile('start', o.profileLabel)
  await commands.smoothTrace('start')
  await commands.smoothInput('start', o.plan)
  const recorders = startRecorders(onFrame)
  // Let the first synthesised events land before the storm, so its head gap is the storm's.
  await nextFrame()
  await nextFrame()

  performance.mark(MARK_START)
  const t0 = performance.now()
  const runs: PromiseLike<unknown>[] = []
  const sprites: Sprite[] = []
  const issueWave = (wave: Wave): void => {
    for (let i = 0; i < cells.length; i++) runs.push(swap(stage, cells[i].view, wave[i], sprites))
  }
  if (spec.cadence === 'idle') {
    await sleep(IDLE_MS)
  } else if (spec.cadence === 'sequential') {
    // The ideal: one awaited `stage.add` after another, no views, nothing overlapping. Each
    // sprite is removed once it is measured, so the 64 MiB budget never evicts anything and the
    // per-add median is the cost of the ingest alone.
    const perAdd: number[] = []
    const wave = waves[0]
    for (let i = 0; i < wave.length; i++) {
      swapCounter += 1
      const key = `sequential:${String(swapCounter)}`
      const target = wave[i]
      const t = performance.now()
      const sprite =
        typeof target === 'string'
          ? await stage.add(target, { key })
          : await stage.add(target, { key, pin: true })
      perAdd.push(performance.now() - t)
      runs.push(Promise.resolve(sprite))
      if (!(sprite instanceof Error) && !isAborted(sprite)) {
        sprites.push(sprite)
        stage.remove(key)
      }
    }
    acc.sequentialMedianMs = quantiles(perAdd).p50
  } else if (spec.cadence === 'burst') {
    issueWave(waves[0])
  } else if (spec.cadence === 'double') {
    issueWave(waves[0])
    await sleep(DOUBLE_GAP_MS)
    acc.secondWaveAtMs = performance.now() - t0
    issueWave(waves[1])
  } else {
    let late = 0
    await new Promise<void>((resolve) => {
      let issued = 0
      cells.forEach((c, i) => {
        setTimeout(() => {
          late = Math.max(late, performance.now() - t0 - i * STREAM_PERIOD_MS)
          runs.push(swap(stage, c.view, waves[0][i], sprites))
          issued += 1
          if (issued === cells.length) resolve()
        }, i * STREAM_PERIOD_MS)
      })
    })
    acc.issueLateMaxMs = late
  }
  const settled = await Promise.all(runs)
  const tEnd = performance.now()
  performance.mark(MARK_END)

  const report = await commands.smoothInput('stop')
  const rec = await recorders.stop(t0, tEnd)
  const trace = await commands.smoothTrace(
    'stop',
    `${spec.name}.${REAL_GPU ? 'gpu' : 'sw'}.${String(o.iteration)}`,
  )
  const profile =
    o.profileLabel === undefined ? undefined : await commands.smoothProfile('stop', o.profileLabel)
  for (const off of offs) off()

  const gaps: number[] = []
  if (rec.inputTimes.length === 0) gaps.push(tEnd - t0)
  else {
    gaps.push(rec.inputTimes[0] - t0, tEnd - rec.inputTimes[rec.inputTimes.length - 1])
    for (let i = 1; i < rec.inputTimes.length; i++) {
      gaps.push(rec.inputTimes[i] - rec.inputTimes[i - 1])
    }
  }
  if (dragRefused > 0) acc.dragRefused = dragRefused

  const messages = new Set<string>()
  let ok = 0
  let failed = 0
  let aborted = 0
  for (const v of settled) {
    if (v instanceof Error) {
      failed += 1
      messages.add(v.message)
    } else if (isAborted(v)) aborted += 1
    else ok += 1
  }
  // `distinctRects` is over the sprites the successful adds produced (`sprite.rect`), so it counts
  // the adds and not the views: 29 failed adds leave one sprite even though thirty views exist.
  const rects = new Set(sprites.map(rectKey))
  const pixels = new Set<string>()
  cells.forEach((c, i) => {
    if (c.view.sprite === before[i]) return
    const h = pixelHash(c.canvas)
    if (h !== null) pixels.add(h)
  })
  const adds: AddStats = {
    ok,
    failed,
    aborted,
    distinctRects: rects.size,
    distinctPixels: pixels.size,
    messages: [...messages].slice(0, 3),
  }
  const isIdle = spec.cadence === 'idle'
  // The two rows with no `view.on('end')` to close the window on: `idle` is the window, and
  // `sequential` ends when its last awaited add returns.
  const noViews = !hasViews(spec.cadence)
  const lastBuild = acc.buildLastEndAt ?? 0
  const ingestStormMs = isIdle ? 0 : Math.max(0, lastBuild - t0)
  // One ingest per image the row actually wanted: 30 for every row, `double`'s second wave
  // included — its first wave is what "wasted" means.
  const wantedIngests = isIdle ? 0 : VIEWS
  return {
    iteration: o.iteration,
    stormMs: isIdle || noViews ? tEnd - t0 : lastEndAt - t0,
    ingestStormMs,
    lastAdoptMs: isIdle || noViews ? 0 : lastAdoptAt - t0,
    stormRatio: isIdle || !(o.idealMs > 0) ? 0 : ingestStormMs / o.idealMs,
    swaps: runs.length,
    completed,
    errors: o.errors.length - errorsBefore,
    adds,
    wastedIngests: isIdle ? 0 : Math.max(0, (acc.sourceCalls ?? 0) - wantedIngests),
    longTasks: rec.longTasks,
    tasks: taskStats(trace),
    stalls: trace?.stalls ?? NO_STALLS,
    anatomy: trace?.anatomy ?? [],
    frames: rec.frames,
    input: {
      handled: rec.inputTimes.length,
      latency: quantiles(rec.inputLatency),
      longestGapMs: Math.max(...gaps),
      ack: quantiles(report?.ackMs ?? []),
      sent: report?.sent ?? 0,
    },
    phases: { ...acc },
    ...(profile === undefined ? {} : { profile }),
  }
}

// --- the row -----------------------------------------------------------------------------------

/**
 * The plan's eight thresholds, plus `probe` in front of them. `probe` is what stops a check from
 * passing on nothing: a trace that returned no tasks would leave `taskMax` falling back to the
 * `longtask` observer's `0`, an input driver that never connected would leave no latency samples,
 * and a storm that issued nothing would have neither. Its value is the number of preconditions
 * that failed; `0` is the only passing value.
 */
function verdictFor(s: StormResult, spec: RowSpec, views: number): Verdict {
  const check = (name: string, value: number, limit: number, pass: boolean): Check => ({
    name,
    value,
    limit,
    pass,
  })
  const expectedRuns = spec.cadence === 'double' ? 2 * views : views
  const missing =
    (s.tasks.source === 'tracing' ? 0 : 1) +
    (s.input.handled >= MIN_INPUT_EVENTS ? 0 : 1) +
    (s.frames.n >= MIN_FRAME_INTERVALS ? 0 : 1) +
    (s.swaps === expectedRuns ? 0 : 1)
  const taskMax = s.tasks.source === 'tracing' ? s.tasks.max : s.longTasks.maxMs
  const checks: Check[] = [
    check('probe', missing, 0, missing === 0),
    check(
      'task max',
      taskMax,
      THRESHOLDS.taskMaxMs,
      taskMax <= THRESHOLDS.taskMaxMs && s.longTasks.count === 0,
    ),
    check('task p95', s.tasks.p95, THRESHOLDS.taskP95Ms, s.tasks.p95 <= THRESHOLDS.taskP95Ms),
    check('frame p95', s.frames.p95, THRESHOLDS.frameP95Ms, s.frames.p95 <= THRESHOLDS.frameP95Ms),
    check(
      'input p95',
      s.input.latency.p95,
      THRESHOLDS.inputP95Ms,
      s.input.latency.p95 <= THRESHOLDS.inputP95Ms,
    ),
    check(
      'input gap',
      s.input.longestGapMs,
      THRESHOLDS.inputGapMs,
      s.input.longestGapMs <= THRESHOLDS.inputGapMs,
    ),
    check(
      'storm ratio',
      s.stormRatio,
      THRESHOLDS.stormRatio,
      s.stormRatio <= THRESHOLDS.stormRatio,
    ),
    // "30/30 ok with 30 distinct rects" is the plan's `burst-bitmap` line, applied to every
    // swapping row: a row that quietly stopped swapping must not pass on smoothness alone.
    check('adds ok', s.adds.ok, views, s.adds.failed === 0 && s.adds.ok === views),
    check('distinct rects', s.adds.distinctRects, views, s.adds.distinctRects === views),
  ]
  // The pixel twin of `distinct rects`, where there are canvases to read it off.
  if (hasViews(spec.cadence)) {
    checks.push(
      check('fronts short', views - s.adds.distinctPixels, 0, s.adds.distinctPixels === views),
    )
  }
  // "30 `ABORTED` adds, 30 completed runs" — the supersession row's own line.
  if (spec.cadence === 'double') {
    checks.push(check('aborted', s.adds.aborted, views, s.adds.aborted === views))
  }
  return { pass: checks.every((c) => c.pass), checks }
}

/** The better of the timed storms: the lowest task max, then the lowest task p95. */
function bestOf(storms: readonly StormResult[]): number {
  let best = -1
  const maxOf = (s: StormResult): number =>
    s.tasks.source === 'tracing' ? s.tasks.max : s.longTasks.maxMs
  storms.forEach((s, i) => {
    if (s.iteration === 0 || s.profile !== undefined) return
    if (best < 0) {
      best = i
      return
    }
    const b = storms[best]
    if (maxOf(s) < maxOf(b) || (maxOf(s) === maxOf(b) && s.tasks.p95 < b.tasks.p95)) best = i
  })
  return best < 0 ? Math.min(1, storms.length - 1) : best
}

let meta: SmoothMeta | null = null

function describeStage(stage: BlitStage): void {
  if (meta !== null) return
  const canvas: unknown = stage.surface.canvas
  const gl =
    canvas instanceof HTMLCanvasElement || canvas instanceof OffscreenCanvas
      ? (canvas.getContext('webgl2') as WebGL2RenderingContext | null)
      : null
  const info = gl?.getExtension('WEBGL_debug_renderer_info') ?? null
  const frame = window.frameElement?.getBoundingClientRect()
  meta = {
    userAgent: navigator.userAgent,
    renderer:
      gl === null
        ? 'no context'
        : String(gl.getParameter(info === null ? gl.RENDERER : info.UNMASKED_RENDERER_WEBGL)),
    vendor:
      gl === null
        ? 'no context'
        : String(gl.getParameter(info === null ? gl.VENDOR : info.UNMASKED_VENDOR_WEBGL)),
    realGpu: REAL_GPU,
    iterations: ITERATIONS,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    longTaskObserver: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    frameRect:
      frame === undefined
        ? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
        : { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
  }
}

/** Blob URLs, `[slice][view]`, all distinct: slice 0 mounts, the rest are swap targets. */
let pool: string[][] = []
let blobs: Blob[][] = []

async function makePool(slices: number): Promise<Error | undefined> {
  for (let k = 0; k < slices; k++) {
    const made = await Promise.all(
      Array.from({ length: VIEWS }, (_, i) => artworkBlob(k * VIEWS + i, ARTWORK_PX)),
    )
    const urls: string[] = []
    const kept: Blob[] = []
    for (const b of made) {
      if (b instanceof Error) return b
      kept.push(b)
      urls.push(URL.createObjectURL(b))
    }
    pool.push(urls)
    blobs.push(kept)
  }
  return undefined
}

async function decodeSlice(k: number): Promise<ImageBitmap[] | Error> {
  const out: ImageBitmap[] = []
  for (const b of blobs[k]) {
    const bitmap = await createImageBitmap(b, { premultiplyAlpha: 'none' }).catch((e: unknown) =>
      e instanceof Error ? e : new Error(String(e)),
    )
    if (bitmap instanceof Error) return bitmap
    out.push(bitmap)
  }
  return out
}

/**
 * The plan's `sequential` measured for one source kind: `count` awaited `stage.add`s, one after
 * another, no sleeps between them, each removed once it is timed so the budget never evicts
 * anything mid-probe. Returns the **median** per-add time; `views ×` it is `sequentialIdealMs`.
 * Run on the stage as the row has it — with the grid mounted and idle for a swapping row, on a
 * stage with no views at all for the `sequential` row itself.
 */
async function sequentialProbe(
  stage: BlitStage,
  kind: SourceKind,
  urls: readonly string[],
  bitmaps: readonly ImageBitmap[],
  count: number,
): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < count; i++) {
    const key = `probe:${kind}:${String(i)}`
    const t = performance.now()
    const sprite =
      kind === 'url'
        ? await stage.add(urls[i], { key })
        : await stage.add(bitmaps[i], { key, pin: true })
    times.push(performance.now() - t)
    if (!(sprite instanceof Error) && !isAborted(sprite)) stage.remove(key)
  }
  return quantiles(times).p50
}

/** The plan's flat contract, over the row's better timed storm. See `RowSummary`. */
function summarise(spec: RowSpec, s: StormResult, sequentialIdealMs: number): RowSummary {
  const p = s.phases
  const build = p.buildMs ?? p.buildWallMs ?? 0
  const draw = p.drawMs ?? 0
  const blit = p.blitMs ?? 0
  return {
    row: spec.row,
    backend: BACKEND,
    stormMs: s.stormMs,
    sequentialIdealMs,
    stormRatio: s.stormRatio,
    longestTaskMs: s.tasks.source === 'tracing' ? s.tasks.max : s.longTasks.maxMs,
    longTasks50: s.tasks.source === 'tracing' ? s.tasks.over50 : s.longTasks.count,
    taskP95Ms: s.tasks.p95,
    frameP50Ms: s.frames.p50,
    frameP95Ms: s.frames.p95,
    frameMaxMs: s.frames.max,
    dropped: s.frames.dropped,
    inputP50Ms: s.input.latency.p50,
    inputP95Ms: s.input.latency.p95,
    inputMaxMs: s.input.latency.max,
    inputGapMaxMs: s.input.longestGapMs,
    phases: {
      source: p.sourceWallMs ?? 0,
      build,
      draw,
      blit,
      other: Math.max(0, s.tasks.totalMs - (build + draw + blit)),
    },
    outcomes: {
      ok: s.adds.ok,
      error: s.adds.failed,
      aborted: s.adds.aborted,
      distinctRects: s.adds.distinctRects,
      distinctPixels: s.adds.distinctPixels,
      wastedIngests: s.wastedIngests,
    },
  }
}

async function runRow(spec: RowSpec): Promise<RowResult | Error> {
  await commands.smoothEmulate(spec.dpr, VIEWPORT.w, VIEWPORT.h)
  await nextFrame()
  const dprSeen = window.devicePixelRatio

  const host = document.createElement('div')
  host.style.cssText =
    `position:fixed;left:0;top:0;width:${VIEWPORT.w}px;height:${VIEWPORT.h}px;` +
    `display:grid;grid-template-columns:repeat(${COLS},${CELL_W}px);` +
    `grid-auto-rows:${CELL_H}px;gap:${GAP}px;padding:${GAP}px;box-sizing:border-box;` +
    'background:#e9e6df;overflow:hidden'
  document.body.append(host)
  const canvases: HTMLCanvasElement[] = []
  for (let i = 0; i < VIEWS; i++) {
    const canvas = document.createElement('canvas')
    // The display size is set once and never follows the backing store — see the playground's
    // `frameHero` for the feedback loop a CSS-less canvas falls into under a managed store.
    canvas.style.cssText = `display:block;width:${CELL_W}px;height:${CELL_H}px`
    host.append(canvas)
    canvases.push(canvas)
  }

  const errors: string[] = []
  const sheet = paperSheet({ edgeMode: 'hull', tiles, overscanHeadroom: 0.25 })
  const motion = bakedMotion({ packs: [pack1x1, pack2x3, pack3x2] })
  const acc: Acc = {}
  const uninstall = installPhaseTimers(sheet, motion, acc)
  const owned: ImageBitmap[] = []
  const cleanup = (): void => {
    uninstall()
    host.remove()
    for (const b of owned) b.close()
  }

  const stage = await paperStage({
    sheet,
    motion,
    artworkCssPx: ARTWORK_CSS_PX,
    budget: BUDGET_BYTES,
    present: 'blit',
    onError: (e) => {
      errors.push(e.error.message)
    },
  })
  if (stage instanceof Error) {
    cleanup()
    return stage
  }
  if (isAborted(stage)) {
    cleanup()
    return new Error('paperStage aborted')
  }
  describeStage(stage)
  const surfaceSize = `${String(stage.surface.width)}x${String(stage.surface.height)}`
  const frame = meta?.frameRect ?? { x: 0, y: 0, w: VIEWPORT.w, h: VIEWPORT.h }
  const plan: InputPlan = { ...frame, hz: 60, clickEveryMs: 500, keyEveryMs: 250 }

  const mountedAt = performance.now()
  const cells: Cell[] = []
  let frontSize = ''
  for (let i = 0; hasViews(spec.cadence) && i < VIEWS; i++) {
    const view = await stage.mount({
      key: `v${i}`,
      src: pool[0][i],
      canvas: canvases[i],
      fit: 'contain',
    })
    if (view instanceof Error) {
      stage.dispose()
      cleanup()
      return new Error(`mount v${i}: ${view.message}`)
    }
    if (isAborted(view)) {
      stage.dispose()
      cleanup()
      return new Error(`mount v${i} aborted`)
    }
    const s = view.sprite
    if (s !== null && frontSize === '') frontSize = `${s.frontSize.w}x${s.frontSize.h}`
    cells.push({ view, canvas: canvases[i] })
  }
  const mountMs = performance.now() - mountedAt
  await sleep(SETTLE_MS)

  // The sequential probe, from the last slice (never a storm target): `VIEWS` awaited adds of the
  // row's own source kind — the plan's `sequential` ideal for this row — and a short one of the
  // other kind, kept only so the two ingest costs stay comparable in the printed table.
  const probeSlice = pool.length - 1
  const probeBitmaps = await decodeSlice(probeSlice)
  if (probeBitmaps instanceof Error) {
    stage.dispose()
    cleanup()
    return probeBitmaps
  }
  owned.push(...probeBitmaps)
  const ownKind = spec.source
  const otherKind: SourceKind = ownKind === 'url' ? 'bitmap' : 'url'
  const ownMs = await sequentialProbe(stage, ownKind, pool[probeSlice], probeBitmaps, VIEWS)
  const otherMs = await sequentialProbe(
    stage,
    otherKind,
    pool[probeSlice],
    probeBitmaps,
    SHORT_PROBE,
  )
  const ingestUrlMs = ownKind === 'url' ? ownMs : otherMs
  const ingestBitmapMs = ownKind === 'bitmap' ? ownMs : otherMs
  const ingestMs = ownMs
  const sequentialIdealMs = VIEWS * ingestMs
  const idealMs = Math.max(issueSpanMs(spec.cadence), sequentialIdealMs)
  await sleep(SETTLE_MS)

  const storms: StormResult[] = []
  const plannedStorms = 1 + ITERATIONS + (PROFILE ? 1 : 0)
  const wavesPerStorm = spec.cadence === 'double' ? 2 : 1
  let nextSlice = 1
  let pendingClose: ImageBitmap[] = []
  for (let k = 0; k < plannedStorms; k++) {
    const profiled = PROFILE && k === plannedStorms - 1
    const waves: Wave[] = []
    const stormBitmaps: ImageBitmap[] = []
    if (spec.cadence !== 'idle') {
      for (let w = 0; w < wavesPerStorm; w++) {
        const slice = nextSlice
        nextSlice += 1
        if (spec.source === 'bitmap') {
          const decoded = await decodeSlice(slice)
          if (decoded instanceof Error) {
            stage.dispose()
            cleanup()
            return decoded
          }
          stormBitmaps.push(...decoded)
          waves.push(decoded)
        } else waves.push(pool[slice])
      }
    }
    const before = cells.map((c) => c.view.sprite)
    storms.push(
      await runStorm({
        spec,
        stage,
        cells,
        waves,
        iteration: k,
        acc,
        errors,
        plan,
        idealMs,
        ...(profiled ? { profileLabel: `${spec.name}.${REAL_GPU ? 'gpu' : 'sw'}` } : {}),
      }),
    )
    // The swapped-out sprites go the way a gallery's previous page eventually goes — outside
    // the window, so every storm starts from thirty resident fronts and nothing else. A
    // superseded first wave's sprite is not shown by anyone; the stage still holds it.
    const shown = new Set(cells.map((c) => c.view.sprite?.key))
    before.forEach((s) => {
      if (s !== null && !shown.has(s.key)) stage.remove(s.key)
    })
    // The previous storm's pinned bitmaps are unreferenced once their sprites are gone; this
    // storm's stay open until the next one swaps them out.
    for (const b of pendingClose) b.close()
    pendingClose = stormBitmaps
    await sleep(SETTLE_MS)
  }
  owned.push(...pendingClose)

  stage.dispose()
  cleanup()
  await commands.smoothEmulate(1, VIEWPORT.w, VIEWPORT.h)

  const best = bestOf(storms)
  const distinct = [...new Set(errors)]
  const note =
    errors.length === 0
      ? undefined
      : `${errors.length} error events (${distinct.length} distinct): ${distinct.slice(0, 2).join(' | ')}`
  const verdict =
    REAL_GPU && spec.cadence !== 'idle' ? verdictFor(storms[best], spec, VIEWS) : undefined
  const summary: RowSummary = {
    ...summarise(spec, storms[best], sequentialIdealMs),
    ...(verdict === undefined ? {} : { pass: verdict.pass }),
  }
  return {
    name: spec.name,
    cadence: spec.cadence,
    source: spec.source,
    drag: spec.drag,
    dpr: spec.dpr,
    dprSeen,
    views: VIEWS,
    artworkPx: ARTWORK_PX,
    artworkCssPx: ARTWORK_CSS_PX,
    frontSize,
    surfaceSize,
    mountMs,
    ingestMs,
    ingestUrlMs,
    ingestBitmapMs,
    sequentialIdealMs,
    idealMs,
    storms,
    best,
    ...(verdict === undefined ? {} : { verdict }),
    summary,
    ...(note === undefined ? {} : { note }),
  }
}

// --- the suite ---------------------------------------------------------------------------------

const rows: RowResult[] = []

describe('smooth', () => {
  beforeAll(async () => {
    // Slice 0 mounts; a `double` storm consumes two slices, the others one; the last slice is
    // the isolated ingest's. Sized for the widest row so every storm's targets are new.
    const storms = 1 + ITERATIONS + (PROFILE ? 1 : 0)
    const made = await makePool(1 + 2 * storms + 1)
    expect(made).toBeUndefined()
  })

  for (const spec of ROWS) {
    const selected = FILTER.length === 0 || FILTER.some((f) => spec.name.includes(f))
    ;(selected ? it : it.skip)(spec.name, async () => {
      const row = await runRow(spec)
      expect(row).not.toBeInstanceOf(Error)
      if (row instanceof Error) return
      rows.push(row)
      if (CHECK && row.verdict !== undefined) {
        expect(
          row.verdict.checks
            .filter((c) => !c.pass)
            .map((c) => `${c.name} ${String(c.value)} (limit ${String(c.limit)})`),
          `${row.name} verdict`,
        ).toEqual([])
      }
    })
  }

  afterAll(async () => {
    for (const slice of pool) for (const url of slice) URL.revokeObjectURL(url)
    pool = []
    blobs = []
    if (meta === null) return
    await commands.smoothWrite(rows.splice(0), meta)
  })
})
