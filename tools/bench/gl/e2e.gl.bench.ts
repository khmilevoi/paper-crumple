/**
 * The two end-to-end scenarios, through the public `paperStage` API and nothing else.
 *
 * - `gl.e2e.add.1024`: `stage.add()` of a 1024² synthetic bitmap on a `maxSize: 1024` blit
 *   stage, wall-clock from the call to the resolved sprite (`callMs`) with the sheet's `source()`
 *   and `build()` and the motion slot's `load()` timed separately by wrapping the slot methods.
 *   A fresh bitmap per run — a sprite key is minted per bitmap identity, so a reused one would
 *   hit the hull cache and skip the resample — and one anchor sprite kept alive so the motion pack
 *   stays resident, as it does in any grid.
 * - `gl.e2e.fold.grid16`: sixteen mounted views, one `stage.play('flat', 'ball', { duration: 0 })`
 *   — every dwell scaled to zero, so the run is bounded by the steps' own work and the browser's
 *   timer floor, not by the authored 495 ms — wall-clock from `play()` to its promise
 *   (`callMs`) and to the last view's `end` event (`lastEndMs`). The JS spent inside the step
 *   callbacks is summed by wrapping `setTimeout` for the duration of the run (`stepJsMs`); the
 *   slot draw and the 2D blit are wrapped separately (`drawJsMs`, `blitJsMs`).
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  bakedMotion,
  isAborted,
  pack1x1,
  pack2x3,
  pack3x2,
  paperSheet,
  paperStage,
} from './deps.js'
import type { View } from './deps.js'
import { flush, measure, plannedRuns, silhouetteBitmap, stats, timerFor } from './harness.js'

afterAll(flush)

/** Wraps a method so `acc[key]` accumulates the milliseconds spent inside it, awaits included. */
function timed<T extends object, K extends keyof T>(
  target: T,
  method: K,
  acc: Record<string, number>,
  key: string,
): void {
  const original = target[method] as unknown as (...args: unknown[]) => unknown
  const wrapped = (...args: unknown[]): unknown => {
    const t = performance.now()
    const r = original.apply(target, args)
    if (r instanceof Promise) {
      return r.finally(() => {
        acc[key] = (acc[key] ?? 0) + (performance.now() - t)
      })
    }
    acc[key] = (acc[key] ?? 0) + (performance.now() - t)
    return r
  }
  ;(target as Record<K, unknown>)[method] = wrapped
}

function median(rows: readonly Record<string, number>[], key: string): number {
  return stats(rows.map((r) => r[key] ?? 0)).median
}

