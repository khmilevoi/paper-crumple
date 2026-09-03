import * as pc from '@paper-crumple/core'
import type { BuiltStage } from './config'
import type { Sample } from './samples'

const HERO_SLOT = 'hero-slot'
const GRID_SLOT = 'grid'
const GRID_COLS = 3

/**
 * `blit` supplies its own 2D canvas per view and the stage blits into it. `direct` has one
 * surface — the stage's own — and a view is a rect of it, so the element appended here is the
 * stage's canvas rather than one the demo made.
 */
export function heroCanvas(built: BuiltStage): HTMLCanvasElement | Error {
  const slot = document.getElementById(HERO_SLOT)
  if (slot === null) return new Error('playground: #hero-slot is missing from index.html')
  slot.replaceChildren()

  if (built.present === 'direct') {
    const own = built.stage.surface.canvas
    if (!(own instanceof HTMLCanvasElement)) {
      return new Error('playground: a direct stage must own an HTMLCanvasElement surface')
    }
    slot.append(own)
    return own
  }

  const canvas = document.createElement('canvas')
  canvas.className = 'hero-canvas'
  // The display size is set HERE, and deliberately not left to follow the backing store.
  //
  // `blitOut`'s default `size: 'managed'` re-reads `getBoundingClientRect()` on *every draw* and
  // writes `canvas.width`/`height` from it (`core`'s managed branch, `blit.ts`'s
  // `managedBackingStore`: `min(round(cssDim * dpr), frontDim)`). A canvas with no CSS size takes
  // its layout size from those same attributes, so the two feed each other and every draw
  // multiplies the element by `devicePixelRatio`: measured at dpr 1.5, +1.28 % per blit, climbing
  // until it hit `front.h` — roughly eight folds. That is the canvas "growing and shifting" while
  // a run plays, and because it is per *draw* rather than per run, even the draw-only pose slider
  // did it. The grid tiles never drifted, because `.grid-tile-canvas` fixes their size in CSS.
  //
  // `cssPx` is already this demo's display-size knob, so it is the honest source for the box, and
  // `mountHero` below passes `fit: 'contain'` — the front is letterboxed into whatever box it is
  // given, so a square one crops and stretches nothing.
  canvas.style.width = `${String(built.cssPx)}px`
  canvas.style.height = `${String(built.cssPx)}px`
  slot.append(canvas)
  return canvas
}

/**
 * `direct` mode's whole geometry, computed once and handed to both `mountHero` and `mountGrid`:
 * the hero occupies a `width × width` square at the surface's origin, and the grid's tiles fill a
 * strip below it. One function is the single source of truth for both sets of rects and for the
 * surface size they are fixed against.
 *
 * This must run, and the surface must be sized from its result, **before any view exists**. A
 * view's rect is resolved once, at `stage.view()`, and never recomputed — growing the surface
 * afterward does not move or rescale that view's rect, but a WebGL buffer's origin is bottom-left,
 * so the already-placed content visibly relocates within the taller canvas anyway. Sizing up front
 * is what avoids that: nothing has been drawn against the surface yet, so there is nothing to
 * disturb.
 */
export interface DirectLayout {
  readonly surfaceW: number
  readonly surfaceH: number
  readonly heroRect: pc.Rect
  readonly tileRects: readonly pc.Rect[]
}

export function planDirectLayout(width: number, tileCount: number): DirectLayout {
  const w = Math.max(1, Math.floor(width))
  const heroRect: pc.Rect = { x: 0, y: 0, w, h: w }

  const rows = Math.max(1, Math.ceil(tileCount / GRID_COLS))
  const tileW = Math.max(1, Math.floor(w / GRID_COLS))
  const tileH = Math.max(1, Math.floor(w / 2))
  const tileRects: pc.Rect[] = []
  for (let i = 0; i < tileCount; i += 1) {
    const col = i % GRID_COLS
    const row = Math.floor(i / GRID_COLS)
    tileRects.push({ x: col * tileW, y: w + row * tileH, w: tileW, h: tileH })
  }

  return { surfaceW: w, surfaceH: w + tileH * rows, heroRect, tileRects }
}

