import * as pc from '@paper-crumple/core'
import type { BuiltStage } from './config'
import { frameArtwork } from './framing'
import { SAMPLES, type Sample } from './samples'

/**
 * Mounting the one hero view the design's stage shows.
 *
 * The mockup's stage holds a single sheet and nothing else, so this module mounts one view and
 * stops — the six-tile broadcast grid the pre-React playground also mounted here has no
 * counterpart in `Paper Crumple Control Panel v2.dc.html` and is gone with it.
 *
 * React owns the slot element; the canvas inside it is owned here, because which canvas the
 * library wants depends on `present`: `blit` supplies its own 2D canvas per view and the stage
 * blits into it, while `direct` has one surface — the stage's own — and a view is a rect of it,
 * so the element appended in that mode is the stage's canvas rather than one made here.
 *
 * The canvas's *box* is owned here too, and `View.frame` decides it: the slot is the artwork's
 * own rectangle and never changes size for a given source, while the canvas is positioned over
 * it and reaches however far past it the paper does. See `framing.ts` for why a fixed `cssPx`
 * square was moving the picture under every parameter change.
 */

export interface MountedHero {
  readonly view: pc.View
  readonly sprite: pc.Sprite
  /** The element the library paints into — kept so a swap can re-frame it in place. */
  readonly canvas: HTMLCanvasElement
  /** How long `add()` took — the front bake, which is where the hull is built in `hull` mode. */
  readonly addMs: number
  /** How long the whole mount took: add + view + show. */
  readonly mountMs: number
  /** The prefetches `prefetchSamples` started and has not seen settle — the click holds one. */
  readonly prefetched: Prefetched
}

export interface FrameHeroRequest {
  readonly view: pc.View
  readonly slot: HTMLElement
  readonly canvas: HTMLCanvasElement
  /** What the artwork's long side is to measure, on screen. */
  readonly cssPx: number
}

/**
 * Size the slot to the artwork and hang the canvas off it, from what the view reports it is
 * drawing. Returns `false` — and moves nothing — while the view has no resident front to report
 * (nothing is drawn then either, so the boxes it last had are as right as any).
 *
 * The slot is the grid item the design's stage centres, so keeping it at the artwork's box is
 * what pins the picture; the canvas is taken out of flow so that growing it — which every edge
 * parameter does — moves nothing. Idempotent: it reads the view's *current* frame, so it is
 * called again whenever that may have changed — a swap's step, a hull-tier write once its
 * re-source has landed — and never needs to remember anything between calls.
 */
export function frameHero(o: FrameHeroRequest): boolean {
  const frame = o.view.frame
  if (frame === null) return false
  const framing = frameArtwork(frame, o.cssPx)
  // The slot's class belongs to React, which renders it; only the box is written from here.
  o.slot.style.width = `${String(framing.image.w)}px`
  o.slot.style.height = `${String(framing.image.h)}px`
  // The display size is set HERE, and deliberately not left to follow the backing store.
  //
  // `blitOut`'s default `size: 'managed'` re-reads `getBoundingClientRect()` on *every draw* and
  // writes `canvas.width`/`height` from it (`core`'s managed branch, `blit.ts`'s
  // `managedBackingStore`: `min(round(cssDim * dpr), frontDim)`). A canvas with no CSS size takes
  // its layout size from those same attributes, so the two feed each other and every draw
  // multiplies the element by `devicePixelRatio`: measured at dpr 1.5, +1.28 % per blit, climbing
  // until it hit `front.h` — roughly eight folds. That is the canvas "growing and shifting" while
  // a run plays, and because it is per *draw* rather than per run, even a draw-only pose scrub
  // did it.
  //
  // The CSS box carries the drawn box's own aspect, so under `fit: 'contain'` the blit adds no
  // bars beyond the sub-pixel rounding between the two, and the frame's pixels map onto CSS
  // pixels by the one scale `frameArtwork` used.
  o.canvas.style.width = `${String(framing.canvas.w)}px`
  o.canvas.style.height = `${String(framing.canvas.h)}px`
  o.canvas.style.left = `${String(framing.offset.x)}px`
  o.canvas.style.top = `${String(framing.offset.y)}px`
  return true
}

