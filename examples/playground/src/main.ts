import * as pc from '@paper-crumple/core'
import type { BuiltStage, DemoConfig } from './config'
import { DEFAULT_SAMPLE_ID, SAMPLES } from './samples'
import { DEFAULT_CONFIG, buildStage } from './config'
import { mountGrid, mountHero, planDirectLayout } from './scene'
import { createPanel } from './panel'
import type { SetTarget } from './panel'
import { createConfigPanel } from './config-panel'
import { createTransport } from './transport'
import { createPoseEditor } from './poses'
import { createStageBackground } from './stage-bg'
import { createInspector } from './inspector'
import { createAudio } from './audio'
import { decodeState, emitCode, encodeState } from './state'

const line = document.getElementById('version-line')
const knobCount = document.getElementById('knob-count')
const copyCodeBtn = document.getElementById('copy-code-btn')
const emittedCodeEl = document.getElementById('emitted-code')
const statusPill = document.getElementById('status-pill')
const statusPillText = statusPill?.querySelector<HTMLElement>('.masthead-status-text') ?? null
const headerChip = document.getElementById('header-chip')
const resetBtn = document.getElementById('reset-btn')

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

// A pure visual dev aid, independent of any stage/sample state — wired once, up front.
createStageBackground()

// Sidebar accordion toggle: the static `.accordion-header` buttons index.html always has at
// parse time (Source / Poses / Sound / Share — "Edge" / "Look & debug" / "Fold" / "Ball" /
// "Resolution" are `panel.ts`'s own generated sections and wire their own click handlers), never
// re-created — so this wires them once at module load rather than via delegation. All four start
// open (no `hidden` in the markup), matching the current layout.
document.querySelectorAll<HTMLButtonElement>('.accordion-header').forEach((header) => {
  const body = header.nextElementSibling
  if (!(body instanceof HTMLElement)) return
  header.addEventListener('click', () => {
    body.hidden = !body.hidden
    header.classList.toggle('accordion-header--collapsed', body.hidden)
  })
})

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
  setStatusPill(!(result instanceof Error), result instanceof Error ? result.message : `${key} set`)
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

// "03 Poses" accordion: mounts itself into `#poses-editor`. `bind()` below runs after `mountHero`
// so the pack it reads (`built.motion.packs()[0]`) is already resident, exactly as `transport.bind`
// and `panel.rebuild` are timed against the same rebuild.
const poses = createPoseEditor(report)

// `createTransport` above mounts `audio.element` into `#transport` (it appends it there itself,
// see `transport.ts`'s own comment on that line) — sidebar section "04 Sound" wants it as its own
// numbered accordion body instead. `appendChild` on an already-mounted element moves it rather
// than cloning it, so this is a relocation, not a re-mount: no listener `audio.ts` attached to it
// is lost.
document.getElementById('sound-section')?.append(audio.element)

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

/**
 * Masthead chips (`#version-line`, `.masthead-status-text`) are one-line UI, not a diagnostic
 * readout — but every caller below builds its message as a full sentence, often with a
 * parenthetical aside tacked on for the accordion sections' own status lines (which *do* have
 * room for it). This is the one place that gap gets closed: strip a trailing `(...)` aside first
 * (that is where the long explanations live), then hard-cap what's left. The untouched `text` is
 * still set as a `title`, so the full message stays one hover away.
 */
function shortStatus(text: string, maxLen = 64): string {
  const parenIdx = text.indexOf('(')
  const withoutAside = parenIdx >= 0 ? text.slice(0, parenIdx) : text
  const trimmed = withoutAside.replace(/[\s·—-]+$/u, '')
  if (trimmed.length <= maxLen) return trimmed
  const cut = trimmed.slice(0, maxLen)
  const lastSpace = cut.lastIndexOf(' ')
  const boundary = lastSpace > maxLen / 2 ? lastSpace : maxLen
  return `${cut.slice(0, boundary).trimEnd()}…`
}

/**
 * `#status-pill`: the one place `ok`/`bad` gets painted onto the masthead dot. Shared between
 * `report()` (every rebuild-path message already carries its own ok/bad) and `onSet` below (a
 * knob write's success/failure, which never goes through `report()` at all).
 */
function setStatusPill(ok: boolean, text: string): void {
  if (statusPill !== null) {
    statusPill.hidden = false
    statusPill.classList.toggle('masthead-status--ok', ok)
    statusPill.classList.toggle('masthead-status--bad', !ok)
  }
  if (statusPillText !== null) {
    statusPillText.textContent = shortStatus(text)
    statusPillText.title = text
  }
}

