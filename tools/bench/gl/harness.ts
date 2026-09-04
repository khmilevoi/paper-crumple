/**
 * The browser half of the GL bench: a fixture, a measuring loop, a GL call counter and the sink.
 *
 * **What is measured, and what the two columns mean.** `measure()` times one scenario as
 * `performance.now()` around the call (`callMs` — JS plus the command-buffer encoding Chromium's
 * WebGL client does synchronously) and, separately, the `gl.finish()` that follows it
 * (`finishMs` — the GPU process draining). Under SwiftShader the second column is a software
 * rasteriser on the GPU-process thread and is a proxy for GPU time, nothing more; under
 * `BENCH_GPU=1` the `EXT_disjoint_timer_query_webgl2` column (`gpuMs`) is the real one and
 * disjoint samples are discarded, exactly as `createGpuTimer` does.
 *
 * **The counting proxy never sits under a timed iteration.** Wrapping every method of
 * `WebGL2RenderingContext.prototype` costs a closure call per GL call, so the counts come from one
 * extra iteration run after the timed ones, with the wrappers installed and then removed again.
 *
 * **`performance.now()` resolution.** Vitest's browser page is not cross-origin isolated, so the
 * clock is coarsened to 100 µs. Every scenario here is milliseconds, and the sub-phase timers sum
 * dozens of samples, so the quantisation is below the run-to-run spread; `meta.crossOriginIsolated`
 * records the fact rather than pretending otherwise.
 */
import { commands } from 'vitest/browser'
import { createGlContext, createGpuTimer, GL_ATTRIBUTES } from './deps.js'
import type { CoreGlContext, GlContext, GpuTimer } from './deps.js'
import type { BenchMeta, ScenarioResult, Stats } from './types.js'

declare module 'vitest/browser' {
  interface BrowserCommands {
    benchWrite: (scenarios: ScenarioResult[], meta: BenchMeta) => Promise<string>
    benchProfile: (action: 'start' | 'stop', label: string) => Promise<string | undefined>
  }
}

declare const __BENCH_ITER__: number
declare const __BENCH_GPU__: boolean
declare const __BENCH_PROFILE__: boolean

/** Timed iterations per scenario; `BENCH_ITER` in the environment, 5 by default. */
export const ITERATIONS: number = __BENCH_ITER__
/** `BENCH_GPU=1`: the page was launched on ANGLE D3D11, not SwiftShader. */
export const REAL_GPU: boolean = __BENCH_GPU__
/** `BENCH_PROFILE=1`: scenarios flagged `profile: true` also run once under the CDP profiler. */
export const PROFILE: boolean = __BENCH_PROFILE__

// --- the fixture -----------------------------------------------------------------------------

export interface Fixture {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  readonly ctx: CoreGlContext
  /** `null` without `EXT_disjoint_timer_query_webgl2` — SwiftShader, in practice. */
  readonly timer: GpuTimer | null
  dispose(): void
}

let described: Omit<BenchMeta, 'iterations' | 'realGpu'> | null = null

function describe(gl: WebGL2RenderingContext, ctx: GlContext): void {
  if (described !== null) return
  const info = gl.getExtension('WEBGL_debug_renderer_info') as {
    UNMASKED_RENDERER_WEBGL: number
    UNMASKED_VENDOR_WEBGL: number
  } | null
  described = {
    userAgent: navigator.userAgent,
    renderer:
      info === null
        ? String(gl.getParameter(gl.RENDERER))
        : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
    vendor:
      info === null
        ? String(gl.getParameter(gl.VENDOR))
        : String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)),
    timerExtension: ctx.caps.timer,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    floatRT: ctx.caps.floatRT,
  }
}

/**
 * A canvas with §7.3's attribute bag, the `CoreGlContext` over it, and a GPU timer when the driver
 * offers one. Released by the caller: the browser caps live WebGL2 contexts at about sixteen.
 */
export function openFixture(width = 8, height = 8): Fixture | Error {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.append(canvas)
  const gl = canvas.getContext('webgl2', GL_ATTRIBUTES)
  if (gl === null) {
    canvas.remove()
    return new Error('no WebGL2 context — check the launch flags')
  }
  const ctx = createGlContext(gl, { owned: true })
  describe(gl, ctx)
  return {
    canvas,
    gl,
    ctx,
    timer: createGpuTimer(ctx),
    dispose() {
      ctx.dispose()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    },
  }
}

/**
 * A timer over a context the bench did not create — the stage's own surface. `createGpuTimer`
 * reads `caps.timer` and `gl` and nothing else, which is what this minimal `GlContext` carries.
 */