/**
 * Badges over `#hero-slot`, floated with `.stage-chip` (a host with `position: relative` is
 * already true of `#hero-slot`, per that class's own comment in styles.css) — matching the
 * design's stage overlay exactly: top-left carries the live pose readout (accented — it is the
 * one number that changes every frame of a run) next to the mounted sample's id, top-right
 * carries the sheet's edge mode. `present` has no equivalent on the design's stage overlay (it is
 * a factory option, already visible in the "01 Source" accordion's segmented control), so it is
 * not duplicated up here.
 *
 * The two top-left chips sit in a small flex row rather than each being independently
 * `position: absolute`, because `.stage-chip`'s own absolute positioning would otherwise stack
 * them on top of each other; `position: static` inline overrides that for just these two so the
 * row's own `display: flex` lays them out side by side, while the wrapper itself carries the
 * absolute placement.
 *
 * The DOM is torn down and remounted on every `rebuild()` (`heroCanvas`'s `slot.replaceChildren()`
 * runs first), so the pose chip's `view.on(...)` subscriptions are always scoped to the view they
 * were created against — there is never a stale value to chase and never a duplicate on rebuild.
 */
function mountHeroChips(built: BuiltStage, sample: Sample, view: pc.View): void {
  const slot = document.getElementById(HERO_SLOT)
  if (slot === null) return

  const topLeft = document.createElement('div')
  topLeft.style.position = 'absolute'
  topLeft.style.top = '10px'
  topLeft.style.left = '10px'
  topLeft.style.display = 'flex'
  topLeft.style.gap = '6px'

  const poseChip = document.createElement('span')
  poseChip.className = 'stage-chip stage-chip--accent'
  poseChip.style.position = 'static'
  topLeft.append(poseChip)

  const sampleChip = document.createElement('span')
  sampleChip.className = 'stage-chip'
  sampleChip.style.position = 'static'
  sampleChip.textContent = sample.id
  topLeft.append(sampleChip)

  slot.append(topLeft)

  const edgeChip = document.createElement('span')
  edgeChip.className = 'stage-chip'
  edgeChip.style.top = '10px'
  edgeChip.style.right = '10px'
  edgeChip.textContent = `edge: ${built.sheet.edgeMode}`
  slot.append(edgeChip)

  const lastPose = (built.motion.poses?.dwells ?? pc.DWELL_MS).length - 1
  const updatePose = (): void => {
    poseChip.textContent = `pose ${String(view.pose)} / ${String(lastPose)}`
  }
  updatePose()
  view.on('start', updatePose)
  view.on('step', updatePose)
  view.on('end', updatePose)
}

export async function mountHero(
  built: BuiltStage,
  sample: Sample,
  signal: AbortSignal,
  directRect?: pc.Rect,
): Promise<{ view: pc.View; sprite: pc.Sprite } | Error | pc.Aborted> {
  const canvas = heroCanvas(built)
  if (canvas instanceof Error) return canvas

  if (built.present === 'direct') {
    if (directRect === undefined) {
      return new Error(
        'playground: mountHero needs a rect in direct mode — call planDirectLayout() and size ' +
          'the surface before mounting anything',
      )
    }
    // One surface, one rect. `add` then `view` then `show` — which is what `mount` composes,
    // spelled out because `mount` takes a canvas and a direct view takes a rect. `tag` lives on
    // the view target, not on `add`'s options — `AddOptions` has no `tag` field.
    const sprite = await built.stage.add(sample.url, { key: sample.id })
    if (sprite === pc.ABORTED) return pc.ABORTED
    if (sprite instanceof Error) return sprite
    const view = built.stage.view({ rect: directRect, tag: sample.id })
    if (view instanceof Error) return view
    const shown = view.show(sprite)
    if (shown instanceof Error) return shown
    mountHeroChips(built, sample, view)
    return { view, sprite }
  }

  // mount = add + view + show('flat'), one await, one pair of guards.
  const view = await built.stage.mount(
    { key: sample.id, src: sample.url, canvas, fit: 'contain', tag: sample.id },
    { signal },
  )
  if (view === pc.ABORTED) return pc.ABORTED
  if (view instanceof Error) return view

  const sprite = view.sprite
  if (sprite === null) return new Error('playground: mount returned a view with no sprite')
  mountHeroChips(built, sample, view)
  return { view, sprite }
}

