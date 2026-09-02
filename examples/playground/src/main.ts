import * as pc from '@paper-crumple/core'
import type { BuiltStage, DemoConfig } from './config'
import { DEFAULT_SAMPLE_ID, SAMPLES } from './samples'
import { DEFAULT_CONFIG, buildStage } from './config'
import { mountGrid, mountHero, planDirectLayout } from './scene'
import { createPanel } from './panel'
import type { SetTarget } from './panel'
import { createConfigPanel } from './config-panel'
import { createTransport } from './transport'

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

// The demo's own factory-option state — updated only once a rebuild actually lands (never
// optimistically from the config panel's in-progress edit), so `onCount` below always describes
// the stage that is actually live rather than the one a reader is still dragging a slider toward.
let currentConfig: DemoConfig = DEFAULT_CONFIG

const sample = SAMPLES.find((s) => s.id === DEFAULT_SAMPLE_ID)

function onError(e: pc.StageEvent<'error'>): void {
  // Task 7 replaces this with the inspector panel; for now the error surface is the console.
  console.warn('playground: stage error', e)
}

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
    `(edgeMode: ${currentConfig.edgeMode}). docs/USAGE.md §7 quotes 31 for hull and 46 for torn; ` +
    `paper-knobs.ts's own header notes this does not reconcile with its derived composition — the ` +
    `count above is measured at runtime, not quoted.`
}

const panel = createPanel(onSet, onCount)
const transport = createTransport(report)

// The grid's mounted views, kept so a rebuild's `transport.bind` always describes the stage that
// is actually live — mirroring `live` above for the same reason.
let gridViews: Map<string, pc.View> = new Map()

// One `AbortController` per build, owned here (task 5 brief's rebuild sequence). A config change
// aborts whatever build is in flight, disposes the currently-live stage — idempotent, and after
// it every method returns a `GlError` — builds the next one, re-mounts the hero, and re-applies
// the panel's retained knob values by way of `panel.rebuild`, which already skips every key the
// new slot set no longer declares (its own loop only ever walks the *new* stage's descriptors, so
// a key `torn` had and `hull` doesn't simply never comes up). A rebuild is not a reset.
let buildController: AbortController | null = null

function report(text: string): void {
  if (line) line.textContent = text
  configPanel.setStatus(text)
  transport.setStatus(text)
}

async function rebuild(next: DemoConfig): Promise<void> {
  buildController?.abort()
  const controller = new AbortController()
  buildController = controller

  live?.built.stage.dispose()
  live = null

  if (sample === undefined) {
    report(`playground: unknown default sample "${DEFAULT_SAMPLE_ID}"`)
    return
  }

  const built = await buildStage(next, onError, controller.signal)
  if (built === pc.ABORTED) return
  if (built instanceof Error) {
    report(`playground: stage build failed: ${built.message}`)
    return
  }

  // `direct` mode's surface must be sized to its final layout — the hero's rect and all six tile
  // rects — before any view is created: a view's rect is resolved once, at `stage.view()`, and
  // never recomputed, so resizing after the hero exists would leave its rect stale while the
  // surface (and, under a bottom-left-origin WebGL buffer, where that rect actually paints) moves
  // out from under it. `resize()` may shrink as well as grow — unlike the monotonic `grow()` — but
  // that is harmless here: this stage is fresh and nothing has been drawn against it yet.
  let heroRect: pc.Rect | undefined
  let tileRects: readonly pc.Rect[] | undefined
  if (built.present === 'direct') {
    const layout = planDirectLayout(built.stage.surface.width, SAMPLES.length)
    const resized = built.stage.resize(layout.surfaceW, layout.surfaceH)
    if (resized instanceof Error) {
      built.stage.dispose()
      report(`playground: direct surface layout failed: ${resized.message}`)
      return
    }
    heroRect = layout.heroRect
    tileRects = layout.tileRects
  }

  const mounted = await mountHero(built, sample, controller.signal, heroRect)
  if (mounted === pc.ABORTED) {
    // The build itself landed but never went live — nothing else will ever dispose it.
    built.stage.dispose()
    return
  }
  if (mounted instanceof Error) {
    built.stage.dispose()
    report(`playground: hero mount failed: ${mounted.message}`)
    return
  }

  const grid = await mountGrid(built, SAMPLES, controller.signal, tileRects)
  if (grid === pc.ABORTED) {
    // Same reasoning as the hero above: this build never went live, so nothing else will
    // dispose it.
    built.stage.dispose()
    return
  }
  for (const f of grid.failures) console.warn('playground: grid mount failure', f)
  gridViews = grid.views

  currentConfig = next
  live = { built, view: mounted.view, sprite: mounted.sprite }
  panel.rebuild(built, mounted.view, mounted.sprite)
  transport.bind(built, mounted.view, gridViews)

  configPanel.setStatus(
    `rebuilt in ${built.buildMs.toFixed(1)} ms · ${built.stage.warnings.length} warnings · ` +
      `sheet.overscan ${built.sheet.overscan.toFixed(3)} (the factory baseline, computed once ` +
      `from this factory's default knob values before any sprite exists — a mounted sprite's own ` +
      `frozen reserve is a different number the moment an edge knob moves)`,
  )

  if (line)
    line.textContent =
      `core ${pc.VERSION} · ${SAMPLES.length} samples · ${pc.DWELL_MS.length} dwells · ` +
      `${built.stage.warnings.length} warnings · maxTextureSize ${built.stage.caps.maxTextureSize} · ` +
      `built in ${built.buildMs.toFixed(1)}ms`
}

const configPanel = createConfigPanel(DEFAULT_CONFIG, (next) => void rebuild(next))

async function boot(): Promise<void> {
  // A duplicate core is a startup failure, not a once-per-session console warning: two copies
  // give two `GlError` classes, and `instanceof` then narrows an Error as a success value.
  const dup = pc.assertSingleCore()
  if (dup instanceof Error) {
    if (line) line.textContent = `core duplicated: ${dup.message}`
    return
  }

  await rebuild(DEFAULT_CONFIG)
}

void boot()