export function timerFor(gl: WebGL2RenderingContext): GpuTimer | null {
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null
  const floatRT = gl.getExtension('EXT_color_buffer_float') !== null
  const ctx = { caps: { timer, floatRT }, gl } as unknown as GlContext
  describe(gl, ctx)
  return createGpuTimer(ctx)
}

// --- the silhouette every scenario draws -----------------------------------------------------

// A garment-ish silhouette: a torso disc, two legs and the concave gap between them. One
// definition, shared with `gl-sdf.gl.test.ts`'s texel-selection oracle so "identical on the bench
// artwork" is a statement about this artwork; it is test-only source in the paper package,
// imported by relative path because `tools/` is outside the workspace on purpose.
export {
  insideSilhouette,
  silhouetteBytes,
} from '../../../packages/paper/src/testing/silhouette.js'

/** The same silhouette drawn with a 2D context — antialiased edges, like a decoded PNG. */
export async function silhouetteBitmap(w: number, h: number): Promise<ImageBitmap | Error> {
  const canvas = new OffscreenCanvas(w, h)
  const c2d = canvas.getContext('2d')
  if (c2d === null) return new Error('no 2D context for the silhouette')
  const g = c2d.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#c33')
  g.addColorStop(1, '#36c')
  c2d.fillStyle = g
  const cx = w / 2
  const cy = h * 0.36
  const r = Math.min(w, h) * 0.27
  c2d.beginPath()
  c2d.arc(cx, cy, r, 0, Math.PI * 2)
  c2d.fill()
  const legW = w * 0.15
  c2d.fillRect(cx - w * 0.22, cy, legW, h * 0.93 - cy)
  c2d.fillRect(cx + w * 0.07, cy, legW, h * 0.93 - cy)
  return createImageBitmap(canvas, { premultiplyAlpha: 'none' })
}

// --- the GL call counter ---------------------------------------------------------------------

const counts = new Map<string, number>()
const originals = new Map<string, PropertyDescriptor>()

function installGlCounters(): void {
  if (originals.size > 0) return
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(proto)) {
    const desc = Object.getOwnPropertyDescriptor(proto, name)
    if (desc === undefined || typeof desc.value !== 'function' || name === 'constructor') continue
    const original = desc.value as (this: unknown, ...args: unknown[]) => unknown
    originals.set(name, desc)
    Object.defineProperty(proto, name, {
      ...desc,
      value: function counted(this: unknown, ...args: unknown[]): unknown {
        counts.set(name, (counts.get(name) ?? 0) + 1)
        return original.apply(this, args)
      },
    })
  }
  counts.clear()
}

function uninstallGlCounters(): Record<string, number> {
  const proto = WebGL2RenderingContext.prototype as unknown as Record<string, unknown>
  for (const [name, desc] of originals) Object.defineProperty(proto, name, desc)
  originals.clear()
  const out: Record<string, number> = {}
  for (const [name, n] of [...counts].sort((a, b) => b[1] - a[1])) out[name] = n
  counts.clear()
  return out
}

/** The handful of totals worth a column in the printed table. */
export function summarizeCounts(c: Readonly<Record<string, number>>): Record<string, number> {
  let uniforms = 0
  for (const [name, n] of Object.entries(c)) if (name.startsWith('uniform')) uniforms += n
  return {
    draws: (c.drawArrays ?? 0) + (c.drawElements ?? 0),
    useProgram: c.useProgram ?? 0,
    bindTexture: c.bindTexture ?? 0,
    bindFramebuffer: c.bindFramebuffer ?? 0,
    getParameter: (c.getParameter ?? 0) + (c.isEnabled ?? 0),
    getError: c.getError ?? 0,
    checkFramebufferStatus: c.checkFramebufferStatus ?? 0,
    readPixels: c.readPixels ?? 0,
    uniforms,
    texSubImage2D: c.texSubImage2D ?? 0,
    texStorage2D: c.texStorage2D ?? 0,
    createFramebuffer: c.createFramebuffer ?? 0,
  }
}

// --- the measuring loop ----------------------------------------------------------------------

export function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return { n, min: NaN, median: NaN, mean: NaN, max: NaN }
  const median = n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
  return { n, min: s[0], median, mean: s.reduce((a, b) => a + b, 0) / n, max: s[n - 1] }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1))

/**
 * Waits for the one in-flight query, bounded: a disjoint interval never resolves to a number.
 *
 * The bound is generous on purpose. Under SwiftShader `gl.finish()` returns before the rasteriser
 * has drained (measured: `finishMs` ~0 against multi-second query results), so this wait is the
 * only thing that keeps one iteration's raster from back-pressuring the next one's calls — and
 * a 1024² torn front takes ~2.5 s there.
 */
