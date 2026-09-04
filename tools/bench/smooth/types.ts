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
  /** Distinct `view.frame.artwork` rects among the views that swapped — 30 distinct artworks
   *  should give 30 distinct rects; fewer means fronts built from another sprite's field. */
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

export type Cadence = 'idle' | 'burst' | 'stream' | 'double'
export type SourceKind = 'url' | 'bitmap'

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
  /** The 30 `stage.mount` calls, sequential, first to last — the page-load number. */
  readonly mountMs: number
  /** One `stage.add` of the row's source kind, alone on the idle stage: median of three. */
  readonly ingestMs: number
  readonly ingestUrlMs: number
  readonly ingestBitmapMs: number
  /** The sequential ideal: `max(issue span, views × ingestMs)`. */
  readonly idealMs: number
  readonly storms: readonly StormResult[]
  /** Index into `storms` of the timed storm with the lowest task max, then task p95. */
  readonly best: number
  /** Only on the D3D11 backend and only for the swapping rows; SwiftShader is report-only. */
  readonly verdict?: Verdict
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
  readonly meta: SmoothMeta
  readonly rows: readonly RowResult[]
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

/** What `smoothTrace('stop')` returns: every top-level `RunTask` between the storm marks. */
export interface TraceReport {
  /** Task durations in milliseconds, in time order. */
  readonly tasks: readonly number[]
  /** Whether both `smooth:storm:start` / `:end` marks were found; else the whole trace. */
  readonly marks: boolean
  readonly thread: string
  readonly events: number
}
