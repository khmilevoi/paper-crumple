import * as pc from '@paper-crumple/core'
import {
  EDGE_SLOP_REFERENCE_PX,
  overscanRadius,
  RADIUS_CAP_REFERENCE_PX,
} from '@paper-crumple/core/unstable'
import { defaultsFor, edgeParamsFrom } from '@paper-crumple/paper'
import type { EdgeFinish, EdgeShape, EdgeSpec, EdgeWidthUnit } from '@paper-crumple/paper'
import type { BuiltStage, DemoConfig } from '../scene/config'
import { buildStage } from '../scene/config'
import { ceilingsFor, reserveRadiusFor } from '../paper/edge-ceilings'
import { frameArtwork } from '../scene/framing'
import type { Framing } from '../scene/framing'

/**
 * A static comparison figure: every §6 edge cell of design 2026-09-05, drawn from the real
 * library on one real sample, laid out in a labelled matrix a human reads side by side.
 *
 * This is NOT the playground. The playground is a live panel a reader drives; this page is a
 * one-shot renderer a screenshot driver calls once, and the whole difference falls out of one
 * requirement: **every cell must be the same picture with one thing changed.** A grid where the
 * artwork jumps, softens or crops between cells says nothing about the knob that was varied,
 * because the reader cannot tell the knob's effect from the layout's. Almost every decision
 * below — the shared reserve radius, the two-phase capture, the fixed tile — exists to hold
 * everything except the one varied knob still.
 *
 * `window.__renderGrid` / `__gridDone` / `__gridErrors` are the whole interface the driver codes
 * against; see `<scratch>/edge-grid/CONTRACT.md`. `__renderGrid` **always resolves**, including
 * when every cell failed: a driver that has to distinguish "the page threw" from "the render
 * refused" cannot report either one usefully, so failures are values on `__gridErrors` and the
 * promise settles regardless (spec 10.8's "errors are values", carried up to the page).
 */

export interface CellSpec {
  /** Caption printed under the cell, e.g. "edgeWidth 20". */
  readonly label: string
  readonly edgeShape: EdgeShape
  readonly edgeFinish: EdgeFinish
  readonly edgeWidthUnit: EdgeWidthUnit
  /** Knob writes applied to the paper slot before the draw, e.g. `{ edgeWidth: 20 }`. */
  readonly knobs: Readonly<Record<string, number>>
}

export interface GridSpec {
  readonly title: string
  /** e.g. `/samples/garment-sweater.png` */
  readonly sampleUrl: string
  /** The ARTWORK's long side on screen, in css px. */
  readonly cssPx: number
  /** Column headers, left to right. */
  readonly columns: readonly string[]
  /** Row headers, top to bottom. Each row is one edge cell. */
  readonly rows: readonly string[]
  /** `rows.length * columns.length` cells, ROW-MAJOR. */
  readonly cells: readonly CellSpec[]
}

declare global {
  interface Window {
    /** Builds the whole labelled grid into `#grid`. Resolves when every cell has been drawn. */
    __renderGrid: (spec: GridSpec) => Promise<void>
    /** Set to true by `__renderGrid` once every cell is on screen; false while it runs. */
    __gridDone: boolean
    /** Any per-cell failure, as readable strings. Empty on a clean run. */
    __gridErrors: string[]
    /**
     * Beyond the contract, and diagnostic only: what `frameArtwork` reported for each cell that
     * drew, in CSS px. It exists so "every cell shows the same artwork at the same size" can be
     * *checked* rather than eyeballed — `image` must be identical across every entry, and any
     * drift in it means the reserve is no longer shared and the grid is comparing two scales.
     */
    __gridFraming: GridFramingEntry[]
  }
}

export interface GridFramingEntry {
  readonly label: string
  /** The artwork's box — the invariant. */
  readonly image: { readonly w: number; readonly h: number }
  /** The drawn paper's box: this is what legitimately grows with the edge knobs. */
  readonly canvas: { readonly w: number; readonly h: number }
  /** The paper box's top-left relative to the artwork's. */
  readonly offset: { readonly x: number; readonly y: number }
}

