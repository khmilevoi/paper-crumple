/**
 * The node half of the smoothness bench: five vitest browser commands over CDP sessions.
 *
 * - `smoothWrite` merges one file's rows into `BENCH_OUT` (one JSON per run, keyed by row name;
 *   a stale file from an earlier run is replaced) and prints the table — the browser's own
 *   `console.log` is not forwarded by the runner, so this is the bench's whole stdout.
 * - `smoothInput` is the synthesised user: `Input.dispatchMouseEvent` moves at ~60 Hz on a
 *   Lissajous sweep over the grid, a click every 500 ms and an `Input.dispatchKeyEvent` pair every
 *   250 ms. Sends are **not awaited** — a blocked main thread has to queue them the way it queues a
 *   real mouse — and every acknowledgement's round trip is kept (`ackMs`) as the outside view of
 *   the same latency the page measures from `event.timeStamp`.
 * - `smoothTrace` records `disabled-by-default-devtools.timeline` for one storm and returns the
 *   duration of every top-level `RunTask` on the page's main thread between the
 *   `smooth:storm:start` / `:end` user-timing marks — the "all tasks" column the in-page
 *   `longtask` observer (50 ms floor) cannot give.
 * - `smoothEmulate` sets the DPR through `Emulation.setDeviceMetricsOverride`. DPR 1 is *set* the
 *   same way rather than cleared: Playwright installed its own metrics override for the viewport,
 *   and `clearDeviceMetricsOverride` would take that down with ours.
 * - `smoothProfile` starts and stops Chromium's sampling profiler around one extra storm and
 *   writes the `.cpuprofile` under `tools/bench/out/profiles/`; `profile-phases.mjs` reads it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CDPSession, Page } from 'playwright'
import type { BrowserCommand } from 'vitest/node'
import type {
  InputPlan,
  InputReport,
  RowResult,
  SmoothFile,
  SmoothMeta,
  StormResult,
  TraceReport,
} from './types.js'

function ms(x: number | undefined, width = 7, digits = 1): string {
  return x !== undefined && Number.isFinite(x)
    ? x.toFixed(digits).padStart(width)
    : '-'.padStart(width)
}

function stormLine(s: StormResult): string {
  return (
    `    #${s.iteration}${s.profile === undefined ? ' ' : 'P'} storm ${ms(s.stormMs)} ingest ${ms(s.ingestStormMs)} adopt ${ms(s.lastAdoptMs)} ratio ${ms(s.stormRatio, 5, 2)}` +
    ` | task>50 ${String(s.longTasks.count).padStart(2)} max ${ms(s.longTasks.maxMs)} p95 ${ms(s.tasks.p95, 6)} n ${String(s.tasks.n).padStart(4)}` +
    ` | frame p95 ${ms(s.frames.p95, 6)} max ${ms(s.frames.max, 6)} drop ${String(s.frames.dropped).padStart(3)}` +
    ` | input p95 ${ms(s.input.latency.p95, 6)} max ${ms(s.input.latency.max, 6)} gap ${ms(s.input.longestGapMs, 6)}` +
    ` | adds ok ${s.adds.ok} fail ${s.adds.failed} abort ${s.adds.aborted} fronts ${s.adds.distinctPixels} waste ${s.wastedIngests} err ${s.errors}`
  )
}

/** The row's block: a headline on the better timed storm, one line per storm, the phase sums. */
export function rowBlock(r: RowResult): string {
  const s = r.storms[r.best]
  if (s === undefined) return `${r.name} (no storm)\n`
  const p = s.phases
  const verdict =
    r.verdict === undefined
      ? 'report only'
      : r.verdict.pass
        ? 'PASS'
        : // Not "value > limit": `adds ok` and `distinct rects` fail by falling *short* of theirs.
          `FAIL ${r.verdict.checks
            .filter((c) => !c.pass)
            .map((c) => `${c.name} ${c.value.toFixed(1)} (limit ${c.limit})`)
            .join(', ')}`
  const q = r.summary
  const lines = [
    `${r.name} [${q.row}]  front ${r.frontSize} dpr ${r.dprSeen}  mount ${ms(r.mountMs)} ms  ingest url ${ms(r.ingestUrlMs)} bitmap ${ms(r.ingestBitmapMs)}` +
      `  seqIdeal ${ms(r.sequentialIdealMs)} ideal ${ms(r.idealMs)}  ->  ${verdict}`,
    `  best #${s.iteration}: storm ${ms(s.stormMs)} ingest ${ms(s.ingestStormMs)} adopt ${ms(s.lastAdoptMs)} ratio ${ms(s.stormRatio, 5, 2)}` +
      ` | tasks work ${s.tasks.n}/${s.tasks.all} p50 ${ms(s.tasks.p50, 5)} p95 ${ms(s.tasks.p95, 6)} p95w ${ms(s.tasks.p95Weighted, 6)} max ${ms(s.tasks.max, 6)} (>50: ${s.tasks.over50}; longtask ${s.longTasks.count} max ${ms(s.longTasks.maxMs)})` +
      ` | frame p50 ${ms(s.frames.p50, 5)} p95 ${ms(s.frames.p95, 6)} max ${ms(s.frames.max, 6)} drop ${s.frames.dropped}` +
      ` | input p50 ${ms(s.input.latency.p50, 5)} p95 ${ms(s.input.latency.p95, 6)} max ${ms(s.input.latency.max, 6)} gap ${ms(s.input.longestGapMs, 6)} (handled ${s.input.handled}/${s.input.sent}, ack p95 ${ms(s.input.ack.p95, 5)})`,
    `  phases: source ${ms(p.sourceWallMs)} (${p.sourceCalls ?? 0}) readPixels ${ms(p.readPixelsMs)} (${p.readPixelsCalls ?? 0}) build ${ms(p.buildMs ?? p.buildWallMs)} draw ${ms(p.drawMs)} (${p.drawCalls ?? 0})` +
      ` blit ${ms(p.blitMs)} (${p.blitCalls ?? 0}) rect ${ms(p.rectMs)} (${p.rectCalls ?? 0}) upload ${ms(p.uploadMs)} shader ${ms(p.shaderMs)} sync ${ms(p.syncMs)} decodes ${p.decodeCalls ?? 0}` +
      ` | adds ok ${s.adds.ok} fail ${s.adds.failed} abort ${s.adds.aborted} rects ${s.adds.distinctRects} fronts ${s.adds.distinctPixels} waste ${s.wastedIngests}` +
      (s.adds.messages.length === 0 ? '' : ` | ${s.adds.messages.join(' | ')}`),
    ...r.storms.map(stormLine),
    // The plan's flat contract, exactly as it lands in the JSON (`summaries[]`).
    `  plan[${q.row}/${q.backend}]: storm ${ms(q.stormMs)} seqIdeal ${ms(q.sequentialIdealMs)} ratio ${ms(q.stormRatio, 5, 2)}` +
      ` task max ${ms(q.longestTaskMs, 6)} >50 ${q.longTasks50} p95 ${ms(q.taskP95Ms, 6)}` +
      ` | frame ${ms(q.frameP50Ms, 5)}/${ms(q.frameP95Ms, 6)}/${ms(q.frameMaxMs, 6)} drop ${q.dropped}` +
      ` | input ${ms(q.inputP50Ms, 5)}/${ms(q.inputP95Ms, 6)}/${ms(q.inputMaxMs, 6)} gap ${ms(q.inputGapMaxMs, 6)}` +
      ` | ok ${q.outcomes.ok} err ${q.outcomes.error} abort ${q.outcomes.aborted} rects ${q.outcomes.distinctRects} waste ${q.outcomes.wastedIngests}`,
    ...(r.note === undefined ? [] : [`  note: ${r.note}`]),
  ]
  return lines.join('\n') + '\n'
}

