/**
 * The shapes the GL bench writes and the node-side sink reads. Shared by the browser harness and
 * the vitest browser commands, so both halves agree on one JSON layout.
 */

/** Five-number summary of one column, in milliseconds. */
export interface Stats {
  readonly n: number
  readonly min: number
  readonly median: number
  readonly mean: number
  readonly max: number
}

export interface ScenarioResult {
  /** `gl.sdf.build.512`, `gl.e2e.fold.grid16`, ... — the names the brief fixes. */
  readonly name: string
  /** Timed iterations, after the warm-up. */
  readonly iterations: number
  /** `performance.now()` around the call itself: JS plus command encoding. */
  readonly callMs: Stats
  /**
   * The `gl.finish()` that follows the call, alone. On SwiftShader this is the software
   * rasteriser draining on the GPU-process thread and is only a proxy for GPU time; on a real GPU
   * it is the queue draining and `gpuMs` is the number to read.
   */
  readonly finishMs: Stats
  /** `EXT_disjoint_timer_query_webgl2` around the call, disjoint samples discarded. Absent on
   *  SwiftShader, where the extension is not offered. */
  readonly gpuMs?: Stats
  /** WebGL2 calls made by ONE run of the scenario, by method name, from a separately counted
   *  iteration so the counting proxy never sits under the timed ones. */
  readonly counts: Readonly<Record<string, number>>
  /** Scenario-specific figures: sub-phase timings, sizes, per-step averages. */
  readonly extra?: Readonly<Record<string, number | string>>
  readonly note?: string
  /** Path of the `.cpuprofile` a profiled iteration wrote, when `BENCH_PROFILE=1`. */
  readonly profile?: string
}

export interface BenchMeta {
  readonly userAgent: string
  readonly renderer: string
  readonly vendor: string
  /** `BENCH_GPU=1`: ANGLE D3D11 rather than SwiftShader. */
  readonly realGpu: boolean
  readonly iterations: number
  readonly timerExtension: boolean
  readonly crossOriginIsolated: boolean
  readonly floatRT: boolean
}

export interface BenchFile {
  readonly runId: string
  readonly meta: BenchMeta
  readonly scenarios: readonly ScenarioResult[]
}