describe('gl.e2e', () => {
  it('gl.e2e.add.1024', async () => {
    const sheet = paperSheet()
    const motion = bakedMotion({ packs: [pack1x1, pack2x3, pack3x2] })
    const phases: Record<string, number> = {}
    timed(sheet, 'source', phases, 'sourceMs')
    timed(sheet, 'build', phases, 'buildMs')
    timed(motion, 'load', phases, 'loadMs')
    timed(motion, 'fit', phases, 'fitMs')

    const errors: string[] = []
    const stage = await paperStage({
      sheet,
      motion,
      maxSize: 1024,
      present: 'blit',
      onError: (e) => errors.push(e.error.message),
    })
    expect(stage).not.toBeInstanceOf(Error)
    if (stage instanceof Error || isAborted(stage)) return
    const gl = stage.surface.canvas.getContext('webgl2') as WebGL2RenderingContext | null
    expect(gl).not.toBeNull()
    if (gl === null) return
    const timer = timerFor(gl)

    const runs = plannedRuns({ profile: true })
    const bitmaps = await Promise.all(
      Array.from({ length: runs + 1 }, () => silhouetteBitmap(1024, 1024)),
    )
    for (const b of bitmaps) expect(b).not.toBeInstanceOf(Error)
    const ready = bitmaps.filter((b): b is ImageBitmap => !(b instanceof Error))
    if (ready.length !== bitmaps.length) return

    // The anchor keeps the pack resident across `remove()`s, as any other sprite in a grid would.
    const anchor = await stage.add(ready[runs], { key: 'anchor', pin: true })
    expect(anchor).not.toBeInstanceOf(Error)
    if (anchor instanceof Error || isAborted(anchor)) return

    const perRun: Record<string, number>[] = []
    let current = 0
    let frontSize = ''
    await measure('gl.e2e.add.1024', {
      gl,
      timer,
      profile: true,
      before: (i) => {
        current = i
        for (const k of Object.keys(phases)) phases[k] = 0
      },
      run: async () => {
        const sprite = await stage.add(ready[current], { key: `k${current}`, pin: true })
        expect(sprite).not.toBeInstanceOf(Error)
        if (!(sprite instanceof Error) && !isAborted(sprite)) {
          frontSize = `${sprite.frontSize.w}x${sprite.frontSize.h}`
        }
      },
      after: (i) => {
        perRun.push({ ...phases })
        stage.remove(`k${i}`)
      },
      extra: () => ({
        sourceMs: median(perRun.slice(1), 'sourceMs'),
        buildMs: median(perRun.slice(1), 'buildMs'),
        loadMs: median(perRun.slice(1), 'loadMs'),
        fitMs: median(perRun.slice(1), 'fitMs'),
        frontSize,
        errors: errors.length,
      }),
      note: 'stage.add(ImageBitmap 1024², pin) on a maxSize 1024 blit stage, hull mode; sourceMs/buildMs/loadMs are the slot calls inside it',
    })

    stage.dispose()
    for (const b of ready) b.close()
  })

  it('gl.e2e.fold.grid16', async () => {
    const sheet = paperSheet()
    const motion = bakedMotion({ packs: [pack1x1, pack2x3, pack3x2] })
    const errors: string[] = []
    const stage = await paperStage({
      sheet,
      motion,
      maxSize: 384,
      present: 'blit',
      onError: (e) => errors.push(e.error.message),
    })
    expect(stage).not.toBeInstanceOf(Error)
    if (stage instanceof Error || isAborted(stage)) return
    const gl = stage.surface.canvas.getContext('webgl2') as WebGL2RenderingContext | null
    expect(gl).not.toBeNull()
    if (gl === null) return
    const timer = timerFor(gl)

    const host = document.createElement('div')
    host.style.display = 'flex'
    host.style.flexWrap = 'wrap'
    host.style.width = `${96 * 4}px`
    document.body.append(host)
    const views: View[] = []
    for (let i = 0; i < 16; i++) {
      const bitmap = await silhouetteBitmap(256, 384)
      expect(bitmap).not.toBeInstanceOf(Error)
      if (bitmap instanceof Error) return
      const canvas = document.createElement('canvas')
      canvas.style.width = '96px'
      canvas.style.height = '96px'
      host.append(canvas)
      const view = await stage.mount({
        key: `g${i}`,
        src: bitmap,
        canvas,
        pin: true,
        fit: 'contain',
      })
      expect(view).not.toBeInstanceOf(Error)
      if (view instanceof Error || isAborted(view)) return
      views.push(view)
    }

    // The instruments: step callbacks (setTimeout), the slot draw, the 2D blit, the events.
    const acc: Record<string, number> = {}
    timed(motion, 'draw', acc, 'drawJsMs')
    let steps = 0
    let ends = 0
    let lastEndAt = 0
    stage.on('step', () => {
      steps += 1
    })
    stage.on('end', () => {
      ends += 1
      lastEndAt = performance.now()
    })
    const drawImage = CanvasRenderingContext2D.prototype.drawImage
    const setTimeoutOriginal = globalThis.setTimeout
    let blits = 0
    let timerCalls = 0

    const perRun: Record<string, number>[] = []
    let completed = 0
    let allCompleted = 0
    await measure('gl.e2e.fold.grid16', {
      gl,
      timer,
      profile: true,
      before: () => {
        for (const k of Object.keys(acc)) acc[k] = 0
        steps = 0
        ends = 0
        blits = 0
        timerCalls = 0
      },
      run: async () => {
        CanvasRenderingContext2D.prototype.drawImage = function patched(
          this: CanvasRenderingContext2D,
          ...args: unknown[]
        ): void {
          const t = performance.now()
          ;(drawImage as unknown as (...a: unknown[]) => void).apply(this, args)
          acc.blitJsMs = (acc.blitJsMs ?? 0) + (performance.now() - t)
          blits += 1
        } as typeof drawImage
        globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) =>
          setTimeoutOriginal(
            (...a: unknown[]) => {
              const t = performance.now()
              fn(...a)
              acc.stepJsMs = (acc.stepJsMs ?? 0) + (performance.now() - t)
              timerCalls += 1
            },
            ms,
            ...rest,
          )) as typeof setTimeout
        const t0 = performance.now()
        const report = await stage.play('flat', 'ball', { duration: 0 })
        acc.lastEndMs = lastEndAt - t0
        globalThis.setTimeout = setTimeoutOriginal
        CanvasRenderingContext2D.prototype.drawImage = drawImage
        completed = report.started.length - report.failed.length
        allCompleted = report.completed ? 1 : 0
      },
      after: () => {
        perRun.push({ ...acc, steps, ends, blits, timerCalls })
      },
      extra: () => ({
        lastEndMs: median(perRun.slice(1), 'lastEndMs'),
        stepJsMs: median(perRun.slice(1), 'stepJsMs'),
        drawJsMs: median(perRun.slice(1), 'drawJsMs'),
        blitJsMs: median(perRun.slice(1), 'blitJsMs'),
        steps: median(perRun.slice(1), 'steps'),
        blits: median(perRun.slice(1), 'blits'),
        timerCallbacks: median(perRun.slice(1), 'timerCalls'),
        stepJsPerStepMs:
          median(perRun.slice(1), 'stepJsMs') / Math.max(1, median(perRun.slice(1), 'steps')),
        completedViews: completed,
        allCompleted,
        errors: errors.length,
      }),
      note: '16 views, flat -> ball at duration 0: callMs is play() to its promise; stepJsMs sums the setTimeout step callbacks (draw + blit + events) during the run',
    })

    stage.dispose()
    host.remove()
  })
})