/**
 * How long the fallback waits when the browser has no `requestIdleCallback` (Safari shipped it
 * only in 18.4). Long enough that the hero's first frames are on screen before a prefetch takes
 * the lane, short enough to be finished before a reader has read the swap panel.
 */
const PREFETCH_IDLE_FALLBACK_MS = 200

/** `requestIdleCallback`, or a timeout where the browser has none. */
function atIdle(fn: () => void): void {
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(
      () => {
        fn()
      },
      { timeout: PREFETCH_IDLE_FALLBACK_MS },
    )
    return
  }
  globalThis.setTimeout(fn, PREFETCH_IDLE_FALLBACK_MS)
}

/** The prefetches still in flight, by sample id — each entry lives as long as its add is pending. */
export type Prefetched = ReadonlyMap<string, Promise<pc.Sprite | Error | pc.Aborted>>

/**
 * Warm the other five samples into the stage once the hero is up, so that clicking "swap" costs a
 * fold and nothing else.
 *
 * `stage.add()` enters the ingest lane in its **background** class (spec §8.10, `stage.ts`'s
 * `add` → `addAs(…, 'background')`), so these never run ahead of a front a shown view needs, and
 * the lane yields to the platform scheduler between a job's phases — five ingests in the
 * background do not become one long task. The promises are kept, and that is the point: when the
 * reader clicks, `App.tsx` asks `stage.get(id)` for a landed prefetch — a `crumpleTo` on a
 * resident sprite, no ingest left to pay for — and, failing that, this map for one still in
 * flight, whose promise the `crumpleTo` holds (§4.5's `hold`): the add is promoted to the head of
 * the lane and adopted when it lands, with no second ingest. `view.swapTo(url)` on a key whose
 * prefetch is in flight would queue a second ingest of the same image behind the running one, so
 * the click takes it only for a key that was never prefetched, or whose prefetch failed.
 *
 * Keyed on `sample.id`, the same key `mountHero` uses, and the mounted sample is skipped: `add()`
 * on a live key is refused by design (§4.1) and would only fill the status pill.
 *
 * An entry is dropped the moment its add settles: from there `stage.get(id)` is the truth — the
 * sprite (whose front the LRU may drop and `crumpleTo` rebuilds), or nothing for an add that
 * failed, which sends the click to `view.swapTo(url)` — exactly what the playground did before.
 */
export function prefetchSamples(
  built: BuiltStage,
  mounted: Sample,
  signal: AbortSignal,
): Prefetched {
  const pending = new Map<string, Promise<pc.Sprite | Error | pc.Aborted>>()
  const rest = SAMPLES.filter((s) => s.id !== mounted.id)
  if (rest.length === 0) return pending
  atIdle(() => {
    // The stage is disposed on unmount, and a disposed stage answers an Error rather than the
    // `ABORTED` the signal check further in would give; asking the signal first keeps a
    // torn-down build silent.
    if (signal.aborted) return
    for (const sample of rest) {
      const add = built.stage.add(sample.url, { key: sample.id, signal })
      pending.set(sample.id, add)
      void add.then(() => pending.delete(sample.id))
    }
  })
  return pending
}

function heroCanvas(built: BuiltStage, slot: HTMLElement): HTMLCanvasElement | Error {
  slot.replaceChildren()

  if (built.present === 'direct') {
    const own = built.stage.surface.canvas
    if (!(own instanceof HTMLCanvasElement)) {
      return new Error('playground: a direct stage must own an HTMLCanvasElement surface')
    }
    own.className = 'stage-canvas'
    slot.append(own)
    return own
  }

  const canvas = document.createElement('canvas')
  canvas.className = 'stage-canvas'
  slot.append(canvas)
  return canvas
}

