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
 * **Cadences.** `burst` — all 30 swaps in one synchronous block (a "next page" click), from URLs
 * (`burst.url`) or pre-decoded bitmaps (`burst.bitmap`); `stream` — one view every 100 ms for 30
 * swaps (a gallery cycling); `double` — every view swapped twice 50 ms apart (supersession: the
 * first wave's runs settle `ABORTED`, and any `sheet.source` beyond one per view is a wasted
 * ingest); `burst.drag` — the URL burst while a draw-class knob is written on one view every frame
 * (`view.set`, the continuous-drag case); `idle` — 2 s of nothing, the control that calibrates the
 * recorders. `burst.url` and `stream` also run at DPR 2 (`Emulation.setDeviceMetricsOverride`;
 * the fronts scale with it exactly as on a HiDPI screen). Each row: one cold storm, then
 * `BENCH_ITER` timed ones (2), and with `BENCH_PROFILE=1` one more under the CDP sampling profiler
 * for `profile-phases.mjs`. Before the storms, one `stage.add` of each source kind is timed alone
 * on the idle stage (median of three): the **per-swap ingest**, and `idealMs = max(issue span,
 * 30 × ingest)` is the sequential ideal the storm's ingest time is compared with.
 *
 * **Metrics, per storm.** Storm time (first call → the last view's `end`), ingest time (first call
 * → the last `sheet.build` return, every new front resident) and adopt time (first call → the last
 * view's first `step` drawn with its new sprite); `stormRatio = ingest / idealMs`. Main-thread
 * tasks two ways: every top-level `RunTask` between the storm's user-timing marks from a CDP
 * `Tracing` session over `disabled-by-default-devtools.timeline` (n, p50 / p95 / max, count over
 * 50 ms), and the in-page `PerformanceObserver` `longtask` (count over 50 ms, max) as the
 * cross-check. Frame times from a `requestAnimationFrame` recorder: p50 / p95 / max, frames
 * dropped at 60 Hz. Input latency on a page-level handler for the CDP-synthesised mouse moves,
 * clicks and keys at ~60 Hz (`performance.now() - event.timeStamp`): p50 / p95 / max, the longest
 * interval with no input handled, and the CDP acknowledgement round trip as the outside
 * cross-check. How the swaps settled: ok / failed (rolled back) / aborted (superseded), the distinct
 * `view.frame.artwork` rects among the views that swapped (30 artworks → 30 rects; fewer means a
 * front built from another sprite's field), wasted ingests. Wrapped-method phase timers —
 * `sheet.source` and `build`, `motion.draw`, the 2D `drawImage` blit, `getBoundingClientRect`,
 * `readPixels`, texture uploads, shader link, `createImageBitmap` — as the in-page side of the phase
 * breakdown the profile completes.
 *
 * **Proposed acceptance thresholds — on the D3D11 backend (`BENCH_GPU=1`), for the better of the
 * timed storms of every swapping row (the controller may adjust):**
 *   - no main-thread task over 50 ms (hard: `tasks.max ≤ 50`, `longTasks.count === 0`);
 *   - task p95 ≤ 10 ms over the storm's work tasks (top-level tasks of 1 ms or more; the
 *     sub-millisecond ticks would pin the quantile to zero — the time-weighted p95 is beside it);
 *   - frame p95 ≤ 20 ms;
 *   - input latency p95 ≤ 50 ms, and no input gap over 100 ms;
 *   - the throughput floor: storm ingest ≤ 1.5 × the sequential ideal (`stormRatio ≤ 1.5`);
 *   - every swap lands: `adds.ok === 30` and 30 distinct rects (the `burst.bitmap` regression).
 * On SwiftShader the rows are report-only (raster-bound; spec §11, level 3). The verdict is
 * written and printed for every D3D11 row, check by check; `BENCH_GATE=1` makes it an assertion.
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
    smoothTrace: (action: 'start' | 'stop') => Promise<TraceReport | undefined>
    smoothEmulate: (dpr: number, width: number, height: number) => Promise<void>
    smoothProfile: (action: 'start' | 'stop', label: string) => Promise<string | undefined>
  }
}

declare const __BENCH_ITER__: number
declare const __BENCH_GPU__: boolean
declare const __BENCH_PROFILE__: boolean
declare const __BENCH_FILTER__: string
declare const __BENCH_GATE__: boolean

const ITERATIONS: number = __BENCH_ITER__
const REAL_GPU: boolean = __BENCH_GPU__
const PROFILE: boolean = __BENCH_PROFILE__
const FILTER: readonly string[] = __BENCH_FILTER__.split(',').filter(Boolean)
const GATE: boolean = __BENCH_GATE__

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
const ISOLATED_ADDS = 3
const FRAME_MS = 1000 / 60
const MARK_START = 'smooth:storm:start'
const MARK_END = 'smooth:storm:end'

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
  readonly cadence: Cadence
  readonly source: SourceKind
  readonly drag: boolean
  readonly dpr: number
}

const ROWS: readonly RowSpec[] = [
  { name: 'smooth.idle.dpr1', cadence: 'idle', source: 'url', drag: false, dpr: 1 },
  { name: 'smooth.burst.url.dpr1', cadence: 'burst', source: 'url', drag: false, dpr: 1 },
  { name: 'smooth.burst.bitmap.dpr1', cadence: 'burst', source: 'bitmap', drag: false, dpr: 1 },
  { name: 'smooth.stream.dpr1', cadence: 'stream', source: 'url', drag: false, dpr: 1 },
  { name: 'smooth.double.dpr1', cadence: 'double', source: 'url', drag: false, dpr: 1 },
  { name: 'smooth.burst.drag.dpr1', cadence: 'burst', source: 'url', drag: true, dpr: 1 },
  { name: 'smooth.burst.url.dpr2', cadence: 'burst', source: 'url', drag: false, dpr: 2 },
  { name: 'smooth.stream.dpr2', cadence: 'stream', source: 'url', drag: false, dpr: 2 },
]

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