/** `key` also selects the fold preset (`pc.presetForImageId`), which is the whole point of the
 *  grid: printed beside every tile, it is what makes "a broadcast does not fold the grid in
 *  unison" legible rather than merely felt. */
function gridTileLabel(sample: Sample): HTMLElement {
  const label = document.createElement('div')
  label.className = 'grid-tile-label'
  label.textContent = `${sample.label} — preset ${pc.presetForImageId(sample.id)}`
  return label
}

/**
 * One `stage.mount` (blit) or `add` + `view` + `show` (direct) per sample, in a loop — no
 * `mountAll`, for the same reason `mountHero` composes by hand: a batch return type cannot stay
 * honest about which sprites and views already landed when the signal fires mid-loop.
 *
 * Every sample's key doubles as its fold-preset seed and may already be live on this stage: the
 * hero (`mountHero`) added its sample under that same key before `mountGrid` ever runs, since
 * both share one `BuiltStage`. `add()` refuses a live key rather than silently rebuilding it
 * (§4.1), so a tile whose sample matches the hero's reuses the existing sprite through
 * `view()` + `show()` instead — the same composition docs/USAGE.md §1 shows for a grid thumbnail
 * sharing a hero's front texture.
 */
export async function mountGrid(
  built: BuiltStage,
  samples: readonly Sample[],
  signal: AbortSignal,
  directTileRects?: readonly pc.Rect[],
): Promise<{ views: Map<string, pc.View>; failures: Error[] } | pc.Aborted> {
  if (signal.aborted) return pc.ABORTED

  const slot = document.getElementById(GRID_SLOT)
  const views = new Map<string, pc.View>()
  const failures: Error[] = []
  if (slot === null) {
    failures.push(new Error('playground: #grid is missing from index.html'))
    return { views, failures }
  }
  slot.replaceChildren()

  if (built.present === 'direct') {
    if (directTileRects === undefined) {
      failures.push(
        new Error(
          'playground: mountGrid needs directTileRects in direct mode — call planDirectLayout() ' +
            'and size the surface before mounting anything',
        ),
      )
      return { views, failures }
    }

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i]
      const rect = directTileRects[i]
      if (rect === undefined) {
        failures.push(new Error(`playground: no rect planned for sample "${sample.id}"`))
        continue
      }

      const existing = built.stage.get(sample.id)
      let sprite = existing
      if (sprite === undefined) {
        const added = await built.stage.add(sample.url, { key: sample.id, signal })
        if (added === pc.ABORTED) continue
        if (added instanceof Error) {
          failures.push(added)
          continue
        }
        sprite = added
      }

      const view = built.stage.view({ rect, tag: sample.id })
      if (view instanceof Error) {
        failures.push(view)
        continue
      }
      const shown = view.show(sprite)
      if (shown instanceof Error) {
        failures.push(shown)
        continue
      }

      views.set(sample.id, view)
      slot.append(gridTileLabel(sample))
    }

    return { views, failures }
  }

  for (const sample of samples) {
    const tile = document.createElement('div')
    tile.className = 'grid-tile'
    const canvas = document.createElement('canvas')
    canvas.className = 'grid-tile-canvas'
    tile.append(canvas, gridTileLabel(sample))
    slot.append(tile)

    // `mount` composes `add` + `view` + `show`, and `add` refuses a key that is already live —
    // which this sample's key is, exactly when it is also the hero's currently-shown sprite.
    const already = built.stage.get(sample.id)
    if (already !== undefined) {
      const view = built.stage.view({ canvas, fit: 'contain', tag: sample.id })
      if (view instanceof Error) {
        failures.push(view)
        continue
      }
      const shown = view.show(already)
      if (shown instanceof Error) {
        failures.push(shown)
        continue
      }
      views.set(sample.id, view)
      continue
    }

    const view = await built.stage.mount(
      { key: sample.id, src: sample.url, canvas, fit: 'contain', tag: sample.id },
      { signal },
    )
    if (view === pc.ABORTED) continue
    if (view instanceof Error) {
      failures.push(view)
      continue
    }
    views.set(sample.id, view)
  }

  return { views, failures }
}
