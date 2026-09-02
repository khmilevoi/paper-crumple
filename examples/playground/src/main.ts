import * as pc from '@paper-crumple/core'
import type { BuiltStage, DemoConfig } from './config'
import { DEFAULT_SAMPLE_ID, SAMPLES } from './samples'
import { DEFAULT_CONFIG, buildStage } from './config'
import { mountGrid, mountHero, planDirectLayout } from './scene'
import { createPanel } from './panel'
import type { SetTarget } from './panel'
import { createConfigPanel } from './config-panel'
import { createTransport } from './transport'
import { createInspector } from './inspector'
import { createAudio } from './audio'
import { decodeState, emitCode, encodeState } from './state'

const line = document.getElementById('version-line')
const knobCount = document.getElementById('knob-count')
const copyCodeBtn = document.getElementById('copy-code-btn')
const emittedCodeEl = document.getElementById('emitted-code')

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

const inspector = createInspector()

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
function applyKnob(
  key: string,
  value: string | number | boolean,
  target: SetTarget,
): Error | undefined {
  if (live === null) {
    const err = new Error('playground: no stage is built yet')
    inspector.observed('onSet', err)
    return err
  }
  const patch = { [key]: value }
  if (target === 'stage') {
    const result = live.built.stage.set(patch as never)
    if (result instanceof Error) inspector.observed('stage.set', result)
    return result
  }
  if (target === 'sprite') {
    if (live.sprite === null) {
      const err = new Error('playground: no sprite is mounted yet')
      inspector.observed('onSet(sprite)', err)
      return err
    }
    const result = live.sprite.set(patch as never)
    if (result instanceof Error) inspector.observed('sprite.set', result)
    return result
  }
  if (live.view === null) {
    const err = new Error('playground: no view is mounted yet')
    inspector.observed('onSet(view)', err)
    return err
  }
  const result = live.view.set(patch as never)
  if (result instanceof Error) inspector.observed('view.set', result)
  return result
}

/**
 * Task 8's hook: every knob write (and, below, every landed rebuild) re-serializes the live
 * config + the panel's current `changed()` diff into `location.hash` via `replaceState` — no new
 * history entry per drag-frame. This is what "goes into the URL hash" means in practice: nothing
 * the reader has to opt into, the address bar is always a live share link.
 */
function syncHash(): void {
  const hash = encodeState(currentConfig, panel.changed())
  history.replaceState(null, '', hash)
}

// A dragged `range` input's native `input` event fires dozens of times per gesture (`panel.ts`
// binds `onSet` straight to it), and browsers rate-limit `history.replaceState` — Safari starts
// throwing past roughly a hundred calls in thirty seconds. The stage write below stays on every
// `input` event, because the live render dragging a slider produces is the whole point of the
// demo and must not get laggier; the hash write is throttled to at most once per animation frame,
// since nothing reads `location.hash` between frames anyway.
let hashSyncScheduled = false

function scheduleHashSync(): void {
  if (hashSyncScheduled) return
  hashSyncScheduled = true
  requestAnimationFrame(() => {
    hashSyncScheduled = false
    syncHash()
  })
}

function onSet(
  key: string,
  value: string | number | boolean,
  target: SetTarget,
): Error | undefined {
  const result = applyKnob(key, value, target)
  scheduleHashSync()
  return result
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

// Sound. It reports every load failure through the same `observed` channel every other narrowed
// Error in this demo goes through — a clean clone has no `public/audio/` at all (it is
// gitignored), and that has to read as a listed, explained absence rather than as a broken page.
// Its numbers land in the inspector's Audio section, because a sound is invisible in a
// screenshot and the schedule figures are the only objective evidence the sync is right.
const audio = createAudio(
  (where, error) => {
    inspector.observed(where, error)
  },
  () => {
    inspector.refreshAudio()
  },
)
inspector.setAudioSource(audio.rows)

const transport = createTransport(report, audio)

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
  inspector.line(text)
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

  const built = await buildStage(next, inspector.fromChannel, controller.signal)
  if (built === pc.ABORTED) return
  if (built instanceof Error) {
    inspector.observed('buildStage', built)
    report(`playground: stage build failed: ${built.message}`)
    return
  }

  inspector.attach(built, next.budgetMb * 1024 * 1024)

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
      inspector.observed('stage.resize', resized)
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
  // A hero that refuses to mount is reported and then *kept*, not disposed. The knob descriptors
  // live on the two slots (`built.sheet.knobs` / `built.motion.knobs`) and exist the moment the
  // stage is built — no sprite is involved — so the generated panel, which is the whole point of
  // this demo, must still render. `Live.view` / `Live.sprite` are already nullable for exactly
  // this case and `applyKnob` above turns a `view`- or `sprite`-targeted write against a null one
  // into an inline Error on the row rather than a crash. Returning here instead left the page
  // with a "Knobs" heading and nothing under it, which is what made a mount failure impossible to
  // explore from the page it happened on.
  const hero = mounted instanceof Error ? null : mounted
  if (mounted instanceof Error) {
    inspector.observed('mountHero', mounted)
    report(`playground: hero mount failed: ${mounted.message}`)
  }

  const grid = await mountGrid(built, SAMPLES, controller.signal, tileRects)
  if (grid === pc.ABORTED) {
    // Same reasoning as the hero above: this build never went live, so nothing else will
    // dispose it.
    built.stage.dispose()
    return
  }
  for (const f of grid.failures) inspector.observed('mountGrid', f)
  gridViews = grid.views

  currentConfig = next
  live = { built, view: hero?.view ?? null, sprite: hero?.sprite ?? null }
  panel.rebuild(built, live.view, live.sprite)
  transport.bind(built, live.view, gridViews)
  // The hero view now exists on `built.stage.views` — refresh once more so Usage's idealSize /
  // state / pose describe it rather than the pre-mount snapshot `attach` above took.
  inspector.refreshUsage()
  syncHash()

  configPanel.setStatus(
    (hero === null ? 'stage rebuilt, hero NOT mounted (see the masthead and EVENTS) · ' : '') +
      `rebuilt in ${built.buildMs.toFixed(1)} ms · ${built.stage.warnings.length} warnings · ` +
      `sheet.overscan ${built.sheet.overscan.toFixed(3)} (the factory baseline, computed once ` +
      `from this factory's default knob values before any sprite exists — a mounted sprite's own ` +
      `frozen reserve is a different number the moment an edge knob moves)`,
  )

  // Only on a mounted hero: otherwise this would overwrite the `report()` above and the masthead
  // would claim a clean build for a page showing no sprite.
  if (line && hero !== null)
    line.textContent =
      `core ${pc.VERSION} · ${SAMPLES.length} samples · ${pc.DWELL_MS.length} dwells · ` +
      `${built.stage.warnings.length} warnings · maxTextureSize ${built.stage.caps.maxTextureSize} · ` +
      `built in ${built.buildMs.toFixed(1)}ms`
}