interface InputRun {
  timer: ReturnType<typeof setInterval> | null
  pending: Promise<void>[]
  ackMs: number[]
  sent: number
  failed: number
}

interface CommandContext {
  page: Page
  context: { newCDPSession(page: Page): Promise<CDPSession> }
}

interface TraceEvent {
  readonly cat?: string
  readonly name?: string
  readonly ph?: string
  readonly ts?: number
  readonly dur?: number
  readonly pid?: number
  readonly tid?: number
  readonly args?: { readonly name?: string }
}

const MARK_START = 'smooth:storm:start'
const MARK_END = 'smooth:storm:end'

/**
 * Every top-level `RunTask` on the thread that emitted the storm marks, between them. A `RunTask`
 * nested in another (a nested run loop) is skipped so a task is counted once, at its outer length.
 */
export function analyseTrace(events: readonly TraceEvent[]): TraceReport {
  const isMark = (e: TraceEvent, name: string): boolean =>
    e.name === name && (e.ph === 'R' || e.ph === 'I' || e.ph === 'i' || e.ph === 'n')
  const start = events.find((e) => isMark(e, MARK_START))
  const end = events.find((e) => isMark(e, MARK_END))
  const marks = start !== undefined && end !== undefined
  let pid = start?.pid
  let tid = start?.tid
  if (!marks) {
    // No marks: the busiest CrRendererMain by RunTask time.
    const byThread = new Map<string, number>()
    const mains = new Set<string>()
    for (const e of events) {
      if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain') {
        mains.add(`${e.pid}/${e.tid}`)
      }
    }
    for (const e of events) {
      if (e.name !== 'RunTask' || e.ph !== 'X') continue
      const k = `${e.pid}/${e.tid}`
      if (mains.size > 0 && !mains.has(k)) continue
      byThread.set(k, (byThread.get(k) ?? 0) + (e.dur ?? 0))
    }
    const best = [...byThread].sort((a, b) => b[1] - a[1])[0]
    if (best !== undefined) [pid, tid] = best[0].split('/').map(Number)
  }
  const lo = marks ? (start.ts ?? 0) : -Infinity
  const hi = marks ? (end.ts ?? 0) : Infinity
  // Overlap, not containment: the task that issued the storm started before the start mark
  // (the mark is inside it), and a bitmap burst runs all thirty ingests in that very task.
  const runTasks = events
    .filter(
      (e) =>
        e.name === 'RunTask' &&
        e.ph === 'X' &&
        e.pid === pid &&
        e.tid === tid &&
        (e.ts ?? 0) + (e.dur ?? 0) >= lo &&
        (e.ts ?? 0) <= hi,
    )
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  const tasks: number[] = []
  let outerEnd = -Infinity
  for (const e of runTasks) {
    const ts = e.ts ?? 0
    if (ts < outerEnd) continue
    outerEnd = ts + (e.dur ?? 0)
    tasks.push((e.dur ?? 0) / 1000)
  }
  return { tasks, marks, thread: `${pid}/${tid}`, events: events.length }
}

