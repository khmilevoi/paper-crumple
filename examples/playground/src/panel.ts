import * as pc from '@paper-crumple/core'
import type { KnobDescriptor, NumberKnob, IntKnob } from '@paper-crumple/core'
import { labelFor, GROUP_ORDER } from './labels'
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

function numberControl(key: string, k: NumberKnob | IntKnob, value: number): HTMLElement {
  // IntKnob declares no `step` at all — not even `undefined` — so the fallback has to be picked
  // under a `kind` narrow rather than by reading `k.step` on the unnarrowed union.
  const step = k.kind === 'number' ? (k.step ?? (k.max - k.min) / 200) : 1
  const { root, body } = baseRow(key)

  const range = document.createElement('input')
  range.type = 'range'
  range.className = 'knob-input'
  range.min = String(k.min)
  range.max = String(k.max)
  range.step = String(step)
  range.value = String(value)

  const readout = document.createElement('span')
  readout.className = 'knob-readout'
  readout.textContent = String(value)
  range.addEventListener('input', () => {
    readout.textContent = range.value
  })

  body.append(range, readout)
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
      return enumControl(key, k.values, String(current))
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

export function createPanel(
  onSet: (key: string, value: string | number | boolean, target: SetTarget) => Error | undefined,
  onCount: (sheet: number, motion: number) => void,
): PanelHandle {
  let target: SetTarget = 'stage'
  let showDev = false
  let currentView: pc.View | null = null
  let currentSprite: pc.Sprite | null = null
  let entries: Entry[] = []

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
    // final `Unlabelled` group so they are impossible to miss.
    const groups = new Map<string, Entry[]>()
    for (const entry of entries) {
      const group = labelFor(entry.key)?.group ?? 'Unlabelled'
      const list = groups.get(group)
      if (list) list.push(entry)
      else groups.set(group, [entry])
    }

    for (const group of [...GROUP_ORDER, 'Unlabelled']) {
      const list = groups.get(group)
      if (list === undefined) continue
      list.sort((a, b) => (labelFor(a.key)?.order ?? 0) - (labelFor(b.key)?.order ?? 0))

      const details = document.createElement('details')
      details.open = true
      const summary = document.createElement('summary')
      summary.textContent = `${group} (${String(list.length)})`
      details.append(summary)

      for (const { key, k } of list) {
        const row = controlFor(key, k, values[key] ?? k.default)
        attachBadges(row, key, k)
        if (k.dev) {
          row.dataset.knobDev = 'true'
          row.hidden = !showDev
        }
        bindRow(row, key, k)
        details.append(row)
      }
      panelRoot.append(details)
    }
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

  return {
    get values(): KnobValues {
      return { ...values }
    },
    rebuild,
    changed,
    reset,
  }
}
