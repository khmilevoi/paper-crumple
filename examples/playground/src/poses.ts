import type { View } from '@paper-crumple/core'
import { evenKeyFrames } from '@paper-crumple/motion'
import type { Pack } from '@paper-crumple/motion'
import type { BuiltStage } from './config'

/** `index.html` reserves `<div id="poses-editor">` inside the "03 Poses" accordion body. */
const POSES_SLOT = 'poses-editor'

/**
 * The stepper's range, from the design. The floor is the library's own — `setKeyFrames` wants at
 * least one key frame — and the ceiling is the design's: past twelve the selects stop being a
 * grid. Slots may repeat, so the ceiling does not depend on the pack's frame count.
 */
const MIN_POSES = 1
const MAX_POSES = 12

export interface PoseEditorHandle {
  /**
   * Re-points the editor at the stage a rebuild just produced, exactly as `transport.bind` does.
   * A rebuild is a fresh `bakedMotion()` with no override, so the schedule the reader has edited
   * is re-applied to it here; `gridViews` are redrawn at `'flat'` with the hero, because a
   * schedule with fewer poses can leave a parked view at a pose that no longer exists.
   */
  bind(built: BuiltStage, hero: View | null, gridViews?: ReadonlyMap<string, View>): void
}

function sameList(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function iconButton(glyph: string, label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn-icon'
  button.textContent = glyph
  button.setAttribute('aria-label', label)
  return button
}

function secondaryButton(text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn-secondary'
  button.textContent = text
  return button
}

function row(): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'accordion-row'
  el.style.display = 'flex'
  el.style.alignItems = 'center'
  el.style.gap = '8px'
  el.style.flexWrap = 'wrap'
  return el
}

/**
 * The "03 Poses" section: the pose count, one `<select>` per pose slot choosing which stored
 * frame it shows, and the two presets — the pack's own manifest, and an even spread over every
 * stored frame. Everything it applies goes through `bakedMotion().setPoses`, which validates
 * under the parser's own rules ("pose 0 is stored frame 0, never decreasing", `pack.ts`) and
 * reaches every clip the stage already holds; the library's message is what the status line
 * shows when a draft is refused.
 *
 * Built once, mounted into `#poses-editor`; `bind()` re-points it after every rebuild.
 */