/** A cheap FNV-1a over the canvas's pixels, so two views showing the same front hash alike. */
function pixelHash(canvas: HTMLCanvasElement): string | null {
  const c2d = canvas.getContext('2d')
  if (c2d === null || canvas.width === 0 || canvas.height === 0) return null
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

/** The playground's swap for a URL; the same composition spelled out for a pinned bitmap. */
function swap(stage: BlitStage, view: View, target: string | ImageBitmap): PromiseLike<unknown> {
  if (typeof target === 'string') return view.swapTo(target, { duration: SWAP_DURATION_MS })
  swapCounter += 1
  const pending = stage.add(target, { key: `bitmap:${String(swapCounter)}`, pin: true })
  return view.crumpleTo(pending, { duration: SWAP_DURATION_MS })
}

function rectKey(view: View): string | null {
  const f = view.frame
  if (f === null) return null
  const a = f.artwork
  return `${a.x},${a.y},${a.w},${a.h}@${f.box.w}x${f.box.h}`
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
  const issueWave = (wave: Wave): void => {
    for (let i = 0; i < cells.length; i++) runs.push(swap(stage, cells[i].view, wave[i]))
  }
  if (spec.cadence === 'idle') {
    await sleep(IDLE_MS)
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
          runs.push(swap(stage, c.view, waves[0][i]))
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
  const trace = await commands.smoothTrace('stop')
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
  const rects = new Set<string>()
  const pixels = new Set<string>()
  cells.forEach((c, i) => {
    if (c.view.sprite === before[i]) return
    const k = rectKey(c.view)
    if (k !== null) rects.add(k)
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
  const lastBuild = acc.buildLastEndAt ?? 0
  const ingestStormMs = isIdle ? 0 : Math.max(0, lastBuild - t0)
  return {
    iteration: o.iteration,
    stormMs: isIdle ? tEnd - t0 : lastEndAt - t0,
    ingestStormMs,
    lastAdoptMs: isIdle ? 0 : lastAdoptAt - t0,
    stormRatio: isIdle || !(o.idealMs > 0) ? 0 : ingestStormMs / o.idealMs,
    swaps: runs.length,
    completed,
    errors: o.errors.length - errorsBefore,
    adds,
    wastedIngests: isIdle ? 0 : Math.max(0, (acc.sourceCalls ?? 0) - cells.length),
    longTasks: rec.longTasks,
    tasks: taskStats(trace),
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

function verdictFor(s: StormResult, views: number): Verdict {
  const check = (name: string, value: number, limit: number, pass: boolean): Check => ({
    name,
    value,
    limit,
    pass,
  })
  const taskMax = s.tasks.source === 'tracing' ? s.tasks.max : s.longTasks.maxMs
  const checks: Check[] = [
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
    check('adds failed', s.adds.failed, 0, s.adds.failed === 0 && s.adds.ok === views),
    check('fronts short', views - s.adds.distinctPixels, 0, s.adds.distinctPixels === views),
  ]
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
      ? canvas.getContext('webgl2')
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

/** One `stage.add` alone on the idle stage, the row's source kind: the per-swap ingest. */
async function isolatedIngest(
  stage: BlitStage,
  kind: SourceKind,
  urls: readonly string[],
  bitmaps: readonly ImageBitmap[],
): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < ISOLATED_ADDS; i++) {
    const key = `isolated:${kind}:${String(i)}`
    const t = performance.now()
    const sprite =
      kind === 'url'
        ? await stage.add(urls[i], { key })
        : await stage.add(bitmaps[i], { key, pin: true })
    times.push(performance.now() - t)
    if (!(sprite instanceof Error) && !isAborted(sprite)) stage.remove(key)
    await sleep(50)
  }
  return quantiles(times).p50
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
  const frame = meta?.frameRect ?? { x: 0, y: 0, w: VIEWPORT.w, h: VIEWPORT.h }
  const plan: InputPlan = { ...frame, hz: 60, clickEveryMs: 500, keyEveryMs: 250 }

  const mountedAt = performance.now()
  const cells: Cell[] = []
  let frontSize = ''
  for (let i = 0; i < VIEWS; i++) {
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

  // The isolated ingest, both kinds, from the last slice (never a storm target).
  const isolatedSlice = pool.length - 1
  const isolatedBitmaps = await decodeSlice(isolatedSlice)
  if (isolatedBitmaps instanceof Error) {
    stage.dispose()
    cleanup()
    return isolatedBitmaps
  }
  owned.push(...isolatedBitmaps)
  const ingestUrlMs = await isolatedIngest(stage, 'url', pool[isolatedSlice], isolatedBitmaps)
  const ingestBitmapMs = await isolatedIngest(stage, 'bitmap', pool[isolatedSlice], isolatedBitmaps)
  const ingestMs = spec.source === 'url' ? ingestUrlMs : ingestBitmapMs
  const idealMs = Math.max(issueSpanMs(spec.cadence), VIEWS * ingestMs)
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
    mountMs,
    ingestMs,
    ingestUrlMs,
    ingestBitmapMs,
    idealMs,
    storms,
    best,
    ...(REAL_GPU && spec.cadence !== 'idle' ? { verdict: verdictFor(storms[best], VIEWS) } : {}),
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
      if (GATE && row.verdict !== undefined) {
        expect(
          row.verdict.checks.filter((c) => !c.pass).map((c) => `${c.name} ${c.value} > ${c.limit}`),
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