export function smoothCommands(o: { outPath: string; profileDir: string; runId: string }): {
  smoothWrite: BrowserCommand<[RowResult[], SmoothMeta]>
  smoothInput: BrowserCommand<['start' | 'stop', InputPlan?]>
  smoothTrace: BrowserCommand<['start' | 'stop']>
  smoothEmulate: BrowserCommand<[number, number, number]>
  smoothProfile: BrowserCommand<['start' | 'stop', string]>
} {
  const sessions = new WeakMap<Page, Promise<CDPSession>>()
  const sessionFor = (ctx: CommandContext): Promise<CDPSession> => {
    let s = sessions.get(ctx.page)
    if (s === undefined) {
      s = ctx.context.newCDPSession(ctx.page)
      sessions.set(ctx.page, s)
    }
    return s
  }
  let input: InputRun | null = null

  const smoothWrite: BrowserCommand<[RowResult[], SmoothMeta]> = (_ctx, rows, meta) => {
    mkdirSync(dirname(o.outPath), { recursive: true })
    let previous: readonly RowResult[] = []
    try {
      const file = JSON.parse(readFileSync(o.outPath, 'utf8')) as SmoothFile
      if (file.runId === o.runId) previous = file.rows
    } catch {
      // First write of this run, or no file yet.
    }
    const byName = new Map(previous.map((r) => [r.name, r] as const))
    for (const r of rows) byName.set(r.name, r)
    const kept = [...byName.values()]
    const file: SmoothFile = {
      runId: o.runId,
      backend: meta.realGpu ? 'd3d11' : 'swiftshader',
      meta,
      rows: kept,
      // The plan's flat contract, lifted to the top of the file so a reader (or S1/S2's
      // acceptance) never has to walk into `storms[best]` for it.
      summaries: kept.map((r) => r.summary),
    }
    writeFileSync(o.outPath, JSON.stringify(file, null, 2) + '\n')
    process.stdout.write(
      `\n${meta.renderer}\n${meta.realGpu ? 'D3D11 — thresholds apply' : 'SwiftShader — report only'}; ` +
        `viewport ${meta.viewport.w}x${meta.viewport.h}, frame at ${meta.frameRect.x},${meta.frameRect.y}; ` +
        `longtask observer ${meta.longTaskObserver ? 'yes' : 'no'}; crossOriginIsolated ${meta.crossOriginIsolated ? 'yes' : 'no'}\n\n` +
        rows.map(rowBlock).join('\n') +
        '\n',
    )
    return o.outPath
  }

  const smoothInput: BrowserCommand<['start' | 'stop', InputPlan?]> = async (ctx, action, plan) => {
    if (action === 'start') {
      if (input !== null || plan === undefined) return undefined
      const session = await sessionFor(ctx)
      const run: InputRun = { timer: null, pending: [], ackMs: [], sent: 0, failed: 0 }
      const period = 1000 / plan.hz
      const clickEvery = Math.max(1, Math.round(plan.clickEveryMs / period))
      const keyEvery = Math.max(1, Math.round(plan.keyEveryMs / period))
      let phase = 0
      const send = (
        method: 'Input.dispatchMouseEvent' | 'Input.dispatchKeyEvent',
        params: object,
      ): void => {
        run.sent += 1
        const t0 = performance.now()
        run.pending.push(
          (session.send as (m: string, p: object) => Promise<unknown>)(method, params).then(
            () => {
              run.ackMs.push(performance.now() - t0)
            },
            () => {
              run.failed += 1
            },
          ),
        )
      }
      const tick = (): void => {
        phase += 1
        const x = Math.round(plan.x + plan.w * (0.5 + 0.45 * Math.sin(phase * 0.071)))
        const y = Math.round(plan.y + plan.h * (0.5 + 0.45 * Math.cos(phase * 0.053)))
        send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
        if (phase % clickEvery === 0) {
          const click = { x, y, button: 'left', clickCount: 1 }
          send('Input.dispatchMouseEvent', { type: 'mousePressed', ...click })
          send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click })
        }
        if (phase % keyEvery === 0) {
          const key = {
            key: 'a',
            code: 'KeyA',
            windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65,
          }
          send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'a', ...key })
          send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
        }
      }
      run.timer = setInterval(tick, period)
      input = run
      return undefined
    }
    const run = input
    input = null
    if (run === null) return undefined
    if (run.timer !== null) clearInterval(run.timer)
    // Whatever is still unacknowledged is a queued event the page has not handled; give it a
    // bounded moment to drain so its round trip is counted rather than dropped.
    await Promise.race([
      Promise.allSettled(run.pending),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ])
    const report: InputReport = {
      sent: run.sent,
      acked: run.ackMs.length,
      failed: run.failed,
      ackMs: run.ackMs,
    }
    return report
  }

  let tracing: { session: CDPSession; events: TraceEvent[] } | null = null
  const smoothTrace: BrowserCommand<['start' | 'stop']> = async (ctx, action) => {
    if (action === 'start') {
      if (tracing !== null) return undefined
      const session = await ctx.context.newCDPSession(ctx.page)
      const events: TraceEvent[] = []
      session.on('Tracing.dataCollected', (e) => {
        events.push(...(e.value as TraceEvent[]))
      })
      await session.send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: {
          recordMode: 'recordUntilFull',
          includedCategories: [
            'disabled-by-default-devtools.timeline',
            'blink.user_timing',
            '__metadata',
          ],
        },
      })
      tracing = { session, events }
      return undefined
    }
    const t = tracing
    tracing = null
    if (t === null) return undefined
    const complete = new Promise<void>((resolve) => {
      t.session.once('Tracing.tracingComplete', () => resolve())
    })
    await t.session.send('Tracing.end')
    await complete
    await t.session.detach()
    return analyseTrace(t.events)
  }

  const smoothEmulate: BrowserCommand<[number, number, number]> = async (
    ctx,
    dpr,
    width,
    height,
  ) => {
    const session = await sessionFor(ctx)
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: false,
    })
    return undefined
  }

  const profiling = new Map<string, CDPSession>()
  const smoothProfile: BrowserCommand<['start' | 'stop', string]> = async (ctx, action, label) => {
    if (action === 'start') {
      const session = await ctx.context.newCDPSession(ctx.page)
      await session.send('Profiler.enable')
      // 250 µs: a storm runs for seconds, and 100 µs made the JSON tens of megabytes for no extra
      // precision at the millisecond phases this profile is read for.
      await session.send('Profiler.setSamplingInterval', { interval: 250 })
      await session.send('Profiler.start')
      profiling.set(label, session)
      return undefined
    }
    const session = profiling.get(label)
    if (session === undefined) return undefined
    const { profile } = await session.send('Profiler.stop')
    await session.detach()
    profiling.delete(label)
    mkdirSync(o.profileDir, { recursive: true })
    const path = join(o.profileDir, `${label}.cpuprofile`)
    writeFileSync(path, JSON.stringify(profile))
    return path
  }

  return { smoothWrite, smoothInput, smoothTrace, smoothEmulate, smoothProfile }
}
