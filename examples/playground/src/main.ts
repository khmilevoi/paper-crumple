import * as pc from '@paper-crumple/core'
import type { BuiltStage } from './config'
import { DEFAULT_SAMPLE_ID, SAMPLES } from './samples'
import { DEFAULT_CONFIG, buildStage } from './config'
import { mountHero } from './scene'
import { createPanel } from './panel'
import type { SetTarget } from './panel'

const line = document.getElementById('version-line')
const knobCount = document.getElementById('knob-count')

interface Live {
  readonly built: BuiltStage
  readonly view: pc.View | null
  readonly sprite: pc.Sprite | null
}

// Mutable so `onSet` below always writes against whatever is currently mounted, without the
// panel having to know about stage rebuilds or sample swaps.
let live: Live | null = null

/**
 * The one piece of routing this demo has to get right (§6.6): `stage.set` and `sprite.set` take
 * the whole invalidation ladder, `view.set` only `'draw'`. On the widest, erased `pc.View` /
 * `pc.Sprite` / stage types — the ones a consumer without the concrete slot tuples holds — even
 * the namespaced patch form does not survive a runtime string key (`stage-knobs.test.ts`'s own
 * comment: "a bare-key `set()` call below is therefore cast `as never` at the call site, same as
 * the implementation itself already does"). That cast is what makes this compile; the runtime
 * registry (`registry.normalise`) is what actually enforces the scope, and a `view.set` on a
 * `front`-class (or coarser) knob is deliberately left to fail and shown inline rather than
 * filtered out before it reaches the library.
 */
function onSet(
  key: string,
  value: string | number | boolean,
  target: SetTarget,
): Error | undefined {
  if (live === null) return new Error('playground: no stage is built yet')
  const patch = { [key]: value }
  if (target === 'stage') return live.built.stage.set(patch as never)
  if (target === 'sprite') {
    if (live.sprite === null) return new Error('playground: no sprite is mounted yet')
    return live.sprite.set(patch as never)
  }
  if (live.view === null) return new Error('playground: no view is mounted yet')
  return live.view.set(patch as never)
}

/**
 * `#knob-count`: the measured counts, not the quoted ones. `docs/USAGE.md` §7 claims 31 for
 * `hull` and 46 for `torn`; `paper-knobs.ts`'s own header records that this does not reconcile
 * with its derived composition. The number rendered here is `sheet.knobs.length` /
 * `motion.knobs.length` at runtime, measured on whatever stage is actually live.
 */
function onCount(sheet: number, motion: number): void {
  if (knobCount === null) return
  knobCount.textContent =
    `${String(sheet)} sheet + ${String(motion)} motion = ${String(sheet + motion)} knobs measured ` +
    `(edgeMode: ${DEFAULT_CONFIG.edgeMode}). docs/USAGE.md §7 quotes 31 for hull and 46 for torn; ` +
    `paper-knobs.ts's own header notes this does not reconcile with its derived composition — the ` +
    `count above is measured at runtime, not quoted.`
}

const panel = createPanel(onSet, onCount)

async function boot(): Promise<void> {
  // A duplicate core is a startup failure, not a once-per-session console warning: two copies
  // give two `GlError` classes, and `instanceof` then narrows an Error as a success value.
  const dup = pc.assertSingleCore()
  if (dup instanceof Error) {
    if (line) line.textContent = `core duplicated: ${dup.message}`
    return
  }

  const sample = SAMPLES.find((s) => s.id === DEFAULT_SAMPLE_ID)
  if (sample === undefined) {
    if (line) line.textContent = `playground: unknown default sample "${DEFAULT_SAMPLE_ID}"`
    return
  }

  const controller = new AbortController()
  const onError = (e: pc.StageEvent<'error'>): void => {
    // Task 7 replaces this with the inspector panel; for now the error surface is the console.
    console.warn('playground: stage error', e)
  }

  const built = await buildStage(DEFAULT_CONFIG, onError, controller.signal)
  if (built === pc.ABORTED) {
    if (line) line.textContent = 'playground: stage build aborted'
    return
  }
  if (built instanceof Error) {
    if (line) line.textContent = `playground: stage build failed: ${built.message}`
    return
  }

  const mounted = await mountHero(built, sample, controller.signal)
  if (mounted === pc.ABORTED) {
    if (line) line.textContent = 'playground: hero mount aborted'
    return
  }
  if (mounted instanceof Error) {
    if (line) line.textContent = `playground: hero mount failed: ${mounted.message}`
    return
  }

  live = { built, view: mounted.view, sprite: mounted.sprite }
  panel.rebuild(built, mounted.view, mounted.sprite)

  if (line)
    line.textContent =
      `core ${pc.VERSION} · ${SAMPLES.length} samples · ${pc.DWELL_MS.length} dwells · ` +
      `${built.stage.warnings.length} warnings · maxTextureSize ${built.stage.caps.maxTextureSize} · ` +
      `built in ${built.buildMs.toFixed(1)}ms`
}

void boot()
