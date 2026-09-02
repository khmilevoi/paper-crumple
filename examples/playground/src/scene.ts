import * as pc from '@paper-crumple/core'
import type { BuiltStage } from './config'
import type { Sample } from './samples'

const HERO_SLOT = 'hero-slot'

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
  slot.append(canvas)
  return canvas
}

export async function mountHero(
  built: BuiltStage,
  sample: Sample,
  signal: AbortSignal,
): Promise<{ view: pc.View; sprite: pc.Sprite } | Error | pc.Aborted> {
  const canvas = heroCanvas(built)
  if (canvas instanceof Error) return canvas

  if (built.present === 'direct') {
    // One surface, one rect. `add` then `view` then `show` — which is what `mount` composes,
    // spelled out because `mount` takes a canvas and a direct view takes a rect. `tag` lives on
    // the view target, not on `add`'s options — `AddOptions` has no `tag` field.
    const sprite = await built.stage.add(sample.url, { key: sample.id })
    if (sprite === pc.ABORTED) return pc.ABORTED
    if (sprite instanceof Error) return sprite
    const rect = { x: 0, y: 0, w: built.stage.surface.width, h: built.stage.surface.height }
    const view = built.stage.view({ rect, tag: sample.id })
    if (view instanceof Error) return view
    const shown = view.show(sprite)
    if (shown instanceof Error) return shown
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
  return { view, sprite }
}
