/**
 * @vitest-environment jsdom
 */
import { ABORTED } from '@paper-crumple/core'
import type { StageEvent } from '@paper-crumple/core'
import { describe, expect, it, vi } from 'vitest'
import { createFakeStage } from './fake-stage.js'

describe('createFakeStage (§9)', () => {
  it('starts clean: no warnings, not lost, no views, not disposed', () => {
    const fake = createFakeStage()
    expect(fake.stage.warnings).toEqual([])
    expect(fake.stage.lost).toBe(false)
    expect(fake.stage.views).toEqual([])
    expect(fake.disposed).toBe(false)
  })

  it('claims a canvas, refuses a second view on it, and releases it on dispose', () => {
    const fake = createFakeStage()
    const canvas = document.createElement('canvas')
    const first = fake.stage.view({ canvas })
    expect(first).not.toBeInstanceOf(Error)
    const second = fake.stage.view({ canvas })
    expect(second).toBeInstanceOf(Error)
    expect((second as Error).name).toBe('ViewError')
    fake.views[0]?.view.dispose()
    expect(fake.stage.view({ canvas })).not.toBeInstanceOf(Error)
  })

  it('logs every call in order, stage and view alike', () => {
    const fake = createFakeStage({ sprites: ['hero'] })
    const canvas = document.createElement('canvas')
    fake.stage.view({ canvas })
    const handle = fake.views[0]
    if (handle === undefined) return expect.unreachable('the view was not created')
    handle.view.show(fake.sprites.get('hero') ?? null)
    handle.view.refresh()
    expect(fake.calls.map((c) => c.method)).toEqual(['view', 'view.show', 'view.refresh'])
  })

  it('on() delivers a stage event and the unsubscribe stops it', () => {
    const fake = createFakeStage()
    const seen = vi.fn()
    const off = fake.stage.on('error', seen)
    const payload: StageEvent<'error'> = { error: new Error('boom'), observed: false, view: null }
    fake.emit('error', payload)
    expect(seen).toHaveBeenCalledWith(payload)
    off()
    fake.emit('error', payload)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it("a view's bus carries start, step and end only — error on it is silently dead (§5.5)", () => {
    const fake = createFakeStage()
    fake.stage.view({ canvas: document.createElement('canvas') })
    const handle = fake.views[0]
    if (handle === undefined) return expect.unreachable('the view was not created')
    const onEnd = vi.fn()
    const onError = vi.fn()
    handle.view.on('end', onEnd)
    handle.view.on('error', onError)
    handle.emit('end', { from: 0, to: 1, completed: true })
    fake.emit('error', { error: new Error('boom'), observed: false, view: handle.view })
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('lose() flips lost and emits lost then an orphaned error, in that order', () => {
    const fake = createFakeStage()
    const order: string[] = []
    fake.stage.on('lost', () => order.push('lost'))
    fake.stage.on('error', (e) => {
      order.push('error')
      expect(e.view).toBeNull()
      expect(e.error.name).toBe('GlError')
    })
    fake.lose()
    expect(fake.stage.lost).toBe(true)
    expect(order).toEqual(['lost', 'error'])
  })

  it('set logs one call per invocation and honours a refusal', () => {
    const fake = createFakeStage()
    const refusal = new Error('bad knob')
    fake.refuseKnob('b', refusal)
    expect(fake.stage.set({ a: 1 } as never)).toBeUndefined()
    expect(fake.stage.set({ b: 2 } as never)).toBe(refusal)
    expect(fake.calls.filter((c) => c.method === 'set')).toHaveLength(2)
  })

  it('prepare returns the resident sprite and a SheetError for an unknown key', async () => {
    const fake = createFakeStage({ sprites: ['hero'] })
    await expect(fake.stage.prepare('hero')).resolves.toBe(fake.sprites.get('hero'))
    const missing = await fake.stage.prepare('ghost')
    expect(missing).toBeInstanceOf(Error)
    expect((missing as Error).name).toBe('SheetError')
  })

  it('a supplied prepare overrides the default and is awaited', async () => {
    const fake = createFakeStage({ sprites: ['hero'], prepare: async () => ABORTED })
    await expect(fake.stage.prepare('hero')).resolves.toBe(ABORTED)
  })

  it('a run settles through the handle and stop() settles it aborted', async () => {
    const fake = createFakeStage()
    fake.stage.view({ canvas: document.createElement('canvas') })
    const handle = fake.views[0]
    if (handle === undefined) return expect.unreachable('the view was not created')
    const run = handle.view.play('flat', 'ball')
    handle.settleRun(undefined)
    await expect(run.done).resolves.toBeUndefined()
    const second = handle.view.play('ball', 'flat')
    second.stop()
    await expect(second.done).resolves.toBe(ABORTED)
  })

  it('dispose() disposes every view and is idempotent (§4.6)', () => {
    const fake = createFakeStage()
    fake.stage.view({ canvas: document.createElement('canvas') })
    fake.stage.dispose()
    fake.stage.dispose()
    expect(fake.disposed).toBe(true)
    expect(fake.views[0]?.disposed).toBe(true)
    expect(fake.calls.filter((c) => c.method === 'dispose')).toHaveLength(1)
  })

  it('view() on a disposed stage returns a ViewError rather than a view', () => {
    const fake = createFakeStage()
    fake.stage.dispose()
    const result = fake.stage.view({ canvas: document.createElement('canvas') })
    expect(result).toBeInstanceOf(Error)
  })

  it('pushWarning grows the same array stage.warnings returns', () => {
    const fake = createFakeStage()
    const warnings = fake.stage.warnings
    fake.pushWarning(new Error('one'))
    expect(warnings).toHaveLength(1)
    expect(fake.stage.warnings).toHaveLength(1)
  })

  it('returns a real zeroed usage shape rather than a cast empty object', () => {
    const fake = createFakeStage()
    expect(fake.stage.usage()).toEqual({
      bytes: 0,
      reclaimable: 0,
      unreclaimable: 0,
      fronts: 0,
      pinned: 0,
      attached: 0,
      handles: 0,
    })
  })

  it('documents its run limits in behavior: view.run is null and settleRun reaches latest only', async () => {
    const fake = createFakeStage()
    const view = fake.stage.view({ canvas: document.createElement('canvas') })
    if (view instanceof Error) return expect.unreachable('the view was not created')
    const first = view.play('flat', 'ball')
    const second = view.play('ball', 'flat')
    let firstSettled = false
    void first.done.then(() => {
      firstSettled = true
    })
    expect(view.run).toBeNull()
    fake.views[0]?.settleRun(undefined)
    await expect(second.done).resolves.toBeUndefined()
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    first.stop()
  })
})
