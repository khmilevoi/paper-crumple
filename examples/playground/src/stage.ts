/**
 * What is left of the playground's own stage code after the React migration.
 *
 * The hero's canvas, view, framing and first `show()` are `useCrumple`'s and `<Crumple>`'s now
 * (`hero.ts`). What stays here is the two things that were never the hero's: the idle prefetch of
 * the other samples, and the raw WebGL probe the diagnostics footer prints.
 *
 * The prefetch reaches the stage through `scene.stage`. Its scheduled and active target keys are
 * published to the playground so a source request for one of those keys waits at the control
 * boundary until the raw-stage add has settled.
 */

import * as pc from '@paper-crumple/core'
import type { BuiltStage } from './config'
import { SAMPLES, type Sample } from './samples'

/**
 * How long the fallback waits when the browser has no `requestIdleCallback` (Safari shipped it
 * only in 18.4). Long enough that the hero's first frames are on screen before a prefetch takes
 * the lane, short enough to be finished before a reader has read the swap panel.
 */
const PREFETCH_IDLE_FALLBACK_MS = 200

/** `requestIdleCallback`, or a timeout where the browser has none. */
function atIdle(fn: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(
      () => {
        fn()
      },
      { timeout: PREFETCH_IDLE_FALLBACK_MS },
    )
    return
  }
  globalThis.setTimeout(fn, PREFETCH_IDLE_FALLBACK_MS)
}

export type PrefetchTargetsListener = (stage: pc.BlitStage, targets: ReadonlySet<string>) => void

/**
 * Warm the other five samples into the stage once the hero is up, so that clicking "swap" costs a
 * fold and nothing else.
 *
 * `stage.add()` enters the ingest lane in its **background** class (spec §8.10, `stage.ts`'s
 * `add` → `addAs(…, 'background')`), so these never run ahead of a front a shown view needs, and
 * the lane yields to the platform scheduler between a job's phases — five ingests in the
 * background do not become one long task. A landed prefetch is a cache hit. A key whose prefetch
 * is only scheduled or still in flight must not reach `view.swapTo(url)`: the raw add and React
 * binding have separate acquisition registries, so a second add would meet the first key
 * reservation and roll back. App gates only that target until this function publishes its release.
 *
 * Keyed on `sample.id`, the same key `useHero` uses, and the mounted sample is skipped: `add()`
 * on a live key is refused by design (§4.1) and would only fill the status pill.
 *
 * A target gate is dropped the moment its add settles: from there `stage.get(id)` is the truth —
 * the sprite (whose front the LRU may drop and `crumpleTo` rebuilds), or nothing for an add that
 * failed, which lets the next real request report its own outcome.
 */
export function prefetchSamples(
  built: BuiltStage,
  mounted: Sample,
  signal: AbortSignal,
  onTargets: PrefetchTargetsListener,
): void {
  const rest = SAMPLES.filter((s) => s.id !== mounted.id)
  const targets = new Set(rest.map((sample) => sample.id))
  const publish = (): void => {
    onTargets(built.stage, new Set(targets))
  }
  publish()
  if (rest.length === 0) return
  atIdle(() => {
    // The stage is disposed on unmount, and a disposed stage answers an Error rather than the
    // `ABORTED` the signal check further in would give; asking the signal first keeps a
    // torn-down build silent.
    if (signal.aborted) return
    for (const sample of rest) {
      const add = built.stage.add(sample.src, { key: sample.id, signal })
      void add.then(() => {
        targets.delete(sample.id)
        if (!signal.aborted) publish()
      })
    }
  })
}

/**
 * The renderer string the design's diagnostics footer prints.
 *
 * `getContext('webgl2')` on a canvas that already has a WebGL2 context returns that same context
 * — it does not create a second one — so this reads the live stage's own driver rather than
 * standing up a throwaway context to ask. `WEBGL_debug_renderer_info` is absent in browsers that
 * mask it, and the unmasked string is the whole point of the line, so its absence is said out
 * loud instead of being papered over with the masked generic value.
 */
export function glInfo(built: BuiltStage): string {
  const canvas: unknown = built.stage.surface.canvas
  const gl =
    canvas instanceof HTMLCanvasElement
      ? canvas.getContext('webgl2')
      : canvas instanceof OffscreenCanvas
        ? canvas.getContext('webgl2')
        : null
  if (gl === null) return 'renderer unavailable — no WebGL2 context on the surface'
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  if (ext === null) return 'renderer masked by the browser (WEBGL_debug_renderer_info withheld)'
  const renderer: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
  return typeof renderer === 'string' ? renderer : 'renderer unavailable'
}
