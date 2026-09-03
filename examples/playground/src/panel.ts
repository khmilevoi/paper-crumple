import * as pc from '@paper-crumple/core'
import type { KnobDescriptor, NumberKnob, IntKnob } from '@paper-crumple/core'
import { labelFor, GROUP_ORDER, tabFor } from './labels'
import type { BuiltStage } from './config'

export type KnobValues = Readonly<Record<string, string | number | boolean>>
export type SetTarget = 'stage' | 'view' | 'sprite'

export interface PanelHandle {
  readonly values: KnobValues
  /** Re-render the controls for a new stage, re-applying `values` where the key still exists. */
  rebuild(built: BuiltStage, view: pc.View | null, sprite: pc.Sprite | null): void
  /** Values that differ from their descriptor default — what "copy as code" emits. */
  changed(): KnobValues
  reset(): void
  /**
   * Merge `values` into the internal map without writing anywhere — no `onSet`, no render. For
   * seeding a restored-from-URL configuration before the first `rebuild()`: `rebuild()` is what
   * actually applies a preserved value to the live stage (and is what already skips a key the new
   * slot set doesn't declare), so seeding ahead of it reuses that path instead of adding a second
   * one beside it.
   */
  seed(values: KnobValues): void
}

/**
 * The write-back key. A `binds` descriptor is one core-owned value both slots share, and the
 * bare key is the one that addresses it; everything else is slot-local and needs its namespace,
 * or `stage.set` comes back with a `KnobError` on the two keys both slots own.
 */
function patchKey(ns: 'sheet' | 'motion', k: KnobDescriptor): string {
  return k.binds ? k.key : `${ns}.${k.key}`
}

interface Entry {
  readonly key: string
  readonly k: KnobDescriptor
}

function collectDescriptors(built: BuiltStage): Entry[] {
  const out: Entry[] = []
  for (const k of built.sheet.knobs) out.push({ key: patchKey('sheet', k), k })
  for (const k of built.motion.knobs) out.push({ key: patchKey('motion', k), k })
  return out
}

interface RowParts {
  readonly root: HTMLElement
  readonly head: HTMLElement
  readonly body: HTMLElement
}

/** Shared by all four builders: the label, the error slot, and the `data-knob-key` every builder
 *  must carry. The control itself goes into `body`; badges are attached afterwards by the render
 *  loop, which is the only place that holds the full descriptor for every kind. */
function baseRow(key: string): RowParts {
  const root = document.createElement('div')
  root.className = 'knob-row'
  root.dataset.knobKey = key

  const head = document.createElement('div')
  head.className = 'knob-head'
  const label = document.createElement('span')
  label.className = 'knob-label'
  label.textContent = labelFor(key)?.label ?? key
  head.append(label)
  root.append(head)

  const body = document.createElement('div')
  body.className = 'knob-body'
  root.append(body)

  const error = document.createElement('div')
  error.className = 'knob-error'
  error.hidden = true
  root.append(error)

  return { root, head, body }
}

/**
 * The design's custom track+fill+thumb (`.range-track-wrap` > `.range-track` > `.range-fill` +
 * `.range-thumb`), backed by a real `<input type="range">` kept for free keyboard support, pointer
 * drag and native `input` events — reimplementing drag physics on divs would be strictly more risk
 * for the same result. The native input is stacked on top of the hand-drawn track, fully
 * transparent (`.range-track-wrap input[type='range']` in styles.css), so it captures every
 * pointer/keyboard interaction while the divs underneath do the painting. `.range-number` is a
 * real editable `<input type="number">` (not a readout span) kept in sync with the range in both
 * directions; either one changing writes through the SAME path — `bindRow()` below still only ever
 * listens on `.knob-input` (the range), so a number edit re-dispatches a real `input` event on the
 * range rather than duplicating the write-back logic.
 */
