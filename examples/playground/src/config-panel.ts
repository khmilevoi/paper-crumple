import type { BucketName, DemoConfig, PresentMode } from './config'
import { BUCKET_NAMES } from './config'

const CONFIG_ROOT_ID = 'config'

interface RowParts {
  readonly root: HTMLElement
  readonly body: HTMLElement
}

/**
 * One row: a heading and the control(s) `body` holds. The explanatory note the brief's Step 1
 * table asks for is attached as the heading's `title` — a native hover tooltip — rather than
 * rendered inline, so a reader sees *why* the control exists without every row paying for a
 * permanently visible paragraph.
 */
function row(label: string, note: string): RowParts {
  const root = document.createElement('div')
  root.className = 'config-row'

  const head = document.createElement('div')
  head.className = 'config-head'
  head.textContent = label
  head.title = note
  root.append(head)

  const body = document.createElement('div')
  body.className = 'config-body'
  root.append(body)

  return { root, body }
}

function radioRow<T extends string>(
  name: string,
  label: string,
  note: string,
  options: readonly T[],
  value: T,
  onPick: (v: T) => void,
): HTMLElement {
  const { root, body } = row(label, note)
  const group = document.createElement('div')
  group.className = 'segmented'
  group.id = name
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', label)
  for (const opt of options) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'segmented-btn'
    btn.textContent = opt
    btn.setAttribute('role', 'radio')
    btn.setAttribute('aria-checked', String(opt === value))
    if (opt === value) btn.classList.add('segmented-btn--active')
    btn.addEventListener('click', () => onPick(opt))
    group.append(btn)
  }
  body.append(group)
  return root
}

function boolRow(
  label: string,
  note: string,
  value: boolean,
  onPick: (v: boolean) => void,
): HTMLElement {
  const { root, body } = row(label, note)
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = value
  input.addEventListener('change', () => onPick(input.checked))
  body.append(input)
  return root
}

/**
 * Three checkboxes, one per `BUCKET_NAMES` entry. A checked-on click reinserts the bucket in
 * `BUCKET_NAMES` order rather than appending it, so `packs` never drifts from the canonical order
 * `config.ts`'s `PACKS` record was built against.
 */
function packsRow(
  note: string,
  value: readonly BucketName[],
  onPick: (next: readonly BucketName[]) => void,
): HTMLElement {
  const { root, body } = row('packs', note)
  const group = document.createElement('div')
  group.className = 'segmented'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'packs')
  for (const name of BUCKET_NAMES) {
    const active = value.includes(name)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'segmented-btn'
    btn.textContent = name
    btn.setAttribute('aria-pressed', String(active))
    if (active) btn.classList.add('segmented-btn--active')
    btn.addEventListener('click', () => {
      const next = active
        ? value.filter((b) => b !== name)
        : BUCKET_NAMES.filter((b) => value.includes(b) || b === name)
      onPick(next)
    })
    group.append(btn)
  }
  body.append(group)
  return root
}

/** Paints the already-covered part of a range track, per styles.css's `--fill-pct` contract. */
function setFillPct(rangeInput: HTMLInputElement, min: number, max: number, value: number): void {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  rangeInput.style.setProperty('--fill-pct', `${pct}%`)
}

/**
 * Wires a number input and its slider duplicate to each other: dragging the slider updates the
 * number (and vice versa), `onPick` fires from either, and the slider's `--fill-pct` fill tracks
 * whichever one moved. Shared by every `numberRow` call instead of repeating the wiring three
 * times.
 */
function syncNumberAndRange(
  numberInput: HTMLInputElement,
  rangeInput: HTMLInputElement,
  min: number,
  max: number,
  onPick: (v: number) => void,
): void {
  setFillPct(rangeInput, min, max, Number(rangeInput.value))

  rangeInput.addEventListener('input', () => {
    const v = Number(rangeInput.value)
    numberInput.value = rangeInput.value
    setFillPct(rangeInput, min, max, v)
    onPick(v)
  })

  numberInput.addEventListener('change', () => {
    const v = Number(numberInput.value)
    if (Number.isNaN(v)) return
    rangeInput.value = String(v)
    setFillPct(rangeInput, min, max, v)
    onPick(v)
  })
}

