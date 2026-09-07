/**
 * # The ingest lane, at stage level (spec §8.10)
 *
 * Level-1 pins for the routing of every asynchronous sprite path — `add`, `replace`, `prepare`'s
 * re-source, §8.5's re-load row — through one stage-wide lane. The first case is the memo's §1.3
 * hazard at the fake: thirty `add(bitmap)` in one loop resolve their `acquire` on one microtask
 * checkpoint, so without the lane thirty `source()` calls run before the first `build()`, the one
 * artwork slot is taken twenty-nine times over and twenty-nine adds answer `SheetError`.
 */
import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { presetForImageId } from './preset.js'
import type { Sprite } from './sprite.js'
import { createStage } from './stage.js'
import type { StageOptions } from './stage-types.js'
import { createFakeTimers } from './testing/fake-timers.js'
import { asBitmap, fakeBitmap, type FakeBitmap } from './testing/fake-source.js'
import { fakeMotion, fakeSheet, stageEnv } from './testing/fake-slots.js'

const base = (): StageOptions => ({ sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384 })

/** A real macrotask boundary: every microtask the lane and the fakes queued has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function destCanvas() {
  return {
    width: 64,
    height: 64,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
  } as unknown as HTMLCanvasElement
}

/**
 * A gate over `fakeSheet`'s `source()`: while `closed`, every call suspends until `release()`
 * lets the oldest one through. The stage's lane runs one job at a time, so the suspended call is
 * always the running job and everything else is queued behind it.
 */
function sourceGate() {
  const waiting: Array<() => void> = []
  let closed = false
  return {
    gate: (): Promise<void> => {
      if (!closed) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiting.push(resolve)
      })
    },
    close: () => {
      closed = true
    },
    open: () => {
      closed = false
      while (waiting.length > 0) waiting.shift()?.()
    },
    release: () => {
      waiting.shift()?.()
    },
    get pending() {
      return waiting.length
    },
  }
}

