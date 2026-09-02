import { describe, expect, it, vi } from 'vitest'
import { isAborted } from './abort.js'
import { GlError, SheetError, ViewError } from './errors.js'
import { createStage } from './stage.js'
import { fakeGlContext, fakeMotion, fakeSheet, stageEnv } from './testing/fake-slots.js'

/** The smallest object `size: 'managed'` and the blit need out of a destination canvas. */
function destCanvas(css = { width: 150, height: 75 }) {
  const ops: string[] = []
  const ctx2d = {
    clearRect: (...a: number[]) => ops.push(`clearRect(${a.join(',')})`),
    drawImage: (...a: unknown[]) => ops.push(`drawImage(${a.slice(1).join(',')})`),
  }
  const canvas = {
    width: 300,
    height: 150,
    ops,
    getContext: (id: string) => (id === '2d' ? ctx2d : null),
    getBoundingClientRect: () => ({ width: css.width, height: css.height }),
  }
  return canvas as unknown as HTMLCanvasElement & { ops: string[] }
}

async function blitStage(over: Parameters<typeof fakeMotion>[0] = {}) {
  const sheet = fakeSheet()
  const motion = fakeMotion(over)
  const stage = await createStage({ sheet, motion, maxSize: 384, present: 'blit' }, stageEnv())
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  return { stage, sheet, motion }
}

