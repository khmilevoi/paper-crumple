import { describe, expect, it, vi } from 'vitest'
import { ABORTED } from './abort.js'
import { createErrorPolicy } from './error-policy.js'
import { GlError, SheetError } from './errors.js'
import type { StageEvent } from './events.js'

function harness(listeners = 0) {
  const seen: Array<StageEvent<'error'>> = []
  const log = vi.fn()
  const bus = {
    emit: (_e: 'error', payload: StageEvent<'error'>) => void seen.push(payload),
    listenerCount: () => listeners,
  } as unknown as Parameters<typeof createErrorPolicy>[0]['bus']
  return { seen, log, policy: createErrorPolicy({ bus, log }) }
}

describe('the error policy', () => {
  it('emits a returned Error with observed: true and passes it through unchanged', () => {
    const h = harness(1)
    const err = new SheetError('no')
    expect(h.policy.returned(err, null)).toBe(err)
    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]?.error).toBe(err)
    expect(h.seen[0]?.observed).toBe(true)
    expect(h.seen[0]?.view).toBeNull()
  })

  it('emits an orphan with observed: false', () => {
    const h = harness(1)
    const err = new GlError('dropped a frame inside a timer')
    h.policy.orphan(err, null)
    expect(h.seen[0]?.observed).toBe(false)
  })

  it('never emits a returned ABORTED, and passes it through', () => {
    const h = harness(1)
    expect(h.policy.returned(ABORTED, null)).toBe(ABORTED)
    expect(h.seen).toHaveLength(0)
  })

  it('never emits a returned non-Error value', () => {
    const h = harness(1)
    expect(h.policy.returned(42, null)).toBe(42)
    expect(h.policy.returned(undefined, null)).toBeUndefined()
    expect(h.seen).toHaveLength(0)
  })

  it('logs once, and only for an orphan, when nothing is subscribed', () => {
    const h = harness(0)
    h.policy.orphan(new GlError('a'), null)
    h.policy.orphan(new GlError('b'), null)
    expect(h.log).toHaveBeenCalledTimes(1)
  })

  it('never logs a returned error, however loud it is, when nothing is subscribed', () => {
    const h = harness(0)
    h.policy.returned(new SheetError('handled and narrowed by the caller'), null)
    expect(h.log).not.toHaveBeenCalled()
  })

  it('carries the view, so an error event and a stage.play entry correlate', () => {
    const h = harness(1)
    const view = { tag: 'tile-7' } as never
    h.policy.returned(new SheetError('x'), view)
    expect(h.seen[0]?.view).toBe(view)
  })
})