// The URL hash a reader may have opened this page with, decoded exactly once at load. A
// malformed fragment is reported through the inspector, never thrown or console-logged — a bad
// link falls back to `DEFAULT_CONFIG` rather than producing a blank page.
const initialHashState = decodeState(location.hash)
if (initialHashState instanceof Error) inspector.observed('decodeState', initialHashState)
const initialConfig = initialHashState instanceof Error ? DEFAULT_CONFIG : initialHashState.config

const configPanel = createConfigPanel(initialConfig, (next) => void rebuild(next))

if (copyCodeBtn !== null) {
  copyCodeBtn.addEventListener('click', () => {
    const code = emitCode(currentConfig, panel.changed())
    // Render into the `<pre>` first, unconditionally — the visible fallback must work even when
    // the Clipboard API path below never runs.
    if (emittedCodeEl !== null) emittedCodeEl.textContent = code

    // `navigator.clipboard` is `undefined` outside a secure context (or in an older browser) —
    // exactly the case the `<pre>` fallback above exists for. Calling `.writeText` on `undefined`
    // throws *synchronously*, before any promise exists, so a `.catch()` chained onto the call
    // would never attach. Guard the property first and report its absence through the inspector
    // instead.
    if (navigator.clipboard === undefined) {
      inspector.observed(
        'clipboard.writeText',
        new Error(
          'playground: Clipboard API unavailable (needs a secure context) — use the pre above',
        ),
      )
      return
    }
    navigator.clipboard.writeText(code).catch((reason: unknown) => {
      const err = reason instanceof Error ? reason : new Error(String(reason))
      inspector.observed('clipboard.writeText', err)
    })
  })
}

/**
 * A share link pasted into an already-open tab changes only the fragment, and a fragment-only
 * navigation never reloads the document — so `decodeState` above, which runs exactly once at
 * module evaluation, would never see it and the page would silently keep the configuration it
 * booted with. That, and not a decode or a render fault, is why a restored configuration appeared
 * not to reach the controls: on a genuine reload it always did.
 *
 * `syncHash` writes with `history.replaceState`, which by spec does **not** fire `hashchange`, so
 * this listener only ever observes a fragment a reader (or a link) put there and cannot loop
 * against the demo's own writes.
 */
window.addEventListener('hashchange', () => {
  const next = decodeState(location.hash)
  if (next instanceof Error) {
    inspector.observed('decodeState', next)
    return
  }
  // Re-pasting the address bar unchanged should not cost a stage rebuild. Comparing the encoded
  // forms reuses `encodeState` rather than adding a second, separate notion of "same config".
  if (encodeState(next.config, next.knobs) === encodeState(currentConfig, panel.changed())) return
  // Same order as `boot()` below, and for the same reason: seeding before the rebuild leaves
  // `panel.rebuild`'s own preserved-value carry-over as the single path that writes a restored
  // knob to the live stage, including the skip for keys the new slot set no longer declares.
  panel.seed(next.knobs)
  configPanel.set(next.config)
  void rebuild(next.config)
})

async function boot(): Promise<void> {
  // A duplicate core is a startup failure, not a once-per-session console warning: two copies
  // give two `GlError` classes, and `instanceof` then narrows an Error as a success value.
  const dup = pc.assertSingleCore()
  if (dup instanceof Error) {
    inspector.observed('assertSingleCore', dup)
    if (line) line.textContent = `core duplicated: ${dup.message}`
    return
  }

  // Seed the panel's retained `values` before the first `rebuild()`, not after: `rebuild()`'s own
  // preserved-value carry-over (`panel.rebuild`'s `preserved !== k.default` branch) is what
  // actually writes a seeded value to the live stage via `onSet`, and it already skips any key
  // the new slot's descriptors don't declare — a decoded knob `edgeMode` doesn't support this way
  // is silently dropped by that existing skip rather than reaching a second, separate apply path.
  if (!(initialHashState instanceof Error)) panel.seed(initialHashState.knobs)

  await rebuild(initialConfig)
}

void boot()