function numberControl(key: string, k: NumberKnob | IntKnob, value: number): HTMLElement {
  // IntKnob declares no `step` at all — not even `undefined` — so the fallback has to be picked
  // under a `kind` narrow rather than by reading `k.step` on the unnarrowed union.
  const step = k.kind === 'number' ? (k.step ?? (k.max - k.min) / 200) : 1
  const { root, head, body } = baseRow(key)

  const range = document.createElement('input')
  range.type = 'range'
  range.className = 'knob-input'
  range.min = String(k.min)
  range.max = String(k.max)
  range.step = String(step)
  range.value = String(value)

  const number = document.createElement('input')
  number.type = 'number'
  number.className = 'range-number'
  number.min = String(k.min)
  number.max = String(k.max)
  number.step = String(step)
  number.value = String(value)
  // The row's own grid is `1fr auto` with `.range-track-wrap` pinned to `grid-column: 1 / -1`
  // (styles.css) so it always claims a full row on its own; placing the number explicitly in
  // column 2 puts it on the row *above* the track, pushed to the right edge by the empty 1fr
  // column next to it, without any extra styles.css rule.
  number.style.gridColumn = '2'

  const trackWrap = document.createElement('div')
  trackWrap.className = 'range-track-wrap'
  const track = document.createElement('div')
  track.className = 'range-track'
  const fill = document.createElement('div')
  fill.className = 'range-fill'
  const thumb = document.createElement('div')
  thumb.className = 'range-thumb'
  track.append(fill, thumb)
  trackWrap.append(track, range)

  // `baseRow()` appends `head` (label + badges, badges attached later by `attachBadges()`)
  // straight under `root` — the layout every other control kind wants. This one wants `head`
  // sharing the first grid row of `.range-row` with the number, in column 1 opposite the number's
  // column 2, so it's pulled back out of `root` and dropped in here instead. `boolControl` /
  // `colorControl` / `enumControl` still call `baseRow()` unchanged and keep `head` where it put
  // it.
  root.removeChild(head)
  head.style.gridColumn = '1'

  const row = document.createElement('div')
  row.className = 'range-row'
  row.append(head, number, trackWrap)
  body.append(row)

  const fillPct = (v: number): number => {
    const span = k.max - k.min
    const pct = span === 0 ? 0 : ((v - k.min) / span) * 100
    return Math.min(100, Math.max(0, pct))
  }
  const syncVisual = (v: number): void => {
    const pct = `${String(fillPct(v))}%`
    fill.style.width = pct
    thumb.style.left = pct
  }
  syncVisual(value)

  // Dragging/keying the (invisible) native range: mirror into the number field and repaint the
  // hand-drawn track. `bindRow()` already listens for `input` on `.knob-input` (this element), so
  // this listener only has to keep the OTHER control in sync, not write anywhere.
  range.addEventListener('input', () => {
    number.value = range.value
    syncVisual(Number(range.value))
  })

  // Editing the number field: push the value onto the range (which clamps it to min/max the same
  // way the slider itself would), read the clamped result back so the number field never shows a
  // value the slider disagrees with, repaint, then dispatch a real `input` event on the range so
  // `bindRow()`'s single listener is the only place that ever calls `onSet`. A mid-edit value like
  // a bare "-" parses to `NaN`; skip the write-back until it is a real number again rather than
  // snapping the range to some default.
  number.addEventListener('input', () => {
    if (number.value === '' || Number.isNaN(Number(number.value))) return
    range.value = number.value
    number.value = range.value
    syncVisual(Number(range.value))
    range.dispatchEvent(new Event('input', { bubbles: true }))
  })

  return root
}

function boolControl(key: string, value: boolean): HTMLElement {
  const { root, body } = baseRow(key)
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.className = 'knob-input'
  input.checked = value
  body.append(input)
  return root
}

function colorControl(key: string, value: string): HTMLElement {
  const { root, body } = baseRow(key)
  const input = document.createElement('input')
  input.type = 'color'
  input.className = 'knob-input'
  input.value = value
  body.append(input)
  return root
}

