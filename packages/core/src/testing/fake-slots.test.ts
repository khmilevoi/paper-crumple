import { describe, expect, it } from 'vitest'
import { isAborted } from '../abort.js'
import { SheetError } from '../errors.js'
import { fakeGlContext, fakeMotion, fakeSheet } from './fake-slots.js'
import { asBitmap, fakeBitmap } from './fake-source.js'

/** The resolved sheet knobs `build()` requires. The two colour knobs have no default here because
 * the resolved bag is by definition already resolved — a fake is driven with real values. */
const sheetKnobs = { paperColor: '#ffffff', paperBack: '#eeeeee' } as const

describe('the fake slots', () => {
  it('satisfy the two contracts and record every call', async () => {
    const ctx = fakeGlContext()
    const sheet = fakeSheet()
    const motion = fakeMotion()
    expect(sheet.mount(ctx)).toBeUndefined()
    expect(motion.mount(ctx)).toBeUndefined()

    const handle = await sheet.source(asBitmap(fakeBitmap({ width: 40, height: 20 })), {
      maxSize: 128,
      exact: false,
    })
    if (handle instanceof Error || isAborted(handle)) return expect.fail('source refused')
    expect(handle.rect).toEqual({ x: 0, y: 0, w: 40, h: 20 })
    expect(sheet.calls.source).toHaveLength(1)

    const front = sheet.build(handle, { w: 64, h: 32 }, sheetKnobs)
    if (front instanceof Error) return expect.fail(front.message)
    expect(front.bytes).toBe(64 * 32 * 4)
    expect(sheet.calls.build).toHaveLength(1)
  })

  it('fit() is pure, carries the override into sortKey, and load() is cancellable', async () => {
    const motion = fakeMotion()
    const fit = motion.fit({ x: 0, y: 0, w: 40, h: 20 }, 'deadbeef')
    if (fit instanceof Error) return expect.fail(fit.message)
    expect(fit.sortKey).toContain('deadbeef')
    expect(motion.calls.fit[0]?.override).toBe('deadbeef')

    const controller = new AbortController()
    controller.abort()
    expect(isAborted(await motion.load(fit, { signal: controller.signal }))).toBe(true)
  })

  it('can be told to fail, so a rollback path has something to roll back from', async () => {
    const sheet = fakeSheet({ sourceFails: new SheetError('nope') })
    const out = await sheet.source(asBitmap(fakeBitmap()), { maxSize: 64, exact: false })
    expect(out).toBeInstanceOf(SheetError)
  })

  it('records release and releaseFront so the replace() ordering is assertable', async () => {
    const sheet = fakeSheet()
    const handle = await sheet.source(asBitmap(fakeBitmap()), { maxSize: 64, exact: false })
    if (handle instanceof Error || isAborted(handle)) return expect.fail('source refused')
    const front = sheet.build(handle, { w: 8, h: 8 }, sheetKnobs)
    if (front instanceof Error) return expect.fail(front.message)
    sheet.releaseFront(front)
    sheet.release(handle)
    expect(sheet.order).toEqual(['source', 'build', 'releaseFront', 'release'])
  })

  it('the fake context runs scope() and reports caps', () => {
    const ctx = fakeGlContext({ maxTextureSize: 2048 })
    expect(ctx.caps.maxTextureSize).toBe(2048)
    const inside = ctx.scope((s) => {
      s.enable('SCISSOR_TEST', true)
      return 'ran'
    })
    expect(inside).toBe('ran')
    expect(ctx.scopes).toBe(1)
  })
})