/**
 * How much room above the widest live knob the shared reserve buys.
 *
 * The reserve is an inequality (`handle.ts`'s step-4 `checkReserve`:
 * `overscanRadius(live) <= reserve.radius`), so in principle 1.0 would do. It is not 1.0 because
 * the two sides are computed by different code paths — this file resolves the live bag through
 * `edgeParamsFrom`, the library resolves it inside `build()` — and a reserve that clears the
 * requirement by a float's width would turn any future divergence into a refused cell rather than
 * a slightly larger front. 12 % is cheap: the cost of headroom is artwork resolution inside a
 * fixed front, and 12 % of a ~200 reference-px radius is ~2 % of the artwork's long side.
 */
const RESERVE_SAFETY = 1.12

/** The device pixels the captured tiles hold per CSS pixel — the driver screenshots at 2. */
const CAPTURE_SCALE = 2

/** Blank margin around the widest cell's paper, so no edge touches its tile's border. */
const TILE_PAD_CSS_PX = 6

/**
 * The sample is added under one fixed key. Each cell owns a whole stage of its own that is
 * disposed before the next one starts, so no two adds ever share a stage and the key never
 * collides with itself.
 */
const SPRITE_KEY = 'sample'

/** Everything the layout pass needs from a cell whose stage has already been torn down. */
interface Capture {
  readonly cell: CellSpec
  /** The drawn paper, at `CAPTURE_SCALE` device px per CSS px. */
  readonly pixels: HTMLCanvasElement
  /** The boxes `frameArtwork` reported, in CSS px — where the artwork sits inside `pixels`. */
  readonly framing: Framing
}

/** One cell's slot in the DOM, filled by the layout pass once the tile size is known. */
interface CellSlot {
  readonly figure: HTMLElement
  readonly canvas: HTMLCanvasElement
  /** `null` where the cell's caption repeats its column header and was suppressed — see
   *  `buildSkeleton`. */
  readonly caption: HTMLElement | null
}

const errors: string[] = []
const framings: GridFramingEntry[] = []

function fail(message: string): void {
  errors.push(message)
}

function specOf(cell: CellSpec): EdgeSpec {
  return { shape: cell.edgeShape, finish: cell.edgeFinish, widthUnit: cell.edgeWidthUnit }
}