function enumControl(key: string, values: readonly string[], value: string): HTMLElement {
  const { root, body } = baseRow(key)
  const select = document.createElement('select')
  select.className = 'knob-input'
  for (const v of values) {
    const opt = document.createElement('option')
    opt.value = v
    opt.textContent = v
    opt.selected = v === value
    select.append(opt)
  }
  body.append(select)
  return root
}

/**
 * The design's chip-grid rendering of `motion.debug` specifically (the enum descriptor, six
 * channel names) — `sheet.debug` is the unrelated int descriptor (a 0-7 range) and stays a
 * `numberControl` slider, untouched. A real `<select class="knob-input">` is kept, hidden, next
 * to the chips: it is what `bindRow()` already listens to (`.knob-input` + `input`), so the chips
 * only ever move the select's value and dispatch a real `input` event on it rather than
 * duplicating `bindRow`'s write-back path. `display: none` is enough here — `bindRow()` finds it
 * by `querySelector`, which does not care whether the element is visible.
 */
function debugChipControl(key: string, values: readonly string[], value: string): HTMLElement {
  const { root, body } = baseRow(key)

  const select = document.createElement('select')
  select.className = 'knob-input'
  select.style.display = 'none'
  for (const v of values) {
    const opt = document.createElement('option')
    opt.value = v
    opt.textContent = v
    opt.selected = v === value
    select.append(opt)
  }

  const grid = document.createElement('div')
  grid.className = 'debug-chip-grid'
  const chips = new Map<string, HTMLButtonElement>()

  for (const v of values) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'debug-chip'
    chip.classList.toggle('debug-chip--active', v === value)

    const swatch = document.createElement('span')
    swatch.className = 'debug-chip-swatch'
    const label = document.createElement('span')
    label.textContent = v
    chip.append(swatch, label)

    chip.addEventListener('click', () => {
      if (select.value === v) return
      select.value = v
      select.dispatchEvent(new Event('input', { bubbles: true }))
      select.dispatchEvent(new Event('change'))
    })

    grid.append(chip)
    chips.set(v, chip)
  }

  // The write-back itself runs off the `input` event above (`bindRow()`); this `change` listener
  // only keeps the active chip in sync with the select's current value — fired from the same
  // click, and available for anything else that ever changes `select.value` directly.
  select.addEventListener('change', () => {
    for (const [v, chip] of chips) chip.classList.toggle('debug-chip--active', v === select.value)
  })

  body.append(grid, select)
  return root
}

/** `docs/USAGE.md` §7's loop, made real. `noFallthroughCasesInSwitch` is on and every arm
 *  returns, so a sixth descriptor kind added to the library is a type error here, not a control
 *  that silently fails to render. No `default:` arm — a default is exactly what would hide that
 *  future error. */
function controlFor(
  key: string,
  k: KnobDescriptor,
  current: string | number | boolean,
): HTMLElement {
  switch (k.kind) {
    case 'number':
    case 'int':
      return numberControl(key, k, Number(current))
    case 'bool':
      return boolControl(key, Boolean(current))
    case 'color':
      return colorControl(key, String(current))
    case 'enum':
      // The design's 3-column swatch-chip grid, for `motion.debug` only — every other enum knob
      // keeps the plain `<select>`.
      return key === 'motion.debug'
        ? debugChipControl(key, k.values, String(current))
        : enumControl(key, k.values, String(current))
  }
}

/** The counterpart read: pull the live value back out of whichever input `controlFor` rendered.
 *  Exhaustive for the same reason `controlFor` is. */
function readValue(
  k: KnobDescriptor,
  input: HTMLInputElement | HTMLSelectElement,
): string | number | boolean {
  switch (k.kind) {
    case 'number':
    case 'int':
      return Number((input as HTMLInputElement).value)
    case 'bool':
      return (input as HTMLInputElement).checked
    case 'color':
      return (input as HTMLInputElement).value
    case 'enum':
      return (input as HTMLSelectElement).value
  }
}

function makeBadge(text: string, kind: string): HTMLElement {
  const b = document.createElement('span')
  b.className = `knob-badge knob-badge--${kind}`
  b.textContent = text
  return b
}

