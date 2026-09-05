/**
 * The shapes the smoothness bench writes and the node-side sink reads — one JSON layout shared by
 * the browser harness (`swap30.smooth.bench.ts`) and the vitest browser commands (`commands.ts`).
 */

/** Quantiles of one column, in milliseconds. */
export interface Quantiles {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

export interface LongTasks {
  /** `PerformanceObserver` `longtask` entries — tasks over 50 ms by that API's definition. */
  readonly count: number
  readonly maxMs: number
  readonly totalMs: number
  /** `[startMs, durationMs]`, start relative to the storm's first call. */
  readonly entries: readonly (readonly [number, number])[]
}

/**
 * Every top-level main-thread task inside the storm window, from the CDP trace. The quantiles
 * are over the **work tasks** — those of 1 ms or more (`n`); the sub-millisecond bookkeeping
 * (timer ticks, input dispatch, empty animation frames — `all` counts them) cannot block anything
 * and would otherwise pin p95 to zero. `max` is over every task.
 */
export interface TaskStats extends Quantiles {
  readonly all: number
  /** The task length under which 95 % of the busy time falls — the same p95 weighted by time. */
  readonly p95Weighted: number
  /** Tasks over 50 ms — should agree with `LongTasks.count`, which is the in-page observer. */
  readonly over50: number
  readonly totalMs: number
  /** `'tracing'` when the `RunTask` events were found between the storm marks; else `'none'`. */
  readonly source: 'tracing' | 'none'
}

export interface FrameStats extends Quantiles {
  /** Frames the 60 Hz cadence lost: `sum(round(dt / 16.67) - 1)` over every rAF interval. */
  readonly dropped: number
  readonly longestGapMs: number
}

export interface InputStats {
  /** Events the page-level handler saw inside the storm window. */
  readonly handled: number
  /** `performance.now() - event.timeStamp` at the handler. */
  readonly latency: Quantiles
  /** The longest interval with no input handled — head and tail of the window included. */
  readonly longestGapMs: number
  /** The CDP round trip of every `Input.dispatch*`, send to acknowledgement, seen from node. */
  readonly ack: Quantiles
  readonly sent: number
}

/** How the storm's swaps settled, per view, and whether every add produced its own front. */
export interface AddStats {
  /** Runs that settled to a `SwapResult`: the view now shows the new sprite. */
  readonly ok: number
  /** Runs that settled to an `Error`: the add failed and the view rolled back. */
  readonly failed: number
  /** Runs that settled `ABORTED` — superseded (the double-swap row's first wave). */
  readonly aborted: number
  /** Distinct `${rect.x},${rect.y},${rect.w},${rect.h}` over the sprites the **successful** adds
   *  produced (`sprite.rect`, the silhouette's box in source pixels) — 30 distinct artworks must
   *  give 30 distinct rects; fewer means two runs share one sprite, or a front was built from
   *  another sprite's field (the §1.3 `burst-bitmap` regression). */
  readonly distinctRects: number
  /** Distinct pixel hashes of the swapped views' canvases once every run settled — the robust
   *  form of the same check: a front built from another sprite's artwork is another's pixels. */
  readonly distinctPixels: number
  readonly messages: readonly string[]
}

export interface StormResult {
  /** 0 is the cold storm (shaders, pools and the decode path warm up); 1.. are timed. */
  readonly iteration: number
  /** First swap call → the last view's `end`; for `idle`, the window itself. */
  readonly stormMs: number
  /** First swap call → the last `sheet.build` return: every new front resident. */
  readonly ingestStormMs: number
  /** First swap call → the last view's first `step` drawn with its new sprite. */
  readonly lastAdoptMs: number
  /** `ingestStormMs / idealMs` — the throughput floor's ratio (`RowResult.idealMs`). */
  readonly stormRatio: number
  readonly swaps: number
  readonly completed: number
  readonly errors: number
  readonly adds: AddStats
  /** `sheet.source` calls beyond one per view — a superseded swap's ingest that still ran. */
  readonly wastedIngests: number
  readonly longTasks: LongTasks
  readonly tasks: TaskStats
  /** The main thread's waits on the GPU process, from the trace (`NO_STALLS` without one). */
  readonly stalls: TraceStalls
  /** The three longest tasks and what they spent their time in. */
  readonly anatomy: readonly TaskAnatomy[]
  readonly frames: FrameStats
  readonly input: InputStats
  /** Wrapped-method timers: `sourceWallMs`, `readPixelsMs`, `blitMs`, `rectMs`, `...Calls`. */
  readonly phases: Readonly<Record<string, number>>
  /** Path of the `.cpuprofile`, when this storm ran under the profiler. */
  readonly profile?: string
}

export interface Check {
  readonly name: string
  readonly value: number
  readonly limit: number
  readonly pass: boolean
}

export interface Verdict {
  readonly pass: boolean
  readonly checks: readonly Check[]
}

export type Cadence = 'idle' | 'sequential' | 'burst' | 'stream' | 'double'
export type SourceKind = 'url' | 'bitmap'

/**
 * One row, one backend, flattened to the object the smooth-swap plan names as this bench's output
 * contract (`docs/superpowers/plans/2026-09-05-smooth-swap.md`, task S0, "Interfaces — produces").
 * Every field is taken from the better timed storm (`RowResult.best`); the nested `storms` keep
 * everything this drops.
 */
export interface RowSummary {
  /** The plan's row id — `burst-url`, `burst-bitmap`, `stream`, `double-swap`, `sequential`, plus
   *  the extra rows this bench also runs (`idle`, `burst-drag`, `…@dpr2`). */
  readonly row: string
  readonly backend: 'd3d11' | 'swiftshader'
  readonly stormMs: number
  /** `views × the row's sequential per-add median` — see `RowResult.sequentialIdealMs`. */
  readonly sequentialIdealMs: number
  readonly stormRatio: number
  /** The longest top-level main-thread task in the window, from the CDP trace. */
  readonly longestTaskMs: number
  /** Tasks over 50 ms in the trace; `longTasks.count` is the in-page cross-check. */
  readonly longTasks50: number
  /** p95 over the **work tasks** (≥ 1 ms) — see the harness doc comment. */
  readonly taskP95Ms: number
  readonly frameP50Ms: number
  readonly frameP95Ms: number
  readonly frameMaxMs: number
  readonly dropped: number
  readonly inputP50Ms: number
  readonly inputP95Ms: number
  readonly inputMaxMs: number
  readonly inputGapMaxMs: number
  /**
   * `source` is **wall-clock inclusive** (`sheet.source` entry → settle, its awaits included), so
   * it overlaps the others and is not a term of an additive split. `build`, `draw` and `blit` are
   * synchronous self+callee time. `other` is the rest of the window's main-thread busy time:
   * `tasks.totalMs − (build + draw + blit)` — `source`'s own on-thread cost lives in there.
   */
  readonly phases: {
    readonly source: number
    readonly build: number
    readonly draw: number
    readonly blit: number
    readonly other: number
  }
  readonly outcomes: {
    readonly ok: number
    readonly error: number
    readonly aborted: number
    readonly distinctRects: number
    /** Not in the plan's list; the robust twin of `distinctRects`, 0 for a row with no views. */
    readonly distinctPixels: number
    /** `sheet.source` calls beyond one per wanted image — the `double-swap` row's waste. */
    readonly wastedIngests: number
  }
  /** `undefined` on SwiftShader and for `idle` (report-only, spec §11). */
  readonly pass?: boolean
}

export interface RowResult {
  readonly name: string
  readonly cadence: Cadence
  readonly source: SourceKind
  readonly drag: boolean
  /** The DPR asked for; `dprSeen` is what the page reported after the emulation call. */
  readonly dpr: number
  readonly dprSeen: number
  readonly views: number
  readonly artworkPx: number
  readonly artworkCssPx: number
  readonly frontSize: string
  /** The stage's surface, `WxH` — every blit's `drawImage` snapshots this whole buffer. */
  readonly surfaceSize: string
  /** The 30 `stage.mount` calls, sequential, first to last — the page-load number. */
  readonly mountMs: number
  /** Median per-add time of the row's own **sequential probe**: `views` awaited `stage.add`s of
   *  the row's source kind, one after another, before the storms. The plan's `sequential` ideal
   *  measured for this row's source kind. */
  readonly ingestMs: number
  readonly ingestUrlMs: number
  readonly ingestBitmapMs: number
  /** `views × ingestMs` — the plan's `sequentialIdealMs`: the same thirty images ingested one at
   *  a time. Cadence-independent, so it is the throughput floor a storm is measured against. */
  readonly sequentialIdealMs: number
  /** What `stormRatio` divides by: `max(issue span, sequentialIdealMs)`. For `stream` the issue
   *  span (2.9 s) dominates, so its ratio is ~1 by construction and the check bites only when the
   *  stream falls behind; for a burst the two are the same number. */
  readonly idealMs: number
  readonly storms: readonly StormResult[]
  /** Index into `storms` of the timed storm with the lowest task max, then task p95. */
  readonly best: number
  /** Only on the D3D11 backend and only for the swapping rows; SwiftShader is report-only. */
  readonly verdict?: Verdict
  /** The plan's flat per-row contract, over the better timed storm. */
  readonly summary: RowSummary
  readonly note?: string
}

export interface SmoothMeta {
  readonly userAgent: string
  readonly renderer: string
  readonly vendor: string
  readonly realGpu: boolean
  readonly iterations: number
  readonly crossOriginIsolated: boolean
  readonly longTaskObserver: boolean
  /** `innerWidth × innerHeight` of the frame the grid lives in. */
  readonly viewport: { readonly w: number; readonly h: number }
  /** Where that frame sits in the page — the offset the synthesised input is aimed through. */
  readonly frameRect: {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
  }
}

export interface SmoothFile {
  readonly runId: string
  readonly backend: 'd3d11' | 'swiftshader'
  readonly meta: SmoothMeta
  readonly rows: readonly RowResult[]
  /** The flat contract, one object per row — the same objects as `rows[].summary`. */
  readonly summaries: readonly RowSummary[]
}

/** What `smoothInput('start', plan)` drives: a Lissajous sweep over the rect, at `hz`. */
export interface InputPlan {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly hz: number
  readonly clickEveryMs: number
  readonly keyEveryMs: number
}

export interface InputReport {
  readonly sent: number
  readonly acked: number
  readonly failed: number
  readonly ackMs: readonly number[]
}

/** One kind of renderer-side wait, summed over the storm window. */
export interface StallStats {
  readonly n: number
  readonly totalMs: number
  readonly maxMs: number
}

/**
 * Where the main thread waited on the GPU process (the `gpu` trace category). Every synchronous
 * GL call — `getError`, `getParameter` of a read format, `clientWaitSync`, `getBufferSubData`,
 * `checkFramebufferStatus` — is a round trip that returns only once the GPU process has consumed
 * every command queued before it (`CommandBufferProxyImpl::WaitForGetOffset`), so a task's length
 * is the queue's depth at the moment of the call, not the call's own work. A software 2D canvas
 * reads the WebGL surface back the same way at paint (`ReadbackImagePixels`).
 */
export interface TraceStalls {
  /** `GLES2::GetGLError` — `gl.getError()`, the per-allocation check and the readback drain. */
  readonly getError: StallStats
  /** `RasterImplementation::ReadbackImagePixels` — a 2D destination canvas that is not GPU-backed
   *  copying the WebGL surface through the CPU, once per `drawImage`. `n === 0` on the fast path. */
  readonly readback: StallStats
  /** Every `WaitForGetOffset`, whatever the caller — the total the main thread spent blocked. */
  readonly waits: StallStats
  /** The GPU process's main thread: the longest single `GPUTask` (one command-buffer flush the
   *  driver did not return from) and its total over the window. */
  readonly gpuTaskMaxMs: number
  readonly gpuTaskTotalMs: number
}

/** The longest main-thread tasks of the storm, each with what it spent its time in. */
export interface TaskAnatomy {
  readonly ms: number
  /** Start, milliseconds after the storm mark. */
  readonly atMs: number
  /** The longest event nested in the task that is not a scheduler wrapper — the wait or the work. */
  readonly longest: { readonly name: string; readonly ms: number }
  /** The JS entry point the trace names (`functionName url:line`), when there is one. */
  readonly entry?: string
}

/** What `smoothTrace('stop')` returns: every top-level `RunTask` between the storm marks. */
export interface TraceReport {
  /** Task durations in milliseconds, in time order. */
  readonly tasks: readonly number[]
  /** Whether both `smooth:storm:start` / `:end` marks were found; else the whole trace. */
  readonly marks: boolean
  readonly thread: string
  readonly events: number
  readonly stalls: TraceStalls
  /** The three longest tasks, longest first. */
  readonly anatomy: readonly TaskAnatomy[]
}

export const NO_STALLS: TraceStalls = Object.freeze({
  getError: { n: 0, totalMs: 0, maxMs: 0 },
  readback: { n: 0, totalMs: 0, maxMs: 0 },
  waits: { n: 0, totalMs: 0, maxMs: 0 },
  gpuTaskMaxMs: 0,
  gpuTaskTotalMs: 0,
})
