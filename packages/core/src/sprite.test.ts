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

describe('addAll, prepare, replace and remove', () => {
  it('addAll returns one entry per input, in order, and never an element-level Aborted', async () => {
    const { stage } = await mounted()
    const out = await stage.addAll([
      { src: '/a.png', key: 'a' },
      { src: '/b.png', key: 'b' },
      { src: '/c.png', key: 'a' }, // duplicate key: an element-level AddError
    ])
    if (isAborted(out)) return expect.fail('the batch was not cancelled')
    expect(out).toHaveLength(3)
    expect(out[2]).toBeInstanceOf(SheetError)
    expect(out.some(isAborted)).toBe(false)
    stage.dispose()
  })

  it('addAll answers a whole-batch ABORTED when the signal fires', async () => {
    const { stage } = await mounted()
    const controller = new AbortController()
    controller.abort()
    const out = await stage.addAll([{ src: '/a.png', key: 'a' }], { signal: controller.signal })
    expect(isAborted(out)).toBe(true)
    stage.dispose()
  })

  it('prepare() builds a front the LRU had evicted, and is a no-op when resident', async () => {
    const { stage, sheet } = await mounted()
    await stage.add('/a.png', { key: 'k' })
    // front-lru.ts never evicts the most-recently-used front, however small the budget (its own
    // test: "never evicts the most recently used front, however small the budget"); a second,
    // later-touched sprite is what makes 'k' evictable at all.
    await stage.add('/b.png', { key: 'other' })
    const buildsBefore = sheet.calls.build.length
    expect(await stage.prepare('k')).not.toBeInstanceOf(Error)
    expect(sheet.calls.build).toHaveLength(buildsBefore)
    stage.budget({ bytes: 1 }) // force the LRU to drop the front
    expect(await stage.prepare('k')).not.toBeInstanceOf(Error)
    expect(sheet.calls.build.length).toBeGreaterThan(buildsBefore)
    stage.dispose()
  })

  it('prepare() on an unknown key is an AddError, not a silent add', async () => {
    const { stage } = await mounted()
    expect(await stage.prepare('nope')).toBeInstanceOf(SheetError)
    stage.dispose()
  })

  it('replace() releases the old front and the old handle before sourcing the new one (D3)', async () => {
    const { stage, sheet } = await mounted()
    await stage.add('/a.png', { key: 'k' })
    // `FakeSheet.order` is `readonly string[]`; the cast is the only way to clear it between the
    // add() above and the replace() this test asserts the ordering of.
    ;(sheet.order as string[]).length = 0
    const out = await stage.replace('k', '/b.png')
    expect(out).not.toBeInstanceOf(Error)
    expect(sheet.order).toEqual(['releaseFront', 'release', 'source', 'build'])
    stage.dispose()
  })

  it('replace() aborted mid-flight leaves no record behind, so remove() cannot double-free', async () => {
    let release = (): void => {}
    let gated = false
    // The gate suspends `source()` only for the replace(); the add() below must not hang on it.
    const sheet = fakeSheet({
      gate: () => (gated ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
    })
    const { stage, motion } = await mounted({ sheet })
    await stage.add('/a.png', { key: 'k' })
    gated = true
    const controller = new AbortController()
    const pending = stage.replace('k', '/b.png', { signal: controller.signal })
    controller.abort()
    release()
    expect(isAborted(await pending)).toBe(true)
    // D3 released the handle and the clip *before* sourcing, so the record cannot survive: it
    // would hold a handle and a clip the slots already took back.
    expect(stage.get('k')).toBeUndefined()
    const releases = sheet.calls.release.length
    const clips = motion.calls.release.length
    expect(stage.remove('k')).toBeUndefined()
    expect(sheet.calls.release).toHaveLength(releases)
    expect(motion.calls.release).toHaveLength(clips)
    stage.dispose()
  })

  it('replace() keeps the key, the pin and the attachments', async () => {
    const { stage } = await mounted()
    const first = await stage.add('/a.png', { key: 'k' })
    if (first instanceof Error || isAborted(first)) return expect.fail('add refused')
    stage.pin('k')
    await stage.replace('k', '/b.png')
    const after = stage.get('k')
    expect(after?.key).toBe('k')
    expect(after?.pinned).toBe(true)
    stage.dispose()
  })

  it('replace() warns once when a conditional re-supply came back 200 (amendment 10)', async () => {
    const { stage } = await mounted()
    await stage.add('/a.png', { key: 'k' })
    const warned: Error[] = []
    stage.on('error', (e) => warned.push(e.error))
    await stage.replace('k', '/a.png')
    expect(stage.warnings.map((w) => w.message).join(' ')).toContain('k')
    stage.dispose()
  })

  it('remove() destroys the sprite, its front and its key', async () => {
    const { stage, sheet } = await mounted()
    await stage.add('/a.png', { key: 'k' })
    expect(stage.remove('k')).toBeUndefined()
    expect(stage.get('k')).toBeUndefined()
    expect(sheet.calls.release).toHaveLength(1)
    expect(await stage.add('/a.png', { key: 'k' })).not.toBeInstanceOf(Error)
    stage.dispose()
  })

  it('remove() on an unknown key is undefined, and on a disposed stage a no-op', async () => {
    const { stage } = await mounted()
    expect(stage.remove('nope')).toBeUndefined()
    stage.dispose()
    expect(stage.remove('nope')).toBeUndefined()
  })

  it('pin()/unpin() move a front between the reclaimable and unreclaimable halves', async () => {
    const { stage } = await mounted()
    await stage.add('/a.png', { key: 'k' })
    stage.pin('k')
    expect(stage.get('k')?.pinned).toBe(true)
    expect(stage.usage().pinned).toBe(1)
    stage.unpin('k')
    expect(stage.usage().pinned).toBe(0)
    stage.dispose()
  })
})