export function createPoseEditor(report: (line: string) => void): PoseEditorHandle {
  let built: BuiltStage | null = null
  let hero: View | null = null
  let gridViews: ReadonlyMap<string, View> = new Map()
  /**
   * The pack the selects are built from. Every built-in pack stores the same twelve frames, and
   * `setPoses` checks the draft against every resident pack anyway, so the first resident one is
   * as good as any for the labels; its bucket is named in the status line so that is visible.
   */
  let pack: Pack | null = null
  /** The draft the selects show. Survives a rebuild, like the panel's open sections do. */
  let draft: number[] = []

  const root = document.createElement('div')
  root.className = 'pose-editor'

  // --- pose count -------------------------------------------------------------------------
  const countRow = row()
  const countLabel = document.createElement('span')
  countLabel.textContent = 'pose count'
  const minus = iconButton('−', 'one pose fewer')
  const plus = iconButton('+', 'one pose more')
  const countValue = document.createElement('span')
  countValue.style.fontFamily = 'var(--mono)'
  countValue.style.minWidth = '2ch'
  countValue.style.textAlign = 'center'
  countRow.append(countLabel, minus, countValue, plus)
  root.append(countRow)

  // --- one select per pose slot ------------------------------------------------------------
  const gridRow = row()
  gridRow.style.display = 'block'
  const gridLabel = document.createElement('span')
  gridLabel.textContent = 'key frame per pose slot (simulation frame of the stored slot)'
  gridLabel.style.display = 'block'
  gridLabel.style.marginBottom = '6px'
  const grid = document.createElement('div')
  grid.style.display = 'grid'
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(72px, 1fr))'
  grid.style.gap = '6px'
  gridRow.append(gridLabel, grid)
  root.append(gridRow)

  // --- presets and the status line ---------------------------------------------------------
  const presetRow = row()
  const manifestButton = secondaryButton('Manifest')
  const evenButton = secondaryButton('Even spacing')
  presetRow.append(manifestButton, evenButton)
  root.append(presetRow)

  const statusLine = document.createElement('p')
  statusLine.className = 'transport-readout'
  statusLine.style.margin = '6px 0 0'
  root.append(statusLine)

  // The accordion header is `index.html`'s; the summary chip beside its chevron is the one thing
  // this module adds to it, and only if nobody has already.
  const slot = document.getElementById(POSES_SLOT)
  const header = slot?.closest('.accordion-section')?.querySelector('.accordion-header') ?? null
  let summary: HTMLElement | null = header?.querySelector('.accordion-summary') ?? null
  if (header !== null && summary === null) {
    summary = document.createElement('span')
    summary.className = 'accordion-summary'
    const chevron = header.querySelector('.accordion-chevron')
    if (chevron !== null) header.insertBefore(summary, chevron)
    else header.append(summary)
  }

  function setEnabled(enabled: boolean): void {
    for (const b of [minus, plus, manifestButton, evenButton]) b.disabled = !enabled
    for (const select of grid.querySelectorAll('select')) select.disabled = !enabled
  }

  function isManifest(): boolean {
    return pack !== null && sameList(draft, pack.keyFrames)
  }

  function refreshSummary(): void {
    if (summary === null) return
    summary.textContent =
      pack === null ? '' : `${String(draft.length)} poses · ${isManifest() ? 'manifest' : 'custom'}`
  }

  function renderGrid(): void {
    grid.replaceChildren()
    const frames = pack?.frames
    if (frames === undefined) return
    const last = draft.length - 1
    draft.forEach((slotIndex, pose) => {
      const cell = document.createElement('label')
      cell.style.display = 'flex'
      cell.style.flexDirection = 'column'
      cell.style.gap = '3px'
      const caption = document.createElement('span')
      caption.className = 'accordion-number'
      caption.textContent =
        `pose ${String(pose)}` + (pose === 0 ? ' · flat' : pose === last ? ' · ball' : '')
      const select = document.createElement('select')
      for (const [i, frame] of frames.entries()) {
        const opt = document.createElement('option')
        opt.value = String(i)
        opt.textContent = String(frame.index)
        opt.title = `stored slot ${String(i)} · simulation frame ${String(frame.index)}`
        opt.selected = i === slotIndex
        select.append(opt)
      }
      // Pose 0 is the untouched sprite in every pack (`setKeyFrames`); the select says so rather
      // than letting a reader pick something the library will refuse.
      select.disabled = pose === 0
      select.addEventListener('change', () => {
        draft[pose] = Number(select.value)
        apply()
      })
      cell.append(caption, select)
      grid.append(cell)
    })
  }

  function render(): void {
    countValue.textContent = pack === null ? '–' : String(draft.length)
    minus.disabled = pack === null || draft.length <= MIN_POSES
    plus.disabled = pack === null || draft.length >= MAX_POSES
    renderGrid()
    refreshSummary()
  }

  function describeSchedule(): string {
    if (built === null || pack === null) return ''
    const poses = built.motion.poses
    const dwells = poses === null ? 'DWELL_MS' : JSON.stringify(poses.dwells)
    const first = pack.frames[0]?.index ?? 0
    const lastFrame = pack.frames[pack.frames.length - 1]?.index ?? 0
    return (
      `${String(pack.frameCount)} stored frames from bucket '${pack.bucket}' ` +
      `(sim ${String(first)} … ${String(lastFrame)}) · ` +
      `${isManifest() ? 'manifest' : 'custom'} key frames ${JSON.stringify(draft)} · dwells ${dwells}`
    )
  }

  /**
   * Applies the draft, or reports why the library refused it. A run in flight keeps the plan it
   * started with and would render its remaining poses through the new key frames, so every run
   * is stopped first, and every view is put back at `'flat'` — pose 0 exists in every schedule.
   */
  function apply(): void {
    if (built === null || pack === null) return
    built.stage.stop({ all: true })
    const refused = built.motion.setPoses(isManifest() ? null : { keyFrames: draft })
    refreshSummary()
    if (refused !== undefined) {
      statusLine.textContent = `refused: ${refused.message}`
      report(`poses: ${refused.message}`)
      return
    }
    hero?.draw('flat')
    for (const v of gridViews.values()) v.draw('flat')
    statusLine.textContent = describeSchedule()
  }

  function setDraft(next: readonly number[]): void {
    draft = [...next]
    render()
    apply()
  }

  function resized(count: number): void {
    if (pack === null) return
    const even = evenKeyFrames(count, pack.frameCount)
    if (even instanceof Error) {
      report(`poses: ${even.message}`)
      return
    }
    setDraft(even)
  }

  minus.addEventListener('click', () => resized(Math.max(MIN_POSES, draft.length - 1)))
  plus.addEventListener('click', () => resized(Math.min(MAX_POSES, draft.length + 1)))
  manifestButton.addEventListener('click', () => {
    if (pack !== null) setDraft(pack.keyFrames)
  })
  evenButton.addEventListener('click', () => resized(draft.length))

  function bind(
    nextBuilt: BuiltStage,
    nextHero: View | null,
    nextGridViews: ReadonlyMap<string, View> = new Map(),
  ): void {
    built = nextBuilt
    hero = nextHero
    gridViews = nextGridViews
    pack = built.motion.packs()[0] ?? null
    if (pack === null) {
      draft = []
      render()
      setEnabled(false)
      statusLine.textContent =
        'no pack resident — the stage holds no sprite, so there is nothing to schedule'
      return
    }
    setEnabled(true)
    // First bind: start from what the source is playing, which is the manifest. Later binds keep
    // the reader's draft and re-apply it to the fresh source.
    if (draft.length === 0) draft = [...(built.motion.poses?.keyFrames ?? pack.keyFrames)]
    render()
    apply()
  }

  if (slot !== null) slot.replaceChildren(root)

  return { bind }
}
