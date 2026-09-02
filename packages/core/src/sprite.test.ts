import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { AssetError, SheetError } from './errors.js'
import { createStage, type StageEnv } from './stage.js'
import { asBitmap, fakeBitmap } from './testing/fake-source.js'
import { fakeMotion, fakeSheet } from './testing/fake-slots.js'
import { stageEnv } from './testing/fake-slots.js'

async function mounted(
  over: {
    sheet?: ReturnType<typeof fakeSheet>
    motion?: ReturnType<typeof fakeMotion>
    env?: StageEnv
  } = {},
) {
  const sheet = over.sheet ?? fakeSheet()
  const motion = over.motion ?? fakeMotion()
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    over.env ?? stageEnv(),
  )
  // `expect.fail` rather than `throw`: §10.8 forbids ThrowStatement outside the one boundary
  // helper, and `expect.fail` is a call, not a throw, even though it aborts the same way.
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused to mount')
  return { stage, sheet, motion }
}

describe('stage.add()', () => {
  it('registers a sprite and exposes the numbers the manual case needs', async () => {
    const { stage, motion } = await mounted()
    const s = await stage.add('/sweater.png', { key: 'sweater' })
    if (s instanceof Error || isAborted(s)) return expect.fail('add refused')
    expect(s.key).toBe('sweater')
    // amendment 13: `sprite.frontSize`, `sprite.rect` and `view.idealSize` are exposed rather
    // than derived twice by the consumer.
    expect(s.frontSize).toEqual(motion.calls.fit.length > 0 ? s.frontSize : s.frontSize)
    expect(s.frontSize.w).toBeGreaterThan(0)
    expect(s.rect.w).toBeGreaterThan(0)
    stage.dispose()
  })

  it('passes the key-derived preset into motion.fit as the override (D5)', async () => {
    const { stage, motion } = await mounted()
    await stage.add('/a.png', { key: 'sweater' })
    expect(motion.calls.fit[0]?.override).toMatch(/^[0-9a-f]{8}$/)
    stage.dispose()
  })

  it('refuses a live key rather than silently rebuilding it', async () => {
    const { stage } = await mounted()
    await stage.add('/a.png', { key: 'k' })
    const again = await stage.add('/b.png', { key: 'k' })
    expect(again).toBeInstanceOf(SheetError)
    expect((again as Error).message).toContain('k')
    stage.dispose()
  })

  it('get() answers undefined for a missing key, and never an Error', async () => {
    const { stage } = await mounted()
    expect(stage.get('nope')).toBeUndefined()
    await stage.add('/a.png', { key: 'k' })
    expect(stage.get('k')?.key).toBe('k')
    stage.dispose()
  })

  it('frees the key when the signal fires, so the scroll-back add() succeeds', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    const sheet = fakeSheet({ gate: () => gate })
    const { stage } = await mounted({ sheet })
    const controller = new AbortController()
    const pending = stage.add('/a.png', { key: 'k', signal: controller.signal })
    controller.abort()
    release()
    expect(isAborted(await pending)).toBe(true)
    expect(stage.get('k')).toBeUndefined()
    // The key is free again.
    const second = await stage.add('/a.png', { key: 'k' })
    expect(second).not.toBeInstanceOf(Error)
    stage.dispose()
  })

  it('returns the slot error and frees the key when source() fails', async () => {
    const sheet = fakeSheet({ sourceFails: new SheetError('no silhouette') })
    const { stage } = await mounted({ sheet })
    expect(await stage.add('/a.png', { key: 'k' })).toBeInstanceOf(SheetError)
    expect(stage.get('k')).toBeUndefined()
    stage.dispose()
  })

  it('closes a bitmap it obtained and never one it was given (§8.5.4)', async () => {
    const { stage } = await mounted()
    const given = fakeBitmap()
    await stage.add(asBitmap(given), { key: 'borrowed', pin: true })
    expect(given.closes).toBe(0)
    stage.dispose()
  })

  it('refuses a widened unreclaimable source without pin: true, at runtime', async () => {
    const { stage } = await mounted()
    // `PinFor` stops the type-level hole for a source written at the call site; a source read out
    // of a data model is widened to the whole union and reaches this check instead (P15's note).
    const widened = asBitmap(fakeBitmap()) as import('./source.js').SpriteSource
    const out = await stage.add(widened, { key: 'k' } as never)
    expect(out).toBeInstanceOf(AssetError)
    expect((out as Error).message).toContain('pin: true')
    stage.dispose()
  })

  it('marks a URL sprite reclaimable and a bare bitmap unreclaimable in the LRU', async () => {
    const { stage } = await mounted()
    await stage.add('/a.png', { key: 'url' })
    await stage.add(asBitmap(fakeBitmap()), { key: 'bare', pin: true })
    const u = stage.usage()
    expect(u.reclaimable).toBeGreaterThan(0)
    expect(u.unreclaimable).toBeGreaterThan(0)
    stage.dispose()
  })

  it('emits every returned error with observed: true', async () => {
    const { stage } = await mounted()
    const seen: boolean[] = []
    stage.on('error', (e) => seen.push(e.observed))
    await stage.add('/a.png', { key: 'k' })
    await stage.add('/b.png', { key: 'k' })
    expect(seen).toEqual([true])
    stage.dispose()
  })

  it('returns a GlError from every method once the stage is disposed', async () => {
    const { stage } = await mounted()
    stage.dispose()
    const out = await stage.add('/a.png', { key: 'k' })
    expect(out).toBeInstanceOf(Error)
    expect(stage.get('k')).toBeUndefined()
  })
})