describe('the ingest lane at stage level (spec §8.10)', () => {
  it('30 bitmap adds through Promise.all all succeed (memo §1.3 — the burst-bitmap pin)', async () => {
    const stage = await createStage({ ...base(), present: 'blit' }, stageEnv())
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const adds = Array.from({ length: 30 }, (_, i) =>
      stage.add(asBitmap(fakeBitmap({ width: 64 + i, height: 64 })), {
        key: `k${String(i)}`,
        pin: true,
      }),
    )
    const results = await Promise.all(adds)
    expect(results.filter((r) => r instanceof Error).map((e) => (e as Error).message)).toEqual([])
    expect(new Set(results.map((r) => JSON.stringify((r as Sprite).rect))).size).toBe(30)
    stage.dispose()
  })

  it('never two sprites between source() and build(): sheet.order pairs every source with its own build', async () => {
    const sheet = fakeSheet()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv())
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const adds = Array.from({ length: 30 }, (_, i) =>
      stage.add(asBitmap(fakeBitmap({ width: 64 + i, height: 64 })), {
        key: `k${String(i)}`,
        pin: true,
      }),
    )
    await Promise.all(adds)
    const order = sheet.order.filter((m) => m === 'source' || m === 'build')
    expect(order).toHaveLength(60)
    for (let i = 0; i < order.length; i += 2) {
      expect(order.slice(i, i + 2), `pair ${String(i / 2)}`).toEqual(['source', 'build'])
    }
    stage.dispose()
  })

  it('a superseded swapTo aborts the add it started, frees the key, and settles ABORTED after the new start', async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const shown = await stage.add('/base.png', { key: 'base' })
    if (shown instanceof Error || isAborted(shown)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas(), tag: 'tile' })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(shown)
    const events: string[] = []
    view.on('start', () => events.push('start'))
    view.on('end', () => events.push('end'))

    g.close()
    const first = view.swapTo('/a.png')
    const keyA = `swap:${presetForImageId('/a.png')}:0`
    await flush()
    // `a`'s add is the running job, suspended inside `source()`.
    expect(g.pending).toBe(1)
    expect(events).toEqual(['start'])

    const second = view.swapTo('/b.png')
    expect(events).toEqual(['start', 'end', 'start'])
    expect(isAborted(await first)).toBe(true)
    await flush()

    // Let `a`'s `source()` return: it sees the gate's abort and answers ABORTED, the lane moves on
    // to `b`, whose `source()` suspends next.
    g.release()
    await flush()
    expect(g.pending).toBe(1)
    expect(stage.get(keyA)).toBeUndefined()
    expect(sheet.calls.build).toHaveLength(1) // `base` only: `a` never reached build()

    g.open()
    await flush()
    // The key `a` was under is free again.
    const again = await stage.add('/a.png', { key: keyA })
    expect(again instanceof Error || isAborted(again)).toBe(false)
    timers.advance(10_000)
    await flush()
    expect(isAborted(await second)).toBe(false)
    stage.dispose()
  })

  it('a superseded swapTo under a caller-supplied key aborts its add and frees THAT key (§5.3)', async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const shown = await stage.add('/base.png', { key: 'base' })
    if (shown instanceof Error || isAborted(shown)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas(), tag: 'tile' })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(shown)

    g.close()
    const first = view.swapTo('/a.png', { key: 'a' })
    await flush()
    // `a`'s add is the running job, suspended inside `source()`.
    expect(g.pending).toBe(1)

    const second = view.swapTo('/b.png', { key: 'b' })
    expect(isAborted(await first)).toBe(true)
    await flush()

    g.release()
    await flush()
    expect(g.pending).toBe(1)
    // The caller's key is free again — not a minted one, the one they passed.
    expect(stage.get('a')).toBeUndefined()
    expect(sheet.calls.build).toHaveLength(1) // `base` only: `a` never reached build()

    g.open()
    await flush()
    const again = await stage.add('/a.png', { key: 'a' })
    expect(again instanceof Error || isAborted(again)).toBe(false)
    timers.advance(10_000)
    await flush()
    expect(isAborted(await second)).toBe(false)
    stage.dispose()
  })

  it('crumpleTo(add(...)) promotes the pending add ahead of a queued background add', async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const shown = await stage.add('/base.png', { key: 'base' })
    if (shown instanceof Error || isAborted(shown)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas(), tag: 'tile' })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(shown)

    const x = fakeBitmap({ width: 70 })
    const y = fakeBitmap({ width: 71 })
    const z = fakeBitmap({ width: 72 })
    g.close()
    const addX = stage.add(asBitmap(x), { key: 'x', pin: true })
    await flush()
    expect(g.pending).toBe(1)
    const addY = stage.add(asBitmap(y), { key: 'y', pin: true })
    const addZ = stage.add(asBitmap(z), { key: 'z', pin: true })
    // Promoted before `z`'s acquire has even resolved: the lane remembers the class for the key.
    const run = view.crumpleTo(addZ)
    await flush()
    g.open()
    await Promise.all([addX, addY, addZ])
    const widths = sheet.calls.source.slice(1).map((c) => c.bitmap.width)
    expect(widths).toEqual([70, 72, 71])
    view.stop()
    expect(isAborted(await run)).toBe(true)
    stage.dispose()
  })

  it('prepare() waits for the re-source it promoted to visible', async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const a = await stage.add('/a.png', { key: 'a' })
    const b = await stage.add('/b.png', { key: 'b' })
    if (a instanceof Error || isAborted(a) || b instanceof Error || isAborted(b))
      return expect.fail('add refused')
    // Evict `a`'s front (unpinned, unattached, reclaimable); the artwork slot is `b`'s.
    stage.budget({ bytes: 1 })
    expect(stage.usage().fronts).toBe(1)

    const x = fakeBitmap({ width: 70 })
    const y = fakeBitmap({ width: 71 })
    g.close()
    const addX = stage.add(asBitmap(x), { key: 'x', pin: true })
    await flush()
    expect(g.pending).toBe(1)
    const addY = stage.add(asBitmap(y), { key: 'y', pin: true })
    await flush()
    // `rebuildFront` finds the slot taken, schedules the re-source, and `prepare` promotes it.
    let prepared: Sprite | Error | null = null
    const prep = stage.prepare('a').then((r) => {
      prepared = isAborted(r) ? new Error('aborted') : r
      return r
    })
    await flush()
    expect(prepared).toBeNull()
    g.release() // x
    await flush()
    expect(prepared).toBeNull()
    g.release() // a's re-source, ahead of the queued y
    const got = await prep
    expect(got instanceof Error || isAborted(got)).toBe(false)
    expect((got as Sprite).key).toBe('a')
    expect(stage.usage().fronts).toBe(2)
    g.open()
    await Promise.all([addX, addY])
    const tags = sheet.calls.source
      .slice(2)
      .map((c) => (c.bitmap === x ? 'x' : c.bitmap === y ? 'y' : 'a'))
    expect(tags).toEqual(['x', 'a', 'y'])
    stage.dispose()
  })

  it('dispose() mid-burst settles every pending add ABORTED and closes each owned bitmap exactly once', async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv())
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const bitmaps: FakeBitmap[] = []
    g.close()
    const adds = Array.from({ length: 30 }, (_, i) =>
      stage.add(
        async () => {
          const b = fakeBitmap({ width: 64 + i })
          bitmaps.push(b)
          return asBitmap(b)
        },
        { key: `k${String(i)}` },
      ),
    )
    await flush()
    expect(bitmaps).toHaveLength(30)
    expect(g.pending).toBe(1)
    stage.dispose()
    // The 29 queued jobs were discarded synchronously, bitmaps closed; the running one holds its
    // bitmap until `source()` returns.
    expect(bitmaps.filter((b) => b.closes === 1)).toHaveLength(29)
    g.open()
    const results = await Promise.all(adds)
    expect(results.every((r) => isAborted(r))).toBe(true)
    expect(bitmaps.map((b) => b.closes)).toEqual(Array.from({ length: 30 }, () => 1))
  })

  it('a re-source whose supplier rejects (a breached §10.8 boundary) does not strand the key: prepare() resolves to an Error and the next prepare() retries', async () => {
    let fetches = 0
    const healthy = () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    })
    // The second response is hostile: reading `ok` throws (a property of `null` — no `throw`
    // statement is needed to breach §10.8 from a consumer object), outside every boundary the url
    // arm wraps, so `resupply()` — and with it `resource()` — rejects instead of returning.
    const hostile = () => ({
      get ok(): boolean {
        return (null as unknown as { ok: boolean }).ok
      },
      status: 200,
      headers: { get: () => null },
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    })
    const stage = await createStage(
      { ...base(), present: 'blit' },
      stageEnv({
        sourceEnv: {
          fetch: async () => {
            fetches += 1
            return fetches === 2 ? hostile() : healthy()
          },
          createImageBitmap: async () => asBitmap(fakeBitmap({ width: 40, height: 30 })),
        },
      }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const errors: Error[] = []
    stage.on('error', (e) => errors.push(e.error))
    const a = await stage.add('/a.png', { key: 'a' })
    if (a instanceof Error || isAborted(a)) return expect.fail('add refused')
    // `b` takes the artwork slot; the budget drops `a`'s front, so `prepare('a')` must re-source.
    const b = await stage.add(asBitmap(fakeBitmap()), { key: 'b', pin: true })
    if (b instanceof Error || isAborted(b)) return expect.fail('add refused')
    stage.budget({ bytes: 1 })
    expect(stage.usage().fronts).toBe(1)

    const first = await stage.prepare('a')
    expect(first).toBeInstanceOf(Error)
    expect(fetches).toBe(2)
    // The key is not stuck: the next demand re-sources again, and this time the supplier answers.
    const second = await stage.prepare('a')
    expect(second instanceof Error || isAborted(second)).toBe(false)
    expect((second as Sprite).key).toBe('a')
    expect(fetches).toBe(3)
    expect(stage.usage().fronts).toBe(2)
    stage.dispose()
  })

  it('replace() while a re-source of the same key is in flight leaks neither the handle nor the front (spec §8.5/§8.8)', async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const a = await stage.add('/a.png', { key: 'a' })
    const b = await stage.add(asBitmap(fakeBitmap({ width: 70 })), { key: 'b', pin: true })
    if (a instanceof Error || isAborted(a) || b instanceof Error || isAborted(b))
      return expect.fail('add refused')
    // `b` holds the one artwork slot; the budget drops `a`'s front, so any demand on `a` has to
    // re-source it — §8.5's "artwork slot taken by another sprite" row.
    stage.budget({ bytes: 1 })
    expect(stage.usage().fronts).toBe(1)
    const releasedFronts = sheet.calls.releaseFront.length

    g.close()
    const prep = stage.prepare('a')
    await flush()
    // The re-source is suspended inside `source()`: the fake records the call before the gate,
    // and only mints the handle after it, so no third handle exists yet.
    expect(g.pending).toBe(1)
    expect(sheet.calls.source).toHaveLength(3)

    const replaced = stage.replace('a', '/other.png')
    await flush()
    g.open()
    const [prepared, sprite] = await Promise.all([prep, replaced])
    expect(prepared instanceof Error || isAborted(prepared)).toBe(false)
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('replace refused')
    expect(sprite.key).toBe('a')

    // Four handles were sourced — `a`, `b`, the re-source of `a`, `replace`'s — and the fake
    // numbers them 1..4 in `source()` COMPLETION order, so the re-source is #3 (the lane runs it
    // ahead of `replace`'s job, which was enqueued behind it) and `replace`'s is #4. Only `b`'s
    // and the replacement's are still anybody's. The re-source's must have gone back, or §8.5's
    // per-key live-handle count for `a` never reaches zero, the sheet never busts the hull entry,
    // and the next `add('a', ...)` serves the stale polygon (D3).
    const sourced = sheet.calls.source.map((_, i) => i + 1)
    expect(sourced).toHaveLength(4)
    const released = new Set(sheet.calls.release.map((h) => h.id))
    expect(sourced.filter((id) => !released.has(id))).toEqual([2, 4])
    // The front the re-source built and `replace` then overwrote went back to the slot too.
    expect(sheet.calls.releaseFront.length - releasedFronts).toBe(1)
    expect(stage.usage().fronts).toBe(2)
    stage.dispose()
  })

  it("prepare() during replace()'s build joins the replace instead of re-sourcing the old image (S13, spec §8.5/§8.8/§8.10)", async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const a = await stage.add(asBitmap(fakeBitmap({ width: 64 })), { key: 'a', pin: true })
    if (a instanceof Error || isAborted(a)) return expect.fail('add refused')

    g.close()
    const replaced = stage.replace('a', asBitmap(fakeBitmap({ width: 90 })))
    await flush()
    // `replace`'s job is suspended inside `source()`. Its D3 release has already handed the old
    // handle back and cleared the front, so a demand on `a` now has nothing of its own to build
    // from: without the S13 fix `rebuildFront` tries the released handle, reads
    // `SourceExpiredError`, and schedules a re-source of the OLD bitmap that lands after the
    // replace and installs the old image under a resolved `replace()`.
    expect(g.pending).toBe(1)
    const prep = stage.prepare('a')
    await flush()
    g.open()
    const [prepared, sprite] = await Promise.all([prep, replaced])
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('replace refused')
    expect(sprite.key).toBe('a')
    expect(prepared).toBe(sprite)
    // Two sources and no third: the old image was never re-sourced behind the replace, and the
    // replacement's handle is the one still anybody's.
    expect(sheet.calls.source.map((c) => c.bitmap.width)).toEqual([64, 90])
    const released = new Set(sheet.calls.release.map((h) => h.id))
    expect([1, 2].filter((id) => !released.has(id))).toEqual([2])
    expect(stage.usage().fronts).toBe(1)
    stage.dispose()
  })

  it("remove() during replace()'s build releases the halves the replace built and leaves nothing under the key (S13, spec §8.5/§8.8)", async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const a = await stage.add(asBitmap(fakeBitmap({ width: 64 })), { key: 'a', pin: true })
    if (a instanceof Error || isAborted(a)) return expect.fail('add refused')

    g.close()
    const replaced = stage.replace('a', asBitmap(fakeBitmap({ width: 90 })))
    await flush()
    expect(g.pending).toBe(1)
    // Unattached, so `remove` takes the record out from under the running replace.
    expect(stage.remove('a')).toBeUndefined()
    g.open()
    const outcome = await replaced
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('removed')
    // The handle and the front the job built went straight back, and the LRU never saw the key.
    expect(sheet.calls.source.map((c) => c.bitmap.width)).toEqual([64, 90])
    const released = new Set(sheet.calls.release.map((h) => h.id))
    expect([1, 2].filter((id) => !released.has(id))).toEqual([])
    expect(stage.get('a')).toBeUndefined()
    expect(stage.usage()).toMatchObject({ fronts: 0, handles: 0 })
    // The key is free: an add() under it is not refused as live.
    const again = await stage.add(asBitmap(fakeBitmap({ width: 70 })), { key: 'a', pin: true })
    expect(again instanceof Error || isAborted(again)).toBe(false)
    stage.dispose()
  })

  it('crumpleTo() on the promise of an add that has landed leaves no promotion behind for the next job under that key (§8.10)', async () => {
    const g = sourceGate()
    const sheet = fakeSheet({ gate: g.gate })
    const timers = createFakeTimers()
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, stageEnv({ timers }))
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const shown = await stage.add('/base.png', { key: 'base' })
    if (shown instanceof Error || isAborted(shown)) return expect.fail('add refused')
    const view = stage.view({ canvas: destCanvas(), tag: 'tile' })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(shown)
    const addK = stage.add(asBitmap(fakeBitmap({ width: 70 })), { key: 'k', pin: true })
    const k = await addK
    if (k instanceof Error || isAborted(k)) return expect.fail('add refused')
    // The add has landed, so there is no job to promote: a `held` remembered for `k` here would
    // be consumed by the NEXT job under the key, whoever enqueues it.
    const run = view.crumpleTo(addK)
    view.stop()
    expect(isAborted(await run)).toBe(true)
    expect(stage.remove('k')).toBeUndefined()

    g.close()
    const addX = stage.add(asBitmap(fakeBitmap({ width: 80 })), { key: 'x', pin: true })
    await flush()
    expect(g.pending).toBe(1)
    const addY = stage.add(asBitmap(fakeBitmap({ width: 81 })), { key: 'y', pin: true })
    const addK2 = stage.add(asBitmap(fakeBitmap({ width: 82 })), { key: 'k', pin: true })
    await flush()
    g.open()
    await Promise.all([addX, addY, addK2])
    // FIFO within the background class: a stale `held` would have put `k` ahead of `y`.
    expect(sheet.calls.source.slice(2).map((c) => c.bitmap.width)).toEqual([80, 81, 82])
    stage.dispose()
  })
})