function report(text: string, ok = true): void {
  if (line) {
    line.textContent = shortStatus(text)
    line.title = text
  }
  configPanel.setStatus(text)
  transport.setStatus(text)
  inspector.line(text)
  setStatusPill(ok, text)
}

async function rebuild(next: DemoConfig): Promise<void> {
  buildController?.abort()
  const controller = new AbortController()
  buildController = controller

  live?.built.stage.dispose()
  live = null

  if (sample === undefined) {
    report(`playground: unknown default sample "${DEFAULT_SAMPLE_ID}"`, false)
    return
  }

  const built = await buildStage(next, inspector.fromChannel, controller.signal)
  if (built === pc.ABORTED) return
  if (built instanceof Error) {
    inspector.observed('buildStage', built)
    report(`playground: stage build failed: ${built.message}`, false)
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
      report(`playground: direct surface layout failed: ${resized.message}`, false)
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
    report(`playground: hero mount failed: ${mounted.message}`, false)
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
  // After `transport.bind`, same reasoning: the pack the editor reads off `built.motion` is only
  // resident once `mountHero` above has landed, and a rebuild's fresh `bakedMotion()` has no
  // override — `poses.bind` re-applies whatever draft the reader was already editing to it.
  poses.bind(built, live.view, gridViews)
  // The hero view now exists on `built.stage.views` — refresh once more so Usage's idealSize /
  // state / pose describe it rather than the pre-mount snapshot `attach` above took.
  inspector.refreshUsage()
  syncHash()

  if (headerChip !== null) {
    const knobTotal = built.sheet.knobs.length + built.motion.knobs.length
    headerChip.textContent = `${String(knobTotal)} knobs · ${built.buildMs.toFixed(1)} ms`
    headerChip.hidden = false
  }

  report(
    (hero === null ? 'stage rebuilt, hero NOT mounted (see the masthead and EVENTS) · ' : '') +
      `rebuilt in ${built.buildMs.toFixed(1)} ms · ${built.stage.warnings.length} warnings · ` +
      `sheet.overscan ${built.sheet.overscan.toFixed(3)} (the factory baseline, computed once ` +
      `from this factory's default knob values before any sprite exists — a mounted sprite's own ` +
      `frozen reserve is a different number the moment an edge knob moves)`,
    hero !== null,
  )

  // Only on a mounted hero: otherwise this would overwrite the `report()` above and the masthead
  // would claim a clean build for a page showing no sprite.
  if (line && hero !== null) {
    const mountedLine =
      `core ${pc.VERSION} · ${SAMPLES.length} samples · ${pc.DWELL_MS.length} dwells · ` +
      `${built.stage.warnings.length} warnings · maxTextureSize ${built.stage.caps.maxTextureSize} · ` +
      `built in ${built.buildMs.toFixed(1)}ms`
    line.textContent = mountedLine
    // The `report()` call above already set `line.title` to its own (longer) message; this
    // overwrite replaces the visible text but not, unless refreshed here, the tooltip — leaving a
    // hover showing a diagnostic paragraph that no longer matches what's on screen.
    line.title = mountedLine
  }
}

// The URL hash a reader may have opened this page with, decoded exactly once at load. A
// malformed fragment is reported through the inspector, never thrown or console-logged — a bad
// link falls back to `DEFAULT_CONFIG` rather than producing a blank page.
const initialHashState = decodeState(location.hash)
if (initialHashState instanceof Error) inspector.observed('decodeState', initialHashState)
const initialConfig = initialHashState instanceof Error ? DEFAULT_CONFIG : initialHashState.config

const configPanel = createConfigPanel(initialConfig, (next) => void rebuild(next))

// Reset: factory options first (`configPanel.set` + the rebuild it drives), then `panel.reset()`
// once that rebuild has actually landed. `rebuild()`'s own `panel.rebuild` call carries forward
// any knob the reader dragged away from its default whenever the new stage's descriptor set still
// declares that key (its preserved-value carry-over, by design — a rebuild is not a reset). Firing
// `panel.reset()` synchronously here would race that carry-over, since `rebuild` is async and its
// `panel.rebuild` call hasn't run yet; chaining it onto the returned promise instead lets it run
// against the freshly rendered controls and snap every one of them back to its default.
if (resetBtn !== null) {
  resetBtn.hidden = false
  resetBtn.addEventListener('click', () => {
    configPanel.set(DEFAULT_CONFIG)
    void rebuild(DEFAULT_CONFIG).then(() => {
      panel.reset()
    })
  })
}

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
    const message = `core duplicated: ${dup.message}`
    if (line) {
      line.textContent = shortStatus(message)
      line.title = message
    }
    setStatusPill(false, message)
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
