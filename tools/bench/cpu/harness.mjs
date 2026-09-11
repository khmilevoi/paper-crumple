/**
 * A dependency-free micro-benchmark harness: warm up, time single calls until the sample is
 * large enough for a stable median, then (with `--expose-gc`) take a few single-call allocation
 * samples, and optionally record a V8 CPU profile covering ONLY the timed loop (no setup noise).
 *
 * A scenario is `{ name, note?, setup, prepare?, op, teardown? }`:
 *   - `setup()` runs once and returns the context every other hook receives;
 *   - `prepare(ctx)` runs before every call, untimed — it restores whatever `op` consumes
 *     (a stage run to advance, a cache to clear);
 *   - `op(ctx)` is the measured call; when it returns a promise the timing runs until it settles.
 */
import { performance, PerformanceObserver } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const now = () => performance.now()

export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function heapInUse() {
  const m = process.memoryUsage()
  return m.heapUsed + m.arrayBuffers
}

function post(session, method, params) {
  return new Promise((resolve, reject) => {
    session.post(method, params, (err, result) => (err ? reject(err) : resolve(result)))
  })
}

/** Lets pending `PerformanceObserver` deliveries (the forced GC's own entry) land. */
const settle = () => new Promise((r) => setTimeout(r, 0))

export const DEFAULT_OPTIONS = Object.freeze({
  warmupMs: 200,
  warmupMin: 3,
  minTimeMs: 1000,
  minIterations: 15,
  maxIterations: 20_000,
  allocSamples: 5,
  /** Directory for `<name>.cpuprofile`, or null to skip profiling. */
  profileDir: null,
  /** Profiler sampling interval in microseconds. */
  samplingIntervalUs: 100,
})

export async function runScenario(scenario, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options }
  const ctx = await scenario.setup()
  const prepare = scenario.prepare ?? (() => {})
  const op = scenario.op

  // An `op` may return a promise (a stage `add`, whose awaits settle on the microtask queue with
  // fake slots); the timed region then runs until it settles.
  const call = async () => {
    const r = op(ctx)
    if (r !== null && typeof r === 'object' && typeof r.then === 'function') await r
  }

  // Warm-up: enough calls for the JIT to settle, never counted.
  let warm = 0
  const warmStart = now()
  while (warm < o.warmupMin || now() - warmStart < o.warmupMs) {
    prepare(ctx)
    await call()
    warm += 1
    await null
    if (warm >= o.maxIterations) break
  }

  let session = null
  if (o.profileDir !== null) {
    session = new Session()
    session.connect()
    await post(session, 'Profiler.enable')
    await post(session, 'Profiler.setSamplingInterval', { interval: o.samplingIntervalUs })
    await post(session, 'Profiler.start')
  }

  const samples = []
  let timed = 0
  while (samples.length < o.maxIterations) {
    prepare(ctx)
    const t0 = now()
    await call()
    const dt = now() - t0
    samples.push(dt)
    timed += dt
    // Yield to the microtask queue between calls so a scenario that settles promises (a stage
    // run's `end`) does not pile a whole run's continuations onto the last iteration.
    await null
    if (samples.length >= o.minIterations && timed >= o.minTimeMs) break
  }

  let profilePath = null
  if (session !== null) {
    const { profile } = await post(session, 'Profiler.stop')
    session.disconnect()
    mkdirSync(o.profileDir, { recursive: true })
    profilePath = join(o.profileDir, `${scenario.name}.cpuprofile`)
    writeFileSync(profilePath, JSON.stringify(profile))
  }

  // Allocation pressure: bytes the heap grew by across ONE call, after a forced GC. A lower bound
  // whenever a collection ran inside the call; `gcDuringSamples` says how often that happened.
  let alloc = null
  if (typeof globalThis.gc === 'function' && session === null && o.allocSamples > 0) {
    let gcSeen = 0
    const observer = new PerformanceObserver((list) => {
      gcSeen += list.getEntries().length
    })
    observer.observe({ entryTypes: ['gc'] })
    const deltas = []
    for (let i = 0; i < o.allocSamples; i += 1) {
      prepare(ctx)
      globalThis.gc()
      await settle()
      await settle()
      gcSeen = 0
      const before = heapInUse()
      await call()
      const after = heapInUse()
      await settle()
      await settle()
      deltas.push(after - before)
    }
    observer.disconnect()
    deltas.sort((a, b) => a - b)
    alloc = { bytesPerOp: quantile(deltas, 0.5), gcDuringSamples: gcSeen }
  }

  scenario.teardown?.(ctx)

  const sorted = samples.slice().sort((a, b) => a - b)
  const medianMs = quantile(sorted, 0.5)
  return {
    name: scenario.name,
    note: scenario.note ?? null,
    iterations: samples.length,
    medianMs,
    meanMs: timed / samples.length,
    minMs: sorted[0],
    p10Ms: quantile(sorted, 0.1),
    p90Ms: quantile(sorted, 0.9),
    p95Ms: quantile(sorted, 0.95),
    opsPerSec: medianMs > 0 ? 1000 / medianMs : Infinity,
    alloc,
    profile: profilePath,
  }
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return String(ms)
  if (ms >= 100) return ms.toFixed(1)
  if (ms >= 10) return ms.toFixed(2)
  if (ms >= 1) return ms.toFixed(3)
  return ms.toFixed(4)
}

function fmtOps(ops) {
  if (!Number.isFinite(ops)) return '-'
  if (ops >= 1000) return Math.round(ops).toLocaleString('en-US')
  return ops.toFixed(1)
}

function fmtBytes(alloc) {
  if (alloc === null) return '-'
  const b = alloc.bytesPerOp
  const abs = Math.abs(b)
  const text =
    abs >= 1 << 20
      ? `${(b / (1 << 20)).toFixed(2)} MB`
      : abs >= 1024
        ? `${(b / 1024).toFixed(1)} KB`
        : `${Math.round(b)} B`
  return alloc.gcDuringSamples > 0 ? `>=${text}` : text
}

export function formatTable(results) {
  const rows = results.map((r) => [
    r.name,
    fmtMs(r.medianMs),
    fmtMs(r.meanMs),
    fmtMs(r.p90Ms),
    fmtMs(r.p95Ms),
    fmtOps(r.opsPerSec),
    String(r.iterations),
    fmtBytes(r.alloc),
  ])
  const head = ['scenario', 'median ms', 'mean ms', 'p90 ms', 'p95 ms', 'ops/s', 'n', 'alloc/op']
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)))
  const line = (cells) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}
