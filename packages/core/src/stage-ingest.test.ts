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
})