describe('stage.view()', () => {
  it('registers a view in registration order and exposes tag and idealSize', async () => {
    const { stage } = await blitStage()
    const a = stage.view({ canvas: destCanvas(), tag: 'tile-0' })
    const b = stage.view({ canvas: destCanvas(), tag: 'tile-1' })
    if (a instanceof Error || b instanceof Error) return expect.fail('view refused')
    expect(stage.views).toEqual([a, b])
    expect(a.tag).toBe('tile-0')
    expect(a.sprite).toBeNull()
    expect(a.run).toBeNull()
    expect(a.state).toBe('idle')
    expect(a.pose).toBe(0)
    stage.dispose()
  })

  it('refuses a second view on one element: two views blitting into one canvas is a flicker', async () => {
    const { stage } = await blitStage()
    const el = destCanvas()
    stage.view({ canvas: el })
    expect(stage.view({ canvas: el })).toBeInstanceOf(ViewError)
    stage.dispose()
  })

  it('refuses an element that already carries a non-2D context', async () => {
    const { stage } = await blitStage()
    const el = destCanvas()
    ;(el as unknown as { getContext: () => null }).getContext = () => null
    expect(stage.view({ canvas: el })).toBeInstanceOf(ViewError)
    stage.dispose()
  })

  it('lets the element be re-used once the first view is disposed — StrictMode does not trip', async () => {
    const { stage } = await blitStage()
    const el = destCanvas()
    const first = stage.view({ canvas: el })
    if (first instanceof Error) return expect.fail('view refused')
    first.dispose()
    expect(stage.view({ canvas: el })).not.toBeInstanceOf(Error)
    stage.dispose()
  })

  it('show() draws once at pose 0 and attaches the sprite as a refcount', async () => {
    const { stage, motion } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    expect(view.show(sprite)).toBeUndefined()
    expect(view.sprite).toBe(sprite)
    expect(view.pose).toBe(0)
    expect(motion.calls.draw).toHaveLength(1)
    expect(motion.calls.draw[0]?.frame).toBe(0)
    expect(sprite.attachCount).toBe(1)
    stage.dispose()
  })

  it('show(null) detaches, and is a no-op on a disposed stage', async () => {
    const { stage } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    view.show(null)
    expect(view.sprite).toBeNull()
    expect(sprite.attachCount).toBe(0)
    stage.dispose()
    expect(view.show(null)).toBeUndefined()
  })

  it('clears the destination before drawImage, so a narrow successor leaves no edges', async () => {
    const { stage } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const el = destCanvas()
    // `size: 'manual'` here — under the default `managed` sizing the fake front (40x30) is
    // always smaller than `stageEnv()`'s dpr-scaled CSS size on both axes, so the managed cap
    // collapses the destination to exactly the front and 'contain' never letterboxes; the leaked-
    // edges bug this test pins is only observable when the backing store does not track the
    // front 1:1, which `size: 'manual'` reproduces without touching `blit.ts`'s own semantics
    // (pinned separately in `blit.test.ts`).
    const view = stage.view({ canvas: el, fit: 'contain', size: 'manual' })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    expect(el.ops.filter((o) => o.startsWith('clearRect')).length).toBeGreaterThan(0)
    expect(el.ops.indexOf(el.ops.find((o) => o.startsWith('drawImage')) ?? '')).toBeGreaterThan(0)
    stage.dispose()
  })

  it("size: 'managed' sets the backing store to round(cssSize x dpr), capped at the front", async () => {
    const { stage } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const el = destCanvas({ width: 100, height: 50 })
    const view = stage.view({ canvas: el })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    // stageEnv()'s dpr is 2, and the fake front is 40x30, so the cap bites on both axes.
    expect(el.width).toBe(Math.min(200, sprite.frontSize.w))
    stage.dispose()
  })

  it("size: 'manual' never touches the backing store", async () => {
    const { stage } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const el = destCanvas()
    const view = stage.view({ canvas: el, size: 'manual' })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    expect(el.width).toBe(300)
    expect(el.height).toBe(150)
    stage.dispose()
  })

  it('leaves a hidden element alone rather than resizing it to zero', async () => {
    const { stage } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const el = destCanvas({ width: 0, height: 0 })
    const view = stage.view({ canvas: el })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    expect(el.width).toBe(300)
    stage.dispose()
  })

  it('refresh() and draw() redraw without a run and without emitting (amendment 15)', async () => {
    const { stage, motion } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    const events: string[] = []
    view.on('start', () => events.push('start'))
    view.on('step', () => events.push('step'))
    view.on('end', () => events.push('end'))
    view.refresh()
    view.draw(3)
    expect(events).toEqual([])
    expect(view.run).toBeNull()
    expect(view.state).toBe('idle')
    expect(view.pose).toBe(3)
    expect(motion.calls.draw).toHaveLength(3)
    stage.dispose()
  })

  it('draw() resolves a PoseRef and reports a resolved number', async () => {
    const { stage } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    view.draw('ball')
    expect(view.pose).toBe(5)
    expect(typeof view.pose).toBe('number')
    stage.dispose()
  })

  it('scissors the clear to the view rect and disables STENCIL_TEST for the draw', async () => {
    const sheet = fakeSheet()
    const motion = fakeMotion()
    // The spies must sit on the very context the stage draws into, so this env hands out a
    // fixed one rather than `stageEnv()`'s fresh-per-stage default.
    const ctx = fakeGlContext()
    const env = stageEnv({ makeContext: () => ctx })
    const scissor = vi.spyOn(ctx.gl, 'scissor')
    const disable = vi.spyOn(ctx.gl, 'disable')
    const stage = await createStage({ sheet, motion, maxSize: 384, present: 'direct' }, env)
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const view = stage.view({ rect: { x: 10, y: 20, w: 30, h: 40 } })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(sprite)
    expect(scissor).toHaveBeenCalledWith(10, 20, 30, 40)
    expect(disable).toHaveBeenCalled()
    stage.dispose()
  })

  it('reports a dropped frame from the slot as an orphan error and keeps the last good front', async () => {
    const { stage } = await blitStage({ drawFails: new GlError('the draw dropped a frame') })
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    const seen: boolean[] = []
    stage.on('error', (e) => seen.push(e.observed))
    view.refresh()
    view.show(sprite)
    expect(seen).toContain(false)
    stage.dispose()
  })

  it('every call on a disposed view is refused and emits nothing', async () => {
    const { stage } = await blitStage()
    const sprite = await stage.add('/a.png', { key: 'k' })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    view.dispose()
    view.dispose() // idempotent
    expect(view.state).toBe('disposed')
    expect(view.show(sprite)).toBeInstanceOf(SheetError)
    expect(view.refresh()).toBeUndefined()
    expect(stage.views).toEqual([])
    stage.dispose()
  })
})