async function drainTimer(timer: GpuTimer): Promise<number | undefined> {
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    const v = timer.poll()
    if (v !== undefined) return v
    await tick()
  }
  return undefined
}

export interface MeasureOptions {
  readonly gl: WebGL2RenderingContext
  /** The scenario. May be async (the end-to-end ones are). */
  readonly run: () => unknown
  readonly iterations?: number
  /** Untimed runs before the timed ones. 1 by default: programs link and pools allocate lazily. */
  readonly warmup?: number
  readonly timer?: GpuTimer | null
  /** Runs before every iteration, outside the timed window — fresh inputs, for instance. The
   *  index counts every run: warm-up, timed, counted and profiled. */
  readonly before?: (i: number) => unknown
  readonly after?: (i: number) => unknown
  readonly extra?: () => Record<string, number | string>
  readonly note?: string
  /** Also run once under the CDP profiler when `BENCH_PROFILE=1`. */
  readonly profile?: boolean
}

/** How many times `run` will be called, so a caller can prepare one input per run. */
export function plannedRuns(o: Pick<MeasureOptions, 'iterations' | 'warmup' | 'profile'>): number {
  return (
    (o.warmup ?? 1) + (o.iterations ?? ITERATIONS) + 1 + (PROFILE && o.profile === true ? 1 : 0)
  )
}

const results: ScenarioResult[] = []

export async function measure(name: string, o: MeasureOptions): Promise<ScenarioResult> {
  const iterations = o.iterations ?? ITERATIONS
  const warmup = o.warmup ?? 1
  const call: number[] = []
  const finish: number[] = []
  const gpu: number[] = []
  const timer = o.timer ?? null
  let i = 0
  for (; i < warmup + iterations; i++) {
    await o.before?.(i)
    timer?.begin()
    const t0 = performance.now()
    await o.run()
    const t1 = performance.now()
    timer?.end()
    o.gl.finish()
    const t2 = performance.now()
    const g = timer === null ? undefined : await drainTimer(timer)
    await o.after?.(i)
    if (i >= warmup) {
      call.push(t1 - t0)
      finish.push(t2 - t1)
      if (g !== undefined) gpu.push(g)
    }
  }

  await o.before?.(i)
  installGlCounters()
  await o.run()
  const counted = uninstallGlCounters()
  o.gl.finish()
  await o.after?.(i)
  i += 1

  let profile: string | undefined
  if (PROFILE && o.profile === true) {
    await o.before?.(i)
    await commands.benchProfile('start', name)
    await o.run()
    o.gl.finish()
    profile = await commands.benchProfile('stop', name)
    await o.after?.(i)
  }

  const result: ScenarioResult = {
    name,
    iterations,
    callMs: stats(call),
    finishMs: stats(finish),
    ...(gpu.length > 0 ? { gpuMs: stats(gpu) } : {}),
    counts: counted,
    ...(o.extra === undefined ? {} : { extra: o.extra() }),
    ...(o.note === undefined ? {} : { note: o.note }),
    ...(profile === undefined ? {} : { profile }),
  }
  results.push(result)
  console.log(row(result))
  return result
}

function ms(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2).padStart(9) : '        -'
}

export function row(r: ScenarioResult): string {
  const c = summarizeCounts(r.counts)
  const gpu = r.gpuMs === undefined ? '' : ` gpu ${ms(r.gpuMs.median)}`
  return (
    `${r.name.padEnd(28)} call ${ms(r.callMs.median)} (min ${ms(r.callMs.min)})  finish ${ms(r.finishMs.median)}${gpu}` +
    `  | draws ${c.draws} prog ${c.useProgram} tex ${c.bindTexture} fbo ${c.bindFramebuffer} ` +
    `get ${c.getParameter} err ${c.getError} cfs ${c.checkFramebufferStatus} read ${c.readPixels} uni ${c.uniforms}`
  )
}

/** Hands this file's results to the node sink. Call from `afterAll`. */
export async function flush(): Promise<void> {
  if (described === null) {
    // A file that never opened a fixture (the blit ones) still has to describe the driver.
    const probe = openFixture(1, 1)
    if (!(probe instanceof Error)) probe.dispose()
  }
  if (described === null) return
  const meta: BenchMeta = { ...described, realGpu: REAL_GPU, iterations: ITERATIONS }
  const path = await commands.benchWrite(results.splice(0), meta)
  console.log(`bench: wrote ${path}`)
}

export function unwrap<T>(v: T | Error, what: string): T {
  if (v instanceof Error) {
    console.error(`${what}: ${v.message}`)
    // The suites assert on this: a scenario that cannot be set up fails by name.
    return undefined as never
  }
  return v
}