export async function mountHero(
  built: BuiltStage,
  sample: Sample,
  slot: HTMLElement,
  signal: AbortSignal,
): Promise<MountedHero | Error | pc.Aborted> {
  const startedAt = performance.now()
  const canvas = heroCanvas(built, slot)
  if (canvas instanceof Error) return canvas

  if (built.present === 'direct') {
    // One surface, one rect, and the surface must be sized to its final layout **before any view
    // exists**: a view's rect is resolved once, at `stage.view()`, and never recomputed, so
    // resizing afterward would leave the rect stale while the surface — and, under a
    // bottom-left-origin WebGL buffer, where that rect actually paints — moves out from under it.
    // With only the hero left to place, that layout is one square at the origin.
    const side = Math.max(1, Math.floor(built.stage.surface.width))
    const resized = built.stage.resize(side, side)
    if (resized instanceof Error) return resized

    const addedAt = performance.now()
    const sprite = await built.stage.add(sample.url, { key: sample.id, signal })
    if (sprite === pc.ABORTED) return pc.ABORTED
    if (sprite instanceof Error) return sprite
    const addMs = performance.now() - addedAt
    const prefetched = prefetchSamples(built, sample, signal)

    const view = built.stage.view({ rect: { x: 0, y: 0, w: side, h: side }, tag: sample.id })
    if (view instanceof Error) return view
    const shown = view.show(sprite)
    if (shown instanceof Error) return shown
    // The frame exists once the view shows a resident front, so the box is set after `show()`
    // and the surface is a fixed square that no CSS box can resize — one draw is enough here.
    frameHero({ view, slot, canvas, cssPx: built.artworkCssPx })
    return { view, sprite, canvas, addMs, mountMs: performance.now() - startedAt, prefetched }
  }

  // `add` + `view` + `show` spelled out rather than the `mount` that composes exactly those
  // three: the front bake is the expensive one and the only one that is interesting on its own,
  // and a single `mount` call cannot be timed apart from the two cheap steps after it.
  const addedAt = performance.now()
  const sprite = await built.stage.add(sample.url, { key: sample.id, signal })
  if (sprite === pc.ABORTED) return pc.ABORTED
  if (sprite instanceof Error) return sprite
  const addMs = performance.now() - addedAt
  const prefetched = prefetchSamples(built, sample, signal)

  // `contain` and not `stretch`: `frameHero` gives the element the drawn box's own aspect, so
  // there is nothing left to letterbox — but the two differ by the sub-pixel rounding between
  // them, and `contain` spends that on a sub-pixel bar rather than on a sub-pixel stretch.
  const view = built.stage.view({ canvas, fit: 'contain', tag: sample.id })
  if (view instanceof Error) return view
  const shown = view.show(sprite)
  if (shown instanceof Error) return shown
  // `show()` drew into the element at whatever box it had — the frame only exists once a front
  // is shown — so the box is set from that frame now, and one event-free redraw lets the managed
  // backing store, which is written from `getBoundingClientRect()` during a draw, catch up.
  if (frameHero({ view, slot, canvas, cssPx: built.artworkCssPx })) view.refresh()

  return { view, sprite, canvas, addMs, mountMs: performance.now() - startedAt, prefetched }
}

/**
 * The renderer string the design's diagnostics footer prints.
 *
 * `getContext('webgl2')` on a canvas that already has a WebGL2 context returns that same context
 * — it does not create a second one — so this reads the live stage's own driver rather than
 * standing up a throwaway context to ask. `WEBGL_debug_renderer_info` is absent in browsers that
 * mask it, and the unmasked string is the whole point of the line, so its absence is said out
 * loud instead of being papered over with the masked generic value.
 */
export function glInfo(built: BuiltStage): string {
  const canvas: unknown = built.stage.surface.canvas
  const gl =
    canvas instanceof HTMLCanvasElement
      ? canvas.getContext('webgl2')
      : canvas instanceof OffscreenCanvas
        ? canvas.getContext('webgl2')
        : null
  if (gl === null) return 'renderer unavailable — no WebGL2 context on the surface'
  const ext = gl.getExtension('WEBGL_debug_renderer_info')
  if (ext === null) return 'renderer masked by the browser (WEBGL_debug_renderer_info withheld)'
  const renderer: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
  return typeof renderer === 'string' ? renderer : 'renderer unavailable'
}