function numberRow(
  label: string,
  note: string,
  o: { readonly min: number; readonly max: number; readonly step?: number; readonly value: number },
  onPick: (v: number) => void,
): HTMLElement {
  const { root, body } = row(label, note)
  const step = o.step ?? 1

  const numberInput = document.createElement('input')
  numberInput.type = 'number'
  numberInput.className = 'range-number'
  numberInput.min = String(o.min)
  numberInput.max = String(o.max)
  numberInput.step = String(step)
  numberInput.value = String(o.value)

  const rangeInput = document.createElement('input')
  rangeInput.type = 'range'
  rangeInput.min = String(o.min)
  rangeInput.max = String(o.max)
  rangeInput.step = String(step)
  rangeInput.value = String(o.value)

  syncNumberAndRange(numberInput, rangeInput, o.min, o.max, onPick)

  const wrap = document.createElement('div')
  wrap.className = 'range-row'
  wrap.append(rangeInput, numberInput)
  body.append(wrap)
  return root
}

export interface ConfigPanelHandle {
  set(next: DemoConfig): void
  setStatus(text: string): void
}

/**
 * The factory-options block — every setting §6.5 calls a factory option: one that changes the
 * shape of the program, the set of resources, or the set of other knobs, as opposed to a knob,
 * which is live and costs one draw. Kept in its own file, deliberately apart from `panel.ts`'s
 * generated knob controls, so a reader can see that split rather than infer it from behaviour.
 */
export function createConfigPanel(
  initial: DemoConfig,
  onChange: (next: DemoConfig) => void,
): ConfigPanelHandle {
  let current: DemoConfig = initial

  const statusEl = document.createElement('p')
  statusEl.className = 'config-status'

  function apply(next: DemoConfig): void {
    current = next
    render()
    onChange(next)
  }

  function render(): void {
    const root = document.getElementById(CONFIG_ROOT_ID)
    if (root === null) return
    root.replaceChildren()

    root.append(
      radioRow(
        'config-edge-mode',
        'edgeMode',
        'changes the set of other knobs — a `hull` factory has no torn descriptors',
        ['torn', 'hull'] as const,
        current.edgeMode,
        (v) => apply({ ...current, edgeMode: v }),
      ),
    )

    root.append(
      boolRow(
        'tiles',
        "the four baked tiles, on the @paper-crumple/paper/tiles subpath. This describes paperSheet's " +
          "own default, not this demo's default (below, tiles starts on): paperSheet defaults to " +
          'tiles: null because its default edge mode is hull, which needs no tear, no teeth and no ' +
          'fibre — a hull consumer who never opts into torn would otherwise be charged for an asset ' +
          'their configuration cannot use',
        current.tiles,
        (v) => apply({ ...current, tiles: v }),
      ),
    )

    root.append(
      packsRow(
        'an unsupplied bucket returns an AssetError naming the missing subpath',
        current.packs,
        (v) => apply({ ...current, packs: v }),
      ),
    )

    root.append(
      radioRow<PresentMode>(
        'config-present',
        'present',
        "`blit` copies into canvases you supply; `direct` hands you the stage's own surface " +
          'and a view is a rect of it',
        ['blit', 'direct'] as const,
        current.present,
        (v) => apply({ ...current, present: v }),
      ),
    )

    root.append(
      numberRow(
        'cssPx',
        'feeds sizeForDisplay({ cssPx, dpr, cap: 512 })',
        { min: 96, max: 512, value: current.cssPx },
        (v) => apply({ ...current, cssPx: v }),
      ),
    )

    root.append(
      numberRow(
        'budgetMb',
        'the byte budget governs exactly one per-sprite tier — fronts',
        { min: 4, max: 256, value: current.budgetMb },
        (v) => apply({ ...current, budgetMb: v }),
      ),
    )

    root.append(
      numberRow(
        'overscanHeadroom',
        "scales the frozen reserve; past roughly 2.34 for torn's defaults a mount refuses with " +
          'a wrapped KnobError',
        { min: 0, max: 2, step: 0.05, value: current.overscanHeadroom },
        (v) => apply({ ...current, overscanHeadroom: v }),
      ),
    )

    root.append(statusEl)

    // The sidebar's "01 Source" header carries a short mono summary of the live factory options,
    // same as every `panel.ts`-generated section's own `.accordion-summary` — `edgeMode` is the
    // one option that reshapes the whole knob set, `packs` the one most readers will change next.
    const summaryEl = document.getElementById('source-summary')
    if (summaryEl !== null) {
      summaryEl.textContent = `${current.edgeMode} · ${current.packs.join('+')}`
    }
  }

  render()

  return {
    set(next: DemoConfig): void {
      current = next
      render()
    },
    setStatus(text: string): void {
      statusEl.textContent = text
    },
  }
}