function numberOr(value: string | number | boolean | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The reserve radius one cell's own knob bag actually demands — the left-hand side of
 * `checkReserve`'s inequality, computed from the library's own `edgeParamsFrom` /
 * `overscanRadius` rather than from a formula restated here, so the two cannot drift.
 *
 * `edgeParamsFrom` resolves every key it reads through `defaultsFor(spec)` (ruling R3), so a cell
 * that only names `edgeWidth` still asks for exactly what the shipped defaults ask for on the
 * other terms — which is precisely what a comparison grid wants: one knob moved, nothing else.
 */
function requiredRadiusFor(cell: CellSpec): number {
  const spec = specOf(cell)
  const merged = { ...defaultsFor(spec), ...cell.knobs }
  const widthRef = numberOr(merged['edgeWidth'], 0)
  return overscanRadius(edgeParamsFrom(spec, merged, widthRef))
}

/** The same radius at this cell's factory DEFAULTS — what `freezeOverscan` multiplies by
 *  `1 + overscanHeadroom` to get the frozen reserve (`PaperSheet.overscan`'s doc comment). */
function defaultRadiusFor(cell: CellSpec): number {
  const spec = specOf(cell)
  const defaults = defaultsFor(spec)
  return overscanRadius(edgeParamsFrom(spec, defaults, numberOr(defaults['edgeWidth'], 0)))
}

interface ReservePlan {
  /** The one frozen reserve radius every cell in this grid is built to, in reference px. */
  readonly targetRadius: number
  /** `overscanHeadroom` per cell, index-aligned with `spec.cells`. */
  readonly headroom: readonly number[]
}

/**
 * One reserve radius for the whole grid, and the per-cell `overscanHeadroom` that reaches it.
 *
 * **Why the headroom is not a constant.** `overscanHeadroom` is a *multiplier on this factory's
 * default radius* (`freezeOverscan`: `radius = overscanRadius(defaults) * (1 + room)`), and the
 * four rows do not share a default radius — a `paper` finish reserves `4 * fiberLen +
 * deckleWidth` (23 reference px at the shipped defaults) that a `clean` finish does not. The same
 * headroom on all four rows would therefore freeze four *different* reserves, hence four
 * different overscan fractions `p`, hence four different artwork-to-front ratios: `artworkLongSide
 * = maxSize / (1 + 2p)`. The artwork would be resampled to a different resolution in each row and
 * the rows would differ in sharpness for a reason that has nothing to do with the edge. Solving
 * per cell for a SHARED radius instead pins `p` — and with it the front layout, the artwork
 * resolution and `frameArtwork`'s scale — across every cell of the grid.
 *
 * **Why it is derived and not hardcoded.** The reserve is frozen from the factory's DEFAULT knobs
 * (`edgeWidth` 47), so a live write of 100 is refused as "re-add required" (spec 8.6) unless the
 * headroom bought the room first. The target is therefore the largest radius any cell in THIS
 * spec demands, times `RESERVE_SAFETY` — a grid that only varies `angularity` pays nothing for a
 * `edgeWidth 100` grid's reserve.
 */
function planReserve(spec: GridSpec): ReservePlan | Error {
  let target = 0
  for (const cell of spec.cells) {
    const required = requiredRadiusFor(cell)
    if (!Number.isFinite(required)) {
      return new Error(`edge-grid: cell "${cell.label}" has a non-finite reserve radius`)
    }
    target = Math.max(target, required * RESERVE_SAFETY, defaultRadiusFor(cell))
  }
  if (target >= RADIUS_CAP_REFERENCE_PX) {
    return new Error(
      `edge-grid: this grid needs a ${target.toFixed(1)} reference-px reserve, at or past the ` +
        `${String(RADIUS_CAP_REFERENCE_PX)} px cap where the guard margin diverges ` +
        '(design 2026-09-05 §4.2) — no headroom can buy it',
    )
  }
  const headroom = spec.cells.map((cell) => Math.max(0, target / defaultRadiusFor(cell) - 1))
  return { targetRadius: target, headroom }
}

/**
 * Confirm, before the stage is even built, that every knob this cell is about to write lands
 * under the live ceiling the frozen reserve leaves — `edge-ceilings.ts` computes it from
 * `@paper-crumple/paper`'s own public exports, which is the same inequality `checkReserve` will
 * apply. A refusal reaches `App.tsx`'s status pill as an orphaned error event in the playground; here
 * it would reach nothing at all and the cell would silently render the PREVIOUS width, which is
 * the exact failure mode that makes a comparison grid lie. So it is checked ahead of the write
 * and reported as a value.
 *
 * Under `edgeWidthUnit: 'percent'` the ceiling is genuinely unreachable from public values (see
 * `reserveRadiusFor`'s doc comment) and this says so rather than inventing a number.
 */
function checkCeilings(cell: CellSpec, headroom: number): string | null {
  const spec = specOf(cell)
  if (spec.widthUnit !== 'px') {
    return (
      `${cell.label}: edgeWidthUnit "percent" — the live ceiling cannot be recomputed from ` +
      'public values, so this cell is rendered without a pre-flight reserve check'
    )
  }
  const reserve = reserveRadiusFor(spec, headroom)
  if (reserve === undefined) {
    return `${cell.label}: the frozen reserve could not be derived at headroom ${headroom.toFixed(3)}`
  }
  const patched: Record<string, number> = {}
  for (const [key, value] of Object.entries(cell.knobs)) patched[`sheet.${key}`] = value
  const ceilings = ceilingsFor(spec, headroom, patched)
  const defaults = defaultsFor(spec)
  const width = numberOr(cell.knobs['edgeWidth'], numberOr(defaults['edgeWidth'], 0))
  const variance = numberOr(cell.knobs['edgeVariance'], numberOr(defaults['edgeVariance'], 0))
  if (ceilings.widthMax !== undefined && width > ceilings.widthMax) {
    return (
      `${cell.label}: edgeWidth ${String(width)} is past the live ceiling ` +
      `${ceilings.widthMax.toFixed(2)} (reserve radius ${reserve.toFixed(1)}, slop ` +
      `${String(EDGE_SLOP_REFERENCE_PX)}) — the write would be refused as "re-add required"`
    )
  }
  if (ceilings.varianceMax !== undefined && variance > ceilings.varianceMax) {
    return (
      `${cell.label}: edgeVariance ${String(variance)} is past the live ceiling ` +
      `${ceilings.varianceMax.toFixed(3)} — the write would be refused as "re-add required"`
    )
  }
  return null
}

/**
 * The one canvas the library ever paints into.
 *
 * **One WebGL2 context at a time.** A browser caps live WebGL2 contexts at roughly sixteen and
 * loses the oldest past that, and a grid is sixteen cells; a page that built sixteen stages would
 * lose the earliest cells' contexts while it was still drawing the last. So there is one scratch
 * canvas, one stage at a time, and the pixels are copied out into a plain 2D canvas before the
 * stage is disposed.
 *
 * It is laid out (not `display: none`) because a `blit` view's default `size: 'managed'` writes
 * the backing store from `getBoundingClientRect()` during every draw, and a zero CSS box is left
 * alone rather than resized to zero (`BlitTarget`'s own doc comment) — a hidden scratch would
 * capture whatever the previous cell left in it.
 */
function scratchCanvas(): HTMLCanvasElement {
  const existing = document.querySelector<HTMLCanvasElement>('#scratch')
  if (existing !== null) return existing
  const canvas = document.createElement('canvas')
  canvas.id = 'scratch'
  document.body.append(canvas)
  return canvas
}

/** One animation frame, so a `refresh()`'s blit is on the canvas before it is copied out. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve()
    })
  })
}

/**
 * Write one cell's knobs onto the live stage, patch-keyed the way `stage.set` wants.
 *
 * Every key is checked against the descriptors THIS factory declares first: `descriptorsFor` is
 * per-cell (`angularity` exists only under `smooth`, `tearFreq` only under `torn`), and a write to
 * a key this cell has no descriptor for comes back as a `KnobError` that would otherwise read as
 * a rendering failure rather than as a spec that named the wrong knob for its row.
 */
function applyKnobs(built: BuiltStage, cell: CellSpec): boolean {
  const declared = new Set(built.sheet.knobs.map((k) => k.key))
  let ok = true
  for (const [key, value] of Object.entries(cell.knobs)) {
    if (!declared.has(key)) {
      fail(`${cell.label}: this cell's sheet declares no knob "${key}" — not written`)
      ok = false
      continue
    }
    // The erased `pc.BlitStage` type cannot prove a runtime string is one of the slot's own keys,
    // so the patch is cast at the call site exactly as `App.tsx`'s `setKnob` (via `usePaperScene`)
    // and the library's own tests do; the runtime registry is what enforces the scope, and it
    // answers with an Error.
    const written = built.stage.set({ [`sheet.${key}`]: value } as never)
    if (written instanceof Error) {
      fail(`${cell.label}: stage.set sheet.${key} = ${String(value)}: ${written.message}`)
      ok = false
    }
  }
  return ok
}

/**
 * Build one stage, draw one cell, copy the pixels out, dispose the stage.
 *
 * The order — **knobs, then add**, then `prepare`, then `view`/`show` — is deliberate, and the
 * first step of it is load-bearing in a way that is invisible until a hull-tier knob moves far.
 *
 * **Why the knobs go on before `add()`.** `stage.add()` runs `source()`, and `source()` is what
 * fixes this sprite's `handle.frontRect` — the paper's own extent — from the knob values that are
 * live at that moment. The core then sizes the sprite's `fit` OVER THAT RECT
 * (`packages/core/src/stage.ts`: `motion.fit(handle.frontRect, ...)`), and every later
 * `sheet.build(handle, fit.frontSize, ...)` renders the paper into that window. A re-source keeps
 * it: `resource()`'s own doc comment says "the record's fit and clip stay". So a knob written
 * AFTER `add()` that enlarges the paper's rect — which under `smooth` `edgeWidth` does, because
 * there it is a HULL-tier knob (`paper-knobs.ts`) whose value IS the hull band, so the re-source
 * traces a polygon at the new, wider distance — grows the paper inside a window that was sized
 * for the old one, and the overflow is cut off flat against the window's straight sides. Measured
 * on this grid at `edgeWidth 100`: the paper's alpha ended exactly on its drawn box's right
 * column for 136 of 518 rows (`smooth / clean`) and its bottom row for 45 of 544 columns
 * (`smooth / paper`), against 1-11 for every unclipped cell. Under `torn` `edgeWidth` is a
 * FRONT-tier knob, no re-source runs, and the rect the fit was sized over is the silhouette grown
 * by the whole `overscanRadius` — which is why those two rows never showed it.
 *
 * The reserve is NOT what was short: `sheet.overscan` came back as 0.36374 on all sixteen cells
 * (the shared reserve `planReserve` buys), and `checkCeilings` cleared `edgeWidth 100` against a
 * live ceiling of 129.8 (`clean`) / 114.7 (`paper`). Writing the knobs first costs nothing and
 * removes the second `source()` entirely: the front is built once, at the cell's final values.
 *
 * `prepare()` still follows the `add()`, and still matters: it is the one demand that JOINS a
 * re-source rather than returning around it (`useCrumple`'s own re-frame path, `hero.ts`), so by
 * the time the view shows the sprite its frame is final and a single `refresh()` settles the
 * managed backing store. With the knobs already in place it normally has nothing to join — which
 * is the point.
 */
async function renderCell(
  spec: GridSpec,
  cell: CellSpec,
  headroom: number,
  scratch: HTMLCanvasElement,
): Promise<Capture | null> {
  const controller = new AbortController()
  const config: DemoConfig = {
    edgeShape: cell.edgeShape,
    edgeFinish: cell.edgeFinish,
    edgeWidthUnit: cell.edgeWidthUnit,
    // The tiles are the tear/deckle/fibre photographs. Without them `torn` and `paper` render
    // against the 1x1 neutral planes — a legitimate render, but "the photograph turned off", and
    // this figure exists to show what those two finishes actually look like.
    tiles: true,
    packs: ['1x1', '2x3', '3x2'],
    artworkCssPx: spec.cssPx,
    budgetMb: 64,
    overscanHeadroom: headroom,
  }

  const built = await buildStage(
    config,
    (e) => {
      fail(`${cell.label}: stage error event: ${e.error.message}`)
    },
    controller.signal,
  )
  if (built === pc.ABORTED) {
    fail(`${cell.label}: the stage build was aborted`)
    return null
  }
  if (built instanceof Error) {
    fail(`${cell.label}: buildStage: ${built.message}`)
    return null
  }

  try {
    // A capture taken before the tile fetch lands is a DIFFERENT render than one taken after
    // (`PaperSheet.tilesReady`'s own doc comment: "a harness that writes byte-reproducible
    // screenshots must not have a race deciding what it captured"). Cells on either side of that
    // race would not be comparable, which is the one thing this page must guarantee.
    const tiles = await built.sheet.tilesReady
    if (tiles !== true) {
      fail(`${cell.label}: tilesReady: ${tiles.message}`)
      return null
    }

    // Before the add, so `source()` fixes `frontRect` — and with it the `fit` the paper is
    // rendered into for the rest of this sprite's life — at THIS cell's values. See the
    // function's doc comment for what writing them afterwards costs.
    if (!applyKnobs(built, cell)) return null

    const sprite = await built.stage.add(spec.sampleUrl, {
      key: SPRITE_KEY,
      signal: controller.signal,
    })
    if (sprite === pc.ABORTED) {
      fail(`${cell.label}: the add was aborted`)
      return null
    }
    if (sprite instanceof Error) {
      fail(`${cell.label}: stage.add ${spec.sampleUrl}: ${sprite.message}`)
      return null
    }

    const prepared = await built.stage.prepare(sprite.key, { signal: controller.signal })
    if (prepared === pc.ABORTED) {
      fail(`${cell.label}: the re-source was aborted`)
      return null
    }
    if (prepared instanceof Error) {
      fail(`${cell.label}: stage.prepare: ${prepared.message}`)
      return null
    }

    // `contain`, like the playground's hero: the canvas is given the drawn box's own aspect
    // below, so there is nothing left to letterbox and the sub-pixel rounding between the two is
    // spent on a sub-pixel bar rather than on a sub-pixel stretch.
    const view = built.stage.view({ canvas: scratch, fit: 'contain', tag: cell.label })
    if (view instanceof Error) {
      fail(`${cell.label}: stage.view: ${view.message}`)
      return null
    }
    const shown = view.show(sprite)
    if (shown instanceof Error) {
      fail(`${cell.label}: view.show: ${shown.message}`)
      return null
    }

    const frame = view.frame
    if (frame === null) {
      fail(`${cell.label}: the view reports no frame — nothing was drawn`)
      return null
    }
    // The artwork is what is framed and the paper overflows it: `spec.cssPx` is the ARTWORK's long
    // side, so the same sprite occupies the same on-screen box in every cell however far its edge
    // reaches. See `framing.ts` for why framing the whole front instead moved the picture under
    // every parameter change.
    const framing = frameArtwork(frame, spec.cssPx)
    scratch.style.width = `${String(framing.canvas.w)}px`
    scratch.style.height = `${String(framing.canvas.h)}px`
    // The managed backing store is rewritten from `getBoundingClientRect()` DURING a draw, so the
    // box just set is only honoured by the next one. No animation is ever run: whatever pose the
    // first draw gives is what every cell is captured at.
    view.refresh()
    await nextFrame()

    const pixels = document.createElement('canvas')
    pixels.width = Math.max(1, Math.round(framing.canvas.w * CAPTURE_SCALE))
    pixels.height = Math.max(1, Math.round(framing.canvas.h * CAPTURE_SCALE))
    const ctx = pixels.getContext('2d')
    if (ctx === null) {
      fail(`${cell.label}: the capture canvas refused a 2d context`)
      return null
    }
    ctx.drawImage(scratch, 0, 0, pixels.width, pixels.height)
    framings.push({
      label: cell.label,
      image: framing.image,
      canvas: framing.canvas,
      offset: framing.offset,
    })
    return { cell, pixels, framing }
  } finally {
    // Unconditional, and before the next cell starts: this is what keeps exactly one WebGL2
    // context alive at a time.
    built.stage.dispose()
  }
}

/** The tile every cell is drawn into — one box, so the artwork lands on the same spot in all of
 *  them and the reader's eye has nothing to track but the edge. */
interface Tile {
  readonly w: number
  readonly h: number
}

/**
 * The smallest tile that holds every cell's paper with the artwork centred.
 *
 * Measured, not guessed: the reach past the artwork is a function of the frozen reserve, and the
 * plan above already made that reserve identical across the grid — but the numbers still come
 * from what the library actually drew, so a cell that reaches further than the arithmetic
 * predicted widens the tile instead of being clipped by it. Every cell then gets the SAME tile,
 * which is what makes the columns line up.
 */
function tileFor(captures: readonly Capture[], cssPx: number): Tile {
  let halfW = 0
  let halfH = 0
  let imageW = cssPx
  let imageH = cssPx
  for (const { framing } of captures) {
    imageW = Math.max(imageW, framing.image.w)
    imageH = Math.max(imageH, framing.image.h)
    const left = -framing.offset.x
    const right = framing.canvas.w + framing.offset.x - framing.image.w
    const top = -framing.offset.y
    const bottom = framing.canvas.h + framing.offset.y - framing.image.h
    halfW = Math.max(halfW, framing.image.w / 2 + Math.max(left, right))
    halfH = Math.max(halfH, framing.image.h / 2 + Math.max(top, bottom))
  }
  return {
    w: Math.ceil(Math.max(imageW, 2 * halfW) + 2 * TILE_PAD_CSS_PX),
    h: Math.ceil(Math.max(imageH, 2 * halfH) + 2 * TILE_PAD_CSS_PX),
  }
}

/** The grid's skeleton: the title, the corner, one header per column, one per row, and an empty
 *  figure per cell. Built before the first stage so a total failure still screenshots as a
 *  labelled grid of empty tiles rather than as a blank page. */
function buildSkeleton(root: HTMLElement, spec: GridSpec): CellSlot[] {
  root.replaceChildren()

  const title = document.createElement('h1')
  title.className = 'grid-title'
  title.textContent = spec.title
  root.append(title)

  const table = document.createElement('div')
  table.className = 'grid-table'
  table.style.gridTemplateColumns = `max-content repeat(${String(spec.columns.length)}, max-content)`
  root.append(table)

  const corner = document.createElement('div')
  corner.className = 'grid-corner'
  table.append(corner)
  for (const column of spec.columns) {
    const head = document.createElement('div')
    head.className = 'grid-colhead'
    head.textContent = column
    table.append(head)
  }

  const slots: CellSlot[] = []
  for (let r = 0; r < spec.rows.length; r += 1) {
    const head = document.createElement('div')
    head.className = 'grid-rowhead'
    head.textContent = spec.rows[r] ?? ''
    table.append(head)
    for (let c = 0; c < spec.columns.length; c += 1) {
      const figure = document.createElement('figure')
      figure.className = 'grid-cell'
      const canvas = document.createElement('canvas')
      canvas.className = 'grid-canvas'
      // A caption that repeats its own column header verbatim carries no information — in the
      // width grid every cell's label IS its column header, so the grid grew a whole second row
      // of text per row saying what the header above already said. It is dropped, not blanked:
      // an empty `<figcaption>` still takes the flex gap and its own line box, so the tiles would
      // stay spaced for a caption that is not there. The character grid is untouched by this,
      // and by construction: its headers are `A`/`B`/`C (default)`/`D` precisely because each row
      // varies a different knob, so no cell's label can coincide with one.
      const label = spec.cells[r * spec.columns.length + c]?.label ?? ''
      let caption: HTMLElement | null = null
      if (label !== '' && label !== spec.columns[c]) {
        caption = document.createElement('figcaption')
        caption.className = 'grid-caption'
        caption.textContent = label
      }
      figure.append(canvas)
      if (caption !== null) figure.append(caption)
      table.append(figure)
      slots.push({ figure, canvas, caption })
    }
  }
  return slots
}

/** Paint one capture into its tile, artwork centred. The offsets are `frameArtwork`'s own: the
 *  canvas's top-left relative to the artwork's, so placing the artwork places the paper. */
function paint(slot: CellSlot, tile: Tile, capture: Capture | null): void {
  const canvas = slot.canvas
  canvas.style.width = `${String(tile.w)}px`
  canvas.style.height = `${String(tile.h)}px`
  canvas.width = Math.round(tile.w * CAPTURE_SCALE)
  canvas.height = Math.round(tile.h * CAPTURE_SCALE)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  if (capture === null) {
    slot.figure.classList.add('is-failed')
    return
  }
  const { framing } = capture
  const artworkX = (tile.w - framing.image.w) / 2
  const artworkY = (tile.h - framing.image.h) / 2
  ctx.drawImage(
    capture.pixels,
    Math.round((artworkX + framing.offset.x) * CAPTURE_SCALE),
    Math.round((artworkY + framing.offset.y) * CAPTURE_SCALE),
    capture.pixels.width,
    capture.pixels.height,
  )
}

async function renderGrid(spec: GridSpec): Promise<void> {
  errors.length = 0
  framings.length = 0
  window.__gridDone = false

  const root = document.querySelector<HTMLElement>('#grid')
  if (root === null) {
    fail('edge-grid: the page has no #grid element to render into')
    window.__gridDone = true
    return
  }

  const slots = buildSkeleton(root, spec)
  if (spec.cells.length !== spec.rows.length * spec.columns.length) {
    fail(
      `edge-grid: the spec has ${String(spec.cells.length)} cells but ` +
        `${String(spec.rows.length)} rows x ${String(spec.columns.length)} columns`,
    )
  }

  const plan = planReserve(spec)
  if (plan instanceof Error) {
    fail(plan.message)
    window.__gridDone = true
    return
  }
  root.dataset['reserveRadius'] = plan.targetRadius.toFixed(2)

  const scratch = scratchCanvas()
  const captures: (Capture | null)[] = []
  // Sequential by construction — `renderCell` disposes its stage before this loop advances, so
  // exactly one WebGL2 context is ever live. `Promise.all` over the cells would build sixteen.
  for (let i = 0; i < spec.cells.length; i += 1) {
    const cell = spec.cells[i]
    if (cell === undefined) continue
    const headroom = plan.headroom[i] ?? 0
    const refusal = checkCeilings(cell, headroom)
    if (refusal !== null) fail(refusal)
    captures.push(await renderCell(spec, cell, headroom, scratch))
  }

  const drawn = captures.filter((c): c is Capture => c !== null)
  const tile = tileFor(drawn, spec.cssPx)
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]
    if (slot === undefined) continue
    paint(slot, tile, captures[i] ?? null)
  }

  // The scratch canvas has served its purpose and still holds the last cell's paper; blanking it
  // keeps it out of any screenshot that is taken of the whole page rather than of `#grid`.
  scratch.width = 1
  scratch.height = 1
  scratch.style.width = '1px'
  scratch.style.height = '1px'

  await nextFrame()
  window.__gridDone = true
}

window.__gridErrors = errors
window.__gridFraming = framings
window.__gridDone = false
window.__renderGrid = renderGrid
