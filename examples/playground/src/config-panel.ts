import type { BucketName, DemoConfig, PresentMode } from './config'
import { BUCKET_NAMES } from './config'

const CONFIG_ROOT_ID = 'config'

interface RowParts {
  readonly root: HTMLElement
  readonly body: HTMLElement
}

/**
 * One row: a heading, the control(s) `body` holds, and the one-line note the brief's Step 1
 * table asks for — rendered so a reader sees *why* the control exists, not just what it does.
 */
function row(label: string, note: string): RowParts {
  const root = document.createElement('div')
  root.className = 'config-row'

  const head = document.createElement('div')
  head.className = 'config-head'
  head.textContent = label
  root.append(head)

  const body = document.createElement('div')
  body.className = 'config-body'
  root.append(body)

  const noteEl = document.createElement('p')
  noteEl.className = 'config-note'
  noteEl.textContent = note
  root.append(noteEl)

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
  for (const opt of options) {
    const wrap = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'radio'
    input.name = name
    input.value = opt
    input.checked = opt === value
    input.addEventListener('change', () => {
      if (input.checked) onPick(opt)
    })
    wrap.append(input, document.createTextNode(` ${opt}`))
    body.append(wrap)
  }
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
  for (const name of BUCKET_NAMES) {
    const wrap = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = value.includes(name)
    input.addEventListener('change', () => {
      const next = input.checked
        ? BUCKET_NAMES.filter((b) => value.includes(b) || b === name)
        : value.filter((b) => b !== name)
      onPick(next)
    })
    wrap.append(input, document.createTextNode(` ${name}`))
    body.append(wrap)
  }
  return root
}

function numberRow(
  label: string,
  note: string,
  o: { readonly min: number; readonly max: number; readonly step?: number; readonly value: number },
  onPick: (v: number) => void,
): HTMLElement {
  const { root, body } = row(label, note)
  const input = document.createElement('input')
  input.type = 'number'
  input.className = 'config-input'
  input.min = String(o.min)
  input.max = String(o.max)
  if (o.step !== undefined) input.step = String(o.step)
  input.value = String(o.value)
  input.addEventListener('change', () => {
    const v = Number(input.value)
    if (Number.isNaN(v)) return
    onPick(v)
  })
  body.append(input)
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