/** The badge set: the `invalidates` level always, `sprite-px` on a `reference`d number knob,
 *  `no label` when the demo's own table has nothing for this key, and `dev` on a dev-only knob. */
function attachBadges(row: HTMLElement, key: string, k: KnobDescriptor): void {
  const head = row.querySelector<HTMLElement>('.knob-head')
  if (head === null) return

  const badges = document.createElement('span')
  badges.className = 'knob-badges'
  badges.append(makeBadge(k.invalidates, 'level'))

  if (k.kind === 'number' && k.reference === 'sprite-px') {
    const px = makeBadge('sprite-px', 'reference')
    px.title =
      `Quoted against a ${String(pc.KNOB_REFERENCE_PX)} px-tall sprite (pc.KNOB_REFERENCE_PX); the ` +
      'renderer rescales it to the real sprite size. Reading this number as target pixels gives a ' +
      'torn edge roughly 2.4x too coarse at 384 px.'
    badges.append(px)
  }

  if (labelFor(key) === undefined) badges.append(makeBadge('no label', 'warning'))
  if (k.dev) badges.append(makeBadge('dev', 'dev'))

  head.append(badges)
}

/** Finds the row by `data-knob-key`. Clears when the next `set()` succeeds — see `clearInlineError`
 *  below, called from the same write-back path. */
function showInlineError(key: string, error: Error): void {
  const row = document.querySelector<HTMLElement>(`#panel [data-knob-key="${key}"]`)
  if (row === null) return
  const box = row.querySelector<HTMLElement>('.knob-error')
  if (box === null) return
  box.textContent = error.message
  box.hidden = false
}

function clearInlineError(key: string): void {
  const row = document.querySelector<HTMLElement>(`#panel [data-knob-key="${key}"]`)
  if (row === null) return
  const box = row.querySelector<HTMLElement>('.knob-error')
  if (box === null) return
  box.textContent = ''
  box.hidden = true
}

/** `GROUP_ORDER` entries carry spaces and an em dash (`Silhouette — hull`); an element id needs
 *  neither, so every id derived from a group name goes through this first. */
function slugifyGroup(group: string): string {
  return group.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * The sidebar's numbering is one continuous sequence across the whole page (`index.html`'s
 * static "01 Source" / "03 Poses" / "04 Sound" sections interleaved with the tabs this module
 * generates), not a self-contained 01, 02, 3... local to `#panel`. `#panel` renders one tab per
 * `tabFor()` result (see `render()` below) and each of those tabs' number in the *global*
 * sequence is fixed regardless of the order this module happens to emit them in — "Edge" is
 * always "02", "Look & debug" is always "05", and the tabs `labels.ts` has no mapping for
 * ("Fold", "Ball", "Resolution" — `tabFor()` returns the group name unchanged when
 * `GROUP_TO_TAB` has no entry for it) continue the sequence at "06", "07", "08". This table is
 * therefore hand-maintained against `index.html`'s static numbering rather than derived from
 * `orderedTabs`'s own position — a CSS counter would silently renumber every generated tab
 * whenever `index.html`'s static section count changes, which is exactly the failure mode this
 * table exists to avoid.
 *
 * Numeric rather than the zero-padded display string ("02", not just "2"): the same value drives
 * both the `.accordion-number` text below (formatted with `padStart` at the point of use) and each
 * section's inline `order` style, which needs a real CSS integer. Keeping one numeric source and
 * formatting it once for display beats parsing a zero-padded string back into a number, or storing
 * the number twice under two keys that could drift apart.
 */
const TAB_NUMBER: ReadonlyMap<string, number> = new Map([
  ['Edge', 2],
  ['Look & debug', 5],
  ['Fold', 6],
  ['Ball', 7],
  ['Resolution', 8],
])

