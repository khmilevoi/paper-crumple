const STAGE_BG_SLOT = 'stage-bg'
const STAGE_COLUMN_ID = 'stage-column'

/**
 * Presets for the area behind the hero canvas and every grid tile — a pure visual dev aid, not
 * part of the crumple config. It exists so a reader can *see* whether the canvas itself is
 * transparent rather than take it on faith: 'dark' is the demo's own default background (matches
 * it, so nothing to see), 'light' flips the same solid-colour test to the other end, and 'checker'
 * is the classic alpha-checkerboard — the one background a truly opaque canvas can never blend
 * into.
 */
const PRESETS = [
  { className: 'stage-bg-dark', label: 'dark (default)' },
  { className: 'stage-bg-light', label: 'light' },
  { className: 'stage-bg-checker', label: 'checker' },
] as const

/**
 * One class on `#stage-column`, the nearest shared ancestor of `#hero-slot` and every
 * `.grid-tile-canvas` — `styles.css`'s descendant selectors pick both up from that single class,
 * so hero and grid tiles always show the same backdrop without this module reaching into either.
 */
export function createStageBackground(): void {
  const slot = document.getElementById(STAGE_BG_SLOT)
  const column = document.getElementById(STAGE_COLUMN_ID)
  if (slot === null || column === null) return

  const root = document.createElement('div')
  root.className = 'stage-bg-controls'
  const label = document.createElement('span')
  label.className = 'stage-bg-label'
  label.textContent = 'canvas background'
  root.append(label)

  const track = document.createElement('div')
  track.className = 'segmented'

  const buttons = PRESETS.map((preset) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'segmented-btn'
    button.textContent = preset.label
    button.addEventListener('click', () => {
      for (const p of PRESETS) column.classList.remove(p.className)
      column.classList.add(preset.className)
      for (const b of buttons) {
        b.setAttribute('aria-pressed', String(b === button))
        b.classList.toggle('segmented-btn--active', b === button)
      }
    })
    track.append(button)
    return button
  })
  root.append(track)

  const initial = PRESETS[0]
  column.classList.add(initial.className)
  buttons[0]?.setAttribute('aria-pressed', 'true')
  buttons[0]?.classList.add('segmented-btn--active')
  for (const b of buttons.slice(1)) b.setAttribute('aria-pressed', 'false')

  slot.replaceChildren(root)
}