export function createPanel(
  onSet: (key: string, value: string | number | boolean, target: SetTarget) => Error | undefined,
  onCount: (sheet: number, motion: number) => void,
): PanelHandle {
  let target: SetTarget = 'stage'
  let showDev = false
  let currentView: pc.View | null = null
  let currentSprite: pc.Sprite | null = null
  let entries: Entry[] = []
  // Which accordion sections are open — carried across `rebuild()` (an edge-mode swap, say) so a
  // reader who collapsed "Ball" stays collapsed rather than being reset to fully-open every time
  // the stage rebuilds. `null` means "not yet initialised" (first render only); `render()` seeds
  // it to every tab open the first time it sees `null` and leaves it alone after that. The set of
  // tabs itself is effectively constant across rebuilds (every `GROUP_ORDER` group folds into one
  // of a fixed handful of tabs via `tabFor`, and "Paper & Edge" always has at least the `Paper`
  // group's entries), so a tab a reader closed keeps meaning the same section on the next rebuild
  // even though its *content* can change underneath it — "Paper & Edge" holds both
  // `Silhouette — hull` and `Silhouette — torn`'s sub-cards, and only one of the two is ever
  // populated at a time.
  let openTabs: Set<string> | null = null

  const values: Record<string, string | number | boolean> = {}
  const defaults: Record<string, string | number | boolean> = {}

  function bindRow(row: HTMLElement, key: string, k: KnobDescriptor): void {
    const input = row.querySelector<HTMLInputElement | HTMLSelectElement>('.knob-input')
    if (input === null) return
    input.addEventListener('input', () => {
      const value = readValue(k, input)
      values[key] = value
      const err = onSet(key, value, target)
      if (err) showInlineError(key, err)
      else clearInlineError(key)
    })
  }

  function render(): void {
    const panelRoot = document.getElementById('panel')
    if (panelRoot === null) return
    panelRoot.replaceChildren()

    const controls = document.createElement('div')
    controls.className = 'knob-controls'

    // The three-way write-back target. `sprite` and `view` are disabled until a sprite/view
    // actually exists to write to.
    const targetFieldset = document.createElement('fieldset')
    targetFieldset.className = 'knob-target'
    const legend = document.createElement('legend')
    legend.textContent = 'write to'
    targetFieldset.append(legend)
    const targets: readonly SetTarget[] = ['stage', 'sprite', 'view']
    for (const t of targets) {
      const wrap = document.createElement('label')
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'knob-target'
      radio.value = t
      radio.checked = target === t
      radio.disabled =
        (t === 'sprite' && currentSprite === null) || (t === 'view' && currentView === null)
      radio.addEventListener('change', () => {
        if (radio.checked) target = t
      })
      wrap.append(radio, document.createTextNode(` ${t}`))
      targetFieldset.append(wrap)
    }
    controls.append(targetFieldset)

    const devLabel = document.createElement('label')
    devLabel.className = 'knob-dev-toggle'
    const devCheckbox = document.createElement('input')
    devCheckbox.type = 'checkbox'
    devCheckbox.checked = showDev
    devCheckbox.addEventListener('change', () => {
      showDev = devCheckbox.checked
      panelRoot.querySelectorAll<HTMLElement>('[data-knob-dev="true"]').forEach((r) => {
        r.hidden = !showDev
      })
    })
    devLabel.append(devCheckbox, document.createTextNode(' show dev knobs'))
    controls.append(devLabel)

    panelRoot.append(controls)

    // Group by `labelFor(key)?.group`, ordered by `GROUP_ORDER`; unlabelled descriptors go into a
    // final `Unlabelled` group so they are impossible to miss. This is the demo's existing knob
    // taxonomy (`labels.ts`) — tabs below are one per group that actually has entries on the live
    // stage, not a new grouping invented for the layout. A hull-mode build, for instance, never
    // populates "Silhouette — torn", so that tab simply does not appear.
    const groups = new Map<string, Entry[]>()
    for (const entry of entries) {
      const group = labelFor(entry.key)?.group ?? 'Unlabelled'
      const list = groups.get(group)
      if (list) list.push(entry)
      else groups.set(group, [entry])
    }
    const orderedGroups = [...GROUP_ORDER, 'Unlabelled'].filter((g) => groups.has(g))

    // A tab is one per *tab group* (`tabFor`), not one per `labels.ts` group — see `tabFor`'s own
    // comment. `orderedTabs` is built by first encounter while walking `orderedGroups`, so it
    // inherits `GROUP_ORDER`'s sequence for free instead of needing a second ordering table that
    // could drift from it.
    const orderedTabs: string[] = []
    const tabMembers = new Map<string, string[]>()
    for (const group of orderedGroups) {
      const tab = tabFor(group)
      const members = tabMembers.get(tab)
      if (members) members.push(group)
      else {
        tabMembers.set(tab, [group])
        orderedTabs.push(tab)
      }
    }

    // `controls` (the "write to" / "show dev knobs" row) has no `TAB_NUMBER` entry of its own —
    // it isn't a numbered section — but `#panel { display: contents }` (styles.css) makes it a
    // flex item of `#sidebar` just like every numbered section, so leaving its `order` at the
    // unset default (0) would float it above even "01 Source". Instead it ties with whichever
    // tab sorts first and, since flex breaks ties by document order and this element is appended
    // before any tab section, that tie always resolves in its favour — it lands immediately
    // before the first knob tab, same as its original DOM position.
    const firstTabOrder = Math.min(99, ...orderedTabs.map((tab) => TAB_NUMBER.get(tab) ?? 99))
    controls.style.order = String(firstTabOrder)

    // First render only: every section starts open. After that `openTabs` is whatever the reader
    // last left it at (see the declaration above) — the set of tabs is stable across rebuilds, so
    // there is nothing here to reconcile against a changed tab list.
    if (openTabs === null) openTabs = new Set(orderedTabs)
    const sectionsOpen = openTabs

    const accordion = document.createElement('div')
    accordion.className = 'knob-accordion'

    orderedTabs.forEach((tab) => {
      const members = tabMembers.get(tab)
      if (members === undefined) return
      const count = members.reduce((sum, group) => sum + (groups.get(group)?.length ?? 0), 0)

      const slug = slugifyGroup(tab)
      const headerId = `knob-tab-${slug}`
      const bodyId = `knob-panel-${slug}`

      const section = document.createElement('div')
      section.className = 'accordion-section'
      // Visual position across the WHOLE sidebar, not just within `#panel`: `#panel { display:
      // contents }` (styles.css) promotes this section to a flex item of `#sidebar` directly, so
      // this `order` is compared against the inline `order` on `index.html`'s static sections —
      // together they put every numbered section in 01..09 order regardless of DOM position.
      const tabNumber = TAB_NUMBER.get(tab)
      section.style.order = String(tabNumber ?? 99)

      const header = document.createElement('button')
      header.type = 'button'
      header.className = 'accordion-header'
      header.id = headerId
      header.setAttribute('aria-controls', bodyId)

      // Numbered like the sidebar's own `.accordion-number` cards, continuing the SAME global
      // sequence `index.html`'s static sections use ("01 Source", "02" here, "03 Poses", "04
      // Sound", "05" here, "06"+ here) — see `TAB_NUMBER`'s comment above for why this can't be
      // derived from `index` in `orderedTabs`.
      const number = document.createElement('span')
      number.className = 'accordion-number'
      number.textContent = tabNumber === undefined ? '0?' : String(tabNumber).padStart(2, '0')

      const title = document.createElement('span')
      title.className = 'accordion-title'
      title.textContent = tab

      const summary = document.createElement('span')
      summary.className = 'accordion-summary'
      summary.textContent = `${String(count)} knob${count === 1 ? '' : 's'}`

      const chevron = document.createElement('span')
      chevron.className = 'accordion-chevron'
      chevron.setAttribute('aria-hidden', 'true')
      chevron.textContent = '⌄'

      header.append(number, title, summary, chevron)

      const body = document.createElement('div')
      body.className = 'accordion-body'
      body.id = bodyId
      body.setAttribute('aria-labelledby', headerId)
      body.hidden = !sectionsOpen.has(tab)
      header.setAttribute('aria-expanded', String(!body.hidden))

      // A section's own open/closed state — independent of every other section, unlike the old
      // tabs' exclusive selection. No re-render (that would drop in-progress focus and, for a
      // `range` input mid-drag, its pointer capture); a `<button>` gets Enter/Space for free, so
      // there is no keydown handler to write here the way the old roving-tabindex tablist needed.
      header.addEventListener('click', () => {
        const nowOpen = body.hidden
        body.hidden = !nowOpen
        header.setAttribute('aria-expanded', String(nowOpen))
        if (nowOpen) sectionsOpen.add(tab)
        else sectionsOpen.delete(tab)
      })

      // A tab spanning more than one `labels.ts` group renders each as its own bordered sub-card
      // (`.knob-subcard`) — the design's "Hull knobs"/"Torn knobs"/"Shared" pattern, generalised to
      // whatever groups actually share this tab. A tab with exactly one member has nothing to
      // separate from and renders flat, same as before this table existed.
      const multiMember = members.length > 1

      for (const group of members) {
        const list = groups.get(group)
        if (list === undefined) continue
        list.sort((a, b) => (labelFor(a.key)?.order ?? 0) - (labelFor(b.key)?.order ?? 0))

        let target: HTMLElement = body
        if (multiMember) {
          target = document.createElement('div')
          target.className = 'knob-subcard'
          const head = document.createElement('div')
          head.className = 'knob-subcard-head'
          head.textContent = group
          target.append(head)
          body.append(target)
        }

        for (const { key, k } of list) {
          const row = controlFor(key, k, values[key] ?? k.default)
          attachBadges(row, key, k)
          if (k.dev) {
            row.dataset.knobDev = 'true'
            row.hidden = !showDev
          }
          bindRow(row, key, k)
          target.append(row)
        }
      }

      section.append(header, body)
      accordion.append(section)
    })

    panelRoot.append(accordion)
  }

  function rebuild(built: BuiltStage, view: pc.View | null, sprite: pc.Sprite | null): void {
    currentView = view
    currentSprite = sprite
    if (target === 'sprite' && sprite === null) target = 'stage'
    if (target === 'view' && view === null) target = 'stage'

    entries = collectDescriptors(built)

    const nextValues: Record<string, string | number | boolean> = {}
    const nextDefaults: Record<string, string | number | boolean> = {}
    const pending: Array<{ key: string; error: Error }> = []

    for (const { key, k } of entries) {
      nextDefaults[key] = k.default
      const preserved = Object.hasOwn(values, key) ? values[key] : undefined
      if (preserved !== undefined && preserved !== k.default) {
        nextValues[key] = preserved
        const err = onSet(key, preserved, target)
        if (err) pending.push({ key, error: err })
      } else {
        nextValues[key] = k.default
      }
    }

    for (const key of Object.keys(values)) delete values[key]
    Object.assign(values, nextValues)
    for (const key of Object.keys(defaults)) delete defaults[key]
    Object.assign(defaults, nextDefaults)

    render()
    for (const { key, error } of pending) showInlineError(key, error)
    onCount(built.sheet.knobs.length, built.motion.knobs.length)
  }

  function changed(): KnobValues {
    const out: Record<string, string | number | boolean> = {}
    for (const key of Object.keys(values)) {
      if (values[key] !== defaults[key]) out[key] = values[key]
    }
    return out
  }

  function reset(): void {
    const pending: Array<{ key: string; error: Error }> = []
    for (const key of Object.keys(values)) {
      const def = defaults[key]
      if (def === undefined) continue
      values[key] = def
      const err = onSet(key, def, target)
      if (err) pending.push({ key, error: err })
    }
    render()
    for (const { key, error } of pending) showInlineError(key, error)
  }

  function seed(next: KnobValues): void {
    Object.assign(values, next)
  }

  return {
    get values(): KnobValues {
      return { ...values }
    },
    rebuild,
    changed,
    reset,
    seed,
  }
}
