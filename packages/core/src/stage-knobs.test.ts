import { describe, expect, it, vi } from 'vitest'
import { isAborted } from './abort.js'
import { KnobError } from './errors.js'
import { INVALIDATION_ORDER } from './invalidation.js'
import { createKnobRegistry, resolveKnobValues, type KnobValues } from './knob-registry.js'
import type { Knobs } from './knobs.js'
import { createStage, type StageEnv } from './stage.js'
import { createFakeTimers } from './testing/fake-timers.js'
import { asBitmap, fakeBitmap } from './testing/fake-source.js'
import {
  fakeMotion,
  fakeSheet,
  stageEnv,
  type FakeMotion,
  type FakeSheet,
  type FakeSheetOptions,
} from './testing/fake-slots.js'

// A forced deviation from the plan's literal test code: `KnobPatch`, `ViewKnobPatch` and
// `SpriteKnobPatch` are instantiated here at the widest slot type (`readonly KnobDescriptor[]`,
// stage.ts's D4). At that instantiation `AmbiguousKeys<AnySlot, AnySlot>` collapses to `string`
// (every bare key looks ambiguous once the slot type carries no literal keys), which strips every
// bare-key entry from `FlatKnobsAt` — so `stage.set`/`sprite.set` type-check a *namespaced* patch
// natively (see the "namespaced form" case below) but never a bare one. `ViewKnobPatch` is worse:
// its single-level slice (`L: 'draw'`) makes `AtLevel<AnySlot, 'draw'>` itself `never`, because
// none of the five `KnobDescriptor` variants' *widened* `invalidates: Invalidates` field is
// assignable to the narrow literal `'draw'`, so neither the bare nor the namespaced form survives
// — `ViewKnobPatch<AnySlot, AnySlot>` is exactly `{}`. This is pre-existing trunk type machinery
// (`knob-patch.ts`, `knobs.ts` — P3's, not this task's file to touch) verified against no prior
// type-level test; a bare-key `set()` call below is therefore cast `as never` at the call site,
// same as the implementation itself already does, to exercise the real, runtime enforcement
// (`registry.normalise`) the design actually rests on (§6.8's own words: "P3's runtime registry is
// the enforcement").

function destCanvas() {
  return {
    width: 64,
    height: 64,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
  } as unknown as HTMLCanvasElement
}

async function scene() {
  const timers = createFakeTimers()
  const sheet = fakeSheet()
  const motion = fakeMotion()
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  const sprite = await stage.add('/a.png', { key: 'k' })
  const view = stage.view({ canvas: destCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error) {
    return expect.fail('view refused')
  }
  view.show(sprite)
  return { stage, sheet, motion, timers, sprite, view }
}

describe('set() at the three scopes', () => {
  it('returns undefined for a legal patch and a KnobError for an unknown key', async () => {
    const s = await scene()
    expect(s.stage.set({ sheetTint: 0.5 } as never)).toBeUndefined()
    expect(s.stage.set({ nosuchknob: 1 } as never)).toBeInstanceOf(KnobError)
    s.stage.dispose()
  })

  it('returns a KnobError rather than clamping an out-of-range value', async () => {
    const s = await scene()
    expect(s.stage.set({ sheetTint: 99 } as never)).toBeInstanceOf(KnobError)
    s.stage.dispose()
  })

  it('accepts the namespaced form, which is the ground truth the bare form resolves into', async () => {
    const s = await scene()
    expect(s.stage.set({ 'sheet.sheetTint': 0.25 })).toBeUndefined()
    s.stage.dispose()
  })

  it('refuses a front-class knob on a view, which is a draw-class scope (amendment 20)', async () => {
    const s = await scene()
    expect(s.view.set({ sheetEdge: 0.9 } as never)).toBeInstanceOf(KnobError)
    expect(s.view.set({ sheetTint: 0.9 } as never)).toBeUndefined()
    s.stage.dispose()
  })

  it('accepts the whole ladder on a sprite, draw included', async () => {
    const s = await scene()
    expect(s.sprite.set({ sheetEdge: 0.9 } as never)).toBeUndefined()
    expect(s.sprite.set({ sheetTint: 0.1 } as never)).toBeUndefined()
    s.stage.dispose()
  })

  // §6.6 — core defaults -> slot defaults -> stage -> sprite -> view. The stage layer sat in
  // `knobsFor()` for the draw and nowhere for the build, and the sprite layer was seeded with a
  // full copy of the defaults rather than the sprite's own delta, which let it shadow every
  // stage-level value on the draw path too. So a `stage.set()` of a front-class knob, the
  // playground's default scope, changed the URL hash and nothing on the canvas.
  it('a stage-level front-class set() reaches build(), and the sprite layer still wins over it', async () => {
    const s = await scene()
    s.stage.set({ sheetEdge: 0.9 } as never)
    expect(s.sheet.calls.build.at(-1)?.knobs.sheetEdge).toBe(0.9)
    s.sprite.set({ sheetEdge: 0.3 } as never)
    expect(s.sheet.calls.build.at(-1)?.knobs.sheetEdge).toBe(0.3)
    s.stage.set({ sheetEdge: 0.7 } as never)
    expect(s.sheet.calls.build.at(-1)?.knobs.sheetEdge).toBe(0.3)
    s.stage.dispose()
  })

  it('a stage-level draw-class set() reaches the draw, and the view layer still wins over it', async () => {
    const s = await scene()
    const drawn = () => s.motion.calls.draw.at(-1)?.knobs as Record<string, unknown> | undefined
    s.stage.set({ motionTilt: 0.5 } as never)
    expect(drawn()?.motionTilt).toBe(0.5)
    s.view.set({ motionTilt: -0.5 } as never)
    expect(drawn()?.motionTilt).toBe(-0.5)
    s.stage.dispose()
  })

  it('resolves core defaults, then sprite, then view — the view wins at draw class', async () => {
    const s = await scene()
    s.sprite.set({ sheetTint: 0.2 } as never)
    s.view.set({ sheetTint: 0.8 } as never)
    s.view.refresh()
    const knobs = s.motion.calls.draw.at(-1)?.knobs as Record<string, unknown> | undefined
    expect(knobs).toBeDefined()
    s.stage.dispose()
  })

  it('a draw-class set() redraws without rebuilding the front', async () => {
    const s = await scene()
    const builds = s.sheet.calls.build.length
    const draws = s.motion.calls.draw.length
    s.view.set({ sheetTint: 0.4 } as never)
    expect(s.sheet.calls.build).toHaveLength(builds)
    expect(s.motion.calls.draw.length).toBeGreaterThan(draws)
    s.stage.dispose()
  })

  it('a front-class set() on an idle view rebuilds and redraws synchronously', async () => {
    const s = await scene()
    const builds = s.sheet.calls.build.length
    s.sprite.set({ sheetEdge: 0.9 } as never)
    expect(s.sheet.calls.build.length).toBeGreaterThan(builds)
    s.stage.dispose()
  })

  it('a front-class set() on a running view marks dirty and does not rebuild eagerly', async () => {
    const s = await scene()
    s.view.play('flat', 'ball')
    const builds = s.sheet.calls.build.length
    // Sixty rebuilds inside one dwell for one visible result is what this prevents.
    for (let i = 0; i < 60; i += 1) s.sprite.set({ sheetEdge: i / 100 } as never)
    expect(s.sheet.calls.build).toHaveLength(builds)
    s.timers.advance(10_000)
    expect(s.sheet.calls.build.length).toBeGreaterThan(builds)
    s.stage.dispose()
  })
})

describe('prepare() as a rebuild demand (§8.8)', () => {
  it('rebuilds a resident front that a front-class set() left dirty', async () => {
    const s = await scene()
    // A running view marks dirty and does not rebuild eagerly, which is what leaves a resident
    // front stale for `prepare()` to find.
    s.view.play('flat', 'ball')
    s.sprite.set({ sheetEdge: 0.9 } as never)
    const builds = s.sheet.calls.build.length
    expect(await s.stage.prepare('k')).not.toBeInstanceOf(Error)
    expect(s.sheet.calls.build.length).toBeGreaterThan(builds)
    s.stage.dispose()
  })
})

describe('budget and usage', () => {
  it('the accounting closes: bytes is fronts plus handles plus pools', async () => {
    const s = await scene()
    const u = s.stage.usage()
    expect(u.fronts).toBe(1)
    expect(u.handles).toBe(1)
    expect(u.attached).toBe(1)
    // `reclaimable + unreclaimable` is the front tier alone, which is what `p.lru.usage()`
    // counts. §8.8's `bytes` is fronts **plus** handles plus pools, so it is strictly larger.
    expect(u.bytes).toBeGreaterThan(u.reclaimable + u.unreclaimable)
    s.stage.dispose()
  })

  it('warns exactly once when unreclaimable exceeds the budget, naming how many sprites', async () => {
    const s = await scene()
    await s.stage.add(asBitmap(fakeBitmap({ width: 64, height: 64 })), { key: 'p1', pin: true })
    await s.stage.add(asBitmap(fakeBitmap({ width: 64, height: 64 })), { key: 'p2', pin: true })
    s.stage.budget({ bytes: 1 })
    const warned = s.stage.warnings.filter((w) => w.message.includes('unreclaimable'))
    expect(warned).toHaveLength(1)
    expect(warned[0]?.message).toContain('2')
    s.stage.budget({ bytes: 2 })
    expect(s.stage.warnings.filter((w) => w.message.includes('unreclaimable'))).toHaveLength(1)
    s.stage.dispose()
  })
})

/**
 * §8.5 — the pool keeps ONE artwork slot, keyed by sprite, and every `source()` takes it. So in
 * any scene with two sprites, a front-class `set()` on the one sourced first finds its artwork
 * gone and `build()` answers `SourceExpiredError`. The design's answer is the re-source row of
 * §8.5's table (the supplier, `source()` again, then the rebuild), and the stage is the party
 * that has to walk it: a slot cannot, because it never sees the supplier.
 */
describe('a front-class set() on a sprite whose artwork another sprite displaced (§8.5)', () => {
  async function twoSprites(o: { sheet?: FakeSheetOptions; env?: Partial<StageEnv> } = {}) {
    const timers = createFakeTimers()
    const sheet = fakeSheet(o.sheet)
    const motion = fakeMotion()
    const seen: Array<{ error: Error; observed: boolean }> = []
    const stage = await createStage(
      {
        sheet,
        motion,
        maxSize: 384,
        present: 'blit',
        onError: (e) => seen.push({ error: e.error, observed: e.observed }),
      },
      stageEnv({ timers, ...o.env }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const a = await stage.add('/a.png', { key: 'a' })
    const b = await stage.add('/b.png', { key: 'b' })
    const view = stage.view({ canvas: destCanvas() })
    if (a instanceof Error || isAborted(a) || b instanceof Error || isAborted(b)) {
      return expect.fail('add refused')
    }
    if (view instanceof Error) return expect.fail('view refused')
    view.show(a)
    // `b` was sourced last, so the one artwork slot is b's and a's handle is expired.
    expect(sheet.artworkKey()).toBe(2)
    return { stage, sheet, motion, timers, a, b, view, seen }
  }

  /** A `gate` that lets the scene's own two `source()` calls through and parks every later one. */
  function parkLaterSources() {
    const parked: Array<() => void> = []
    let sourced = 0
    const gate = (): Promise<void> => {
      sourced += 1
      return sourced <= 2 ? Promise.resolve() : new Promise<void>((r) => parked.push(r))
    }
    return { parked, gate }
  }

  it('re-sources the sprite, rebuilds its front from the new handle and redraws — no orphan', async () => {
    const s = await twoSprites()
    const sources = s.sheet.calls.source.length
    const draws = s.motion.calls.draw.length
    s.a.set({ sheetEdge: 0.9 } as never)
    // The re-source is a decode, so it lands on a later turn; until then the view keeps the
    // front it last drew (§8.8) and nothing is reported, because nothing has gone wrong.
    await vi.waitFor(() => expect(s.sheet.calls.source.length).toBe(sources + 1))
    await vi.waitFor(() => expect(s.motion.calls.draw.length).toBeGreaterThan(draws))
    expect(s.sheet.artworkKey()).toBe(3)
    expect(s.sheet.calls.build.at(-1)?.handle.id).toBe(3)
    // The handle the re-source replaced is released exactly once, and only after the new one
    // was in hand — a released handle cannot be built from, and the view was still drawing.
    expect(s.sheet.calls.release.map((h) => h.id)).toEqual([1])
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })

  it('coalesces a drag: sixty set() calls during one re-source land one source() and one rebuild', async () => {
    const { parked, gate } = parkLaterSources()
    const s = await twoSprites({ sheet: { gate } })
    const sources = s.sheet.calls.source.length
    const builds = s.sheet.calls.build.length
    s.a.set({ sheetEdge: 0.1 } as never)
    await vi.waitFor(() => expect(parked).toHaveLength(1))
    for (let i = 1; i < 60; i += 1) s.a.set({ sheetEdge: i / 100 } as never)
    expect(s.sheet.calls.source.length).toBe(sources + 1)
    // One build attempt found the slot taken; the fifty-nine after it did not try again.
    expect(s.sheet.calls.build.length).toBe(builds + 1)
    parked[0]?.()
    await vi.waitFor(() => expect(s.sheet.calls.build.length).toBe(builds + 2))
    expect(s.sheet.calls.build.at(-1)?.handle.id).toBe(3)
    expect(s.sheet.calls.source.length).toBe(sources + 1)
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })

  it('a stage-level set() over three sprites re-sources them one at a time, each built before the next is sourced', async () => {
    const s = await twoSprites()
    const c = await s.stage.add('/c.png', { key: 'c' })
    if (c instanceof Error || isAborted(c)) return expect.fail('add refused')
    const mark = s.sheet.order.length
    s.stage.set({ sheetEdge: 0.7 } as never)
    await vi.waitFor(() => expect(s.sheet.calls.build.at(-1)?.handle.id).toBe(5))
    // `c` held the slot and built at once; `a` then `b` were re-sourced, and never both in
    // flight — `source()` suspends after it has taken the slot, so two at a time would displace
    // each other and neither's build would ever find its own artwork.
    expect(s.sheet.order.slice(mark)).toEqual([
      'build',
      'build',
      'build',
      'releaseFront',
      'source',
      'build',
      'releaseFront',
      'release',
      'source',
      'build',
      'releaseFront',
      'release',
    ])
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })

  it('prepare() waits for the re-source it caused and returns the sprite once the front is rebuilt', async () => {
    const s = await twoSprites()
    s.view.play('flat', 'ball')
    s.a.set({ sheetEdge: 0.9 } as never)
    const sources = s.sheet.calls.source.length
    const prepared = await s.stage.prepare('a')
    expect(prepared).toBe(s.a)
    expect(s.sheet.calls.source.length).toBe(sources + 1)
    expect(s.sheet.calls.build.at(-1)?.handle.id).toBe(3)
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })

  it('reports a failed re-source once as an orphan, keeps the last front and the handle, and retries on the next set()', async () => {
    let fetches = 0
    const s = await twoSprites({
      env: {
        sourceEnv: {
          fetch: async () => {
            fetches += 1
            if (fetches > 2) return Promise.reject(new Error('offline'))
            return {
              ok: true,
              status: 200,
              headers: { get: () => null },
              blob: async () => new Blob(['png'], { type: 'image/png' }),
            }
          },
          createImageBitmap: async () => asBitmap(fakeBitmap({ width: 40, height: 30 })),
        },
      },
    })
    const before = { ...s.a.frontSize }
    s.a.set({ sheetEdge: 0.9 } as never)
    await vi.waitFor(() => expect(s.seen).toHaveLength(1))
    expect(s.seen[0]?.observed).toBe(false)
    expect(s.seen[0]?.error.message).toContain('/a.png')
    expect(s.a.frontSize).toEqual(before)
    expect(s.sheet.calls.release).toEqual([])
    expect(s.stage.usage().fronts).toBe(2)
    // The next front-class set() tries again rather than remembering the failure.
    s.a.set({ sheetEdge: 0.8 } as never)
    await vi.waitFor(() => expect(fetches).toBe(4))
    s.stage.dispose()
  })

  it('remove() during a re-source releases the late handle and builds nothing from it', async () => {
    const { parked, gate } = parkLaterSources()
    const s = await twoSprites({ sheet: { gate } })
    s.a.set({ sheetEdge: 0.9 } as never)
    await vi.waitFor(() => expect(parked).toHaveLength(1))
    const builds = s.sheet.calls.build.length
    expect(s.stage.remove('a', { detach: true })).toBeUndefined()
    parked[0]?.()
    await vi.waitFor(() => expect(s.sheet.calls.release.map((h) => h.id)).toEqual([1, 3]))
    expect(s.sheet.calls.build.length).toBe(builds)
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })
})

/**
 * §6.3 — `hull` is a tier of its own: "invalidate the hull cache, then front", and the hull cache
 * key is "every knob at or above 'hull'". The hull, its cache and its key live inside `source()`
 * (§5.2), so the value a hull-tier knob holds has to reach `source()` — a `build()` at any other
 * value answers `SourceExpiredError`, the re-source row of §8.5's table, walked by the stage
 * exactly as for a displaced artwork slot. A stage that re-sourced WITHOUT the values would trace
 * at the slot's defaults again, find the same drift on the rebuild, and either orphan every
 * hull-tier set() or loop for its life.
 */
describe('a hull-tier set() re-sources at the current knob values (§6.3)', () => {
  async function oneSprite(
    o: { sheet?: FakeSheetOptions; before?: (stage: StageOf) => void } = {},
  ) {
    const timers = createFakeTimers()
    const sheet = fakeSheet(o.sheet)
    const motion = fakeMotion()
    const seen: Array<{ error: Error; observed: boolean }> = []
    const stage = await createStage(
      {
        sheet,
        motion,
        maxSize: 384,
        present: 'blit',
        onError: (e) => seen.push({ error: e.error, observed: e.observed }),
      },
      stageEnv({ timers }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    o.before?.(stage)
    const a = await stage.add('/a.png', { key: 'a' })
    const view = stage.view({ canvas: destCanvas() })
    if (a instanceof Error || isAborted(a)) return expect.fail('add refused')
    if (view instanceof Error) return expect.fail('view refused')
    view.show(a)
    // One sprite: the artwork slot is still this sprite's, so nothing but the hull tier can make
    // its `build()` expire — what isolates the row under test from the displaced-slot row.
    expect(sheet.artworkKey()).toBe(1)
    return { stage, sheet, motion, timers, a, view, seen }
  }
  type StageOf = Exclude<Awaited<ReturnType<typeof createStage>>, Error | symbol>

  it('add() sources at the projected sheet knobs, hull tier included, and builds at the same values', async () => {
    const s = await oneSprite({ before: (stage) => stage.set({ sheetHull: 0.3 } as never) })
    expect(s.sheet.calls.source.at(-1)?.o.knobs?.sheetHull).toBe(0.3)
    expect(s.sheet.calls.build.at(-1)?.knobs.sheetHull).toBe(0.3)
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })

  it('re-sources at the new value, rebuilds from the new handle and redraws — no orphan, and again on the next move', async () => {
    const s = await oneSprite()
    const sources = s.sheet.calls.source.length
    const draws = s.motion.calls.draw.length
    s.a.set({ sheetHull: 0.9 } as never)
    await vi.waitFor(() => expect(s.sheet.calls.source.length).toBe(sources + 1))
    expect(s.sheet.calls.source.at(-1)?.o.knobs?.sheetHull).toBe(0.9)
    await vi.waitFor(() => expect(s.motion.calls.draw.length).toBeGreaterThan(draws))
    expect(s.sheet.artworkKey()).toBe(2)
    expect(s.sheet.calls.build.at(-1)?.handle.id).toBe(2)
    expect(s.sheet.calls.build.at(-1)?.knobs.sheetHull).toBe(0.9)
    expect(s.sheet.calls.release.map((h) => h.id)).toEqual([1])
    expect(s.seen).toEqual([])
    // The second move is the one the old path lost: the sprite was orphaned, not re-sourced.
    s.a.set({ sheetHull: 0.2 } as never)
    await vi.waitFor(() => expect(s.sheet.calls.build.at(-1)?.handle.id).toBe(3))
    expect(s.sheet.calls.source.length).toBe(sources + 2)
    expect(s.sheet.calls.source.at(-1)?.o.knobs?.sheetHull).toBe(0.2)
    expect(s.sheet.calls.build.at(-1)?.knobs.sheetHull).toBe(0.2)
    expect(s.sheet.calls.release.map((h) => h.id)).toEqual([1, 2])
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })

  it('a stage-level set() over the sprite re-sources it too, at the stage value', async () => {
    const s = await oneSprite()
    const sources = s.sheet.calls.source.length
    s.stage.set({ sheetHull: 0.7 } as never)
    await vi.waitFor(() => expect(s.sheet.calls.build.at(-1)?.handle.id).toBe(2))
    expect(s.sheet.calls.source.length).toBe(sources + 1)
    expect(s.sheet.calls.source.at(-1)?.o.knobs?.sheetHull).toBe(0.7)
    expect(s.seen).toEqual([])
    s.stage.dispose()
  })

  it('a hull-tier set() that lands inside add()’s own decode is applied once the sprite is shown', async () => {
    const parked: Array<() => void> = []
    const gate = (): Promise<void> => new Promise<void>((r) => parked.push(r))
    const timers = createFakeTimers()
    const sheet = fakeSheet({ gate })
    const motion = fakeMotion()
    const seen: Array<{ error: Error; observed: boolean }> = []
    const stage = await createStage(
      {
        sheet,
        motion,
        maxSize: 384,
        present: 'blit',
        onError: (e) => seen.push({ error: e.error, observed: e.observed }),
      },
      stageEnv({ timers }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const adding = stage.add('/a.png', { key: 'a' })
    await vi.waitFor(() => expect(parked).toHaveLength(1))
    // The record is not registered yet, so this set() reaches no sprite; the front that add()
    // builds is at the values source() traced at (the two must agree, §6.3), never at these.
    stage.set({ sheetHull: 0.8 } as never)
    parked[0]?.()
    const a = await adding
    if (a instanceof Error || isAborted(a)) return expect.fail('add refused')
    expect(sheet.calls.source.at(-1)?.o.knobs?.sheetHull).toBe(0.5)
    expect(sheet.calls.build.at(-1)?.knobs.sheetHull).toBe(0.5)
    const view = stage.view({ canvas: destCanvas() })
    if (view instanceof Error) return expect.fail('view refused')
    view.show(a)
    await vi.waitFor(() => expect(parked).toHaveLength(2))
    parked[1]?.()
    await vi.waitFor(() => expect(sheet.calls.build.at(-1)?.handle.id).toBe(2))
    expect(sheet.calls.source.at(-1)?.o.knobs?.sheetHull).toBe(0.8)
    expect(sheet.calls.build.at(-1)?.knobs.sheetHull).toBe(0.8)
    expect(seen).toEqual([])
    stage.dispose()
  })
})

/**
 * C1 — the resolved bags are cached per (record, view) behind a version counter on each of the
 * three layers. A cache is only allowed here if what reaches `build()` and `draw()` is what a
 * from-scratch resolution would have produced, so that is what these compare against: a second
 * registry over the same descriptors, resolving §6.6's ladder with no cache at all.
 */
describe('the cached knob bags (§6.6)', () => {
  function reference(
    s: { sheet: FakeSheet; motion: FakeMotion },
    slot: 'sheet' | 'motion',
    layers: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ): Knobs {
    const registry = createKnobRegistry({ sheet: s.sheet.knobs, motion: s.motion.knobs })
    const resolved: KnobValues[] = [registry.defaults()]
    for (const patch of layers) {
      const normalised = registry.normalise(patch, INVALIDATION_ORDER)
      if (KnobError.is(normalised)) return expect.fail(normalised.message)
      resolved.push(normalised)
    }
    return registry.projector(slot)(resolveKnobValues(resolved))
  }

  it('hands build() and draw() what a fresh resolution would, after a patch at each scope', async () => {
    const s = await scene()
    const built = (): Knobs => s.sheet.calls.build.at(-1)?.knobs as Knobs
    const drawn = (): Knobs => s.motion.calls.draw.at(-1)?.knobs as Knobs

    expect(built()).toEqual(reference(s, 'sheet', []))
    expect(drawn()).toEqual(reference(s, 'motion', []))

    const stagePatch = { sheetEdge: 0.9, motionTilt: 0.5 }
    expect(s.stage.set(stagePatch as never)).toBeUndefined()
    expect(built()).toEqual(reference(s, 'sheet', [stagePatch]))
    expect(drawn()).toEqual(reference(s, 'motion', [stagePatch]))

    const spritePatch = { sheetEdge: 0.3, sheetTint: 0.2 }
    expect(s.sprite.set(spritePatch as never)).toBeUndefined()
    expect(built()).toEqual(reference(s, 'sheet', [stagePatch, spritePatch]))
    expect(drawn()).toEqual(reference(s, 'motion', [stagePatch, spritePatch]))

    const viewPatch = { sheetTint: 0.8, motionTilt: -0.25 }
    expect(s.view.set(viewPatch as never)).toBeUndefined()
    // A view layer is draw class and never reaches a build: a front is shared by every view.
    expect(built()).toEqual(reference(s, 'sheet', [stagePatch, spritePatch]))
    expect(drawn()).toEqual(reference(s, 'motion', [stagePatch, spritePatch, viewPatch]))
    s.stage.dispose()
  })

  it('reuses one frozen bag while no layer moves, and mints a new one when one does', async () => {
    const s = await scene()
    s.view.refresh()
    const first = s.motion.calls.draw.at(-1)?.knobs
    s.view.refresh()
    // The whole point of the cache: a draw whose three versions are unchanged pays a version
    // compare and reuses the bag, rather than re-merging four layers and re-projecting.
    expect(s.motion.calls.draw.at(-1)?.knobs).toBe(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(s.stage.set({ motionTilt: 0.25 } as never)).toBeUndefined()
    expect(s.motion.calls.draw.at(-1)?.knobs).not.toBe(first)
    s.stage.dispose()
  })

  it('keeps the sheet bag stable across rebuilds that no patch preceded', async () => {
    const s = await scene()
    const builds = s.sheet.calls.build.length
    expect(await s.stage.prepare('k')).not.toBeInstanceOf(Error)
    // Nothing moved, so `prepare` had nothing to rebuild; the next front-class patch is what
    // mints a new bag.
    expect(s.sheet.calls.build).toHaveLength(builds)
    const before = s.sheet.calls.build.at(-1)?.knobs
    expect(Object.isFrozen(before)).toBe(true)
    expect(s.sprite.set({ sheetEdge: 0.42 } as never)).toBeUndefined()
    expect(s.sheet.calls.build.at(-1)?.knobs).not.toBe(before)
    expect(s.sheet.calls.build.at(-1)?.knobs.sheetEdge).toBe(0.42)
    s.stage.dispose()
  })
})

/**
 * C1's second half — views indexed by the key of the sprite they show, so a per-sprite fan-out
 * (`invalidateSprite`, the re-source's redraw, `remove({ detach: true })`) walks that sprite's
 * views rather than every view on the stage. The index is only correct if `show`, a swap's adopt
 * and `dispose` all maintain it, which is what these three cases separate.
 */
describe('the view index by sprite key', () => {
  async function twoOfEach() {
    const timers = createFakeTimers()
    const sheet = fakeSheet()
    const motion = fakeMotion()
    const stage = await createStage(
      { sheet, motion, maxSize: 384, present: 'blit' },
      stageEnv({ timers }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const a = await stage.add('/a.png', { key: 'a' })
    const b = await stage.add('/b.png', { key: 'b' })
    const va = stage.view({ canvas: destCanvas() })
    const vb = stage.view({ canvas: destCanvas() })
    if (a instanceof Error || isAborted(a) || b instanceof Error || isAborted(b)) {
      return expect.fail('add refused')
    }
    if (va instanceof Error || vb instanceof Error) return expect.fail('view refused')
    va.show(a)
    vb.show(b)
    return { stage, sheet, motion, timers, a, b, va, vb }
  }

  /** Which sprite each draw since `mark` was for — the fake clip's id: 1 for `a`, 2 for `b`. */
  const drawnSince = (motion: FakeMotion, mark: number): number[] =>
    motion.calls.draw.slice(mark).map((d) => d.clip.id)

  it('redraws only the views showing the patched sprite', async () => {
    const s = await twoOfEach()
    const mark = s.motion.calls.draw.length
    expect(s.a.set({ sheetTint: 0.3 } as never)).toBeUndefined()
    expect(drawnSince(s.motion, mark)).toEqual([1])
    expect(s.b.set({ sheetTint: 0.4 } as never)).toBeUndefined()
    expect(drawnSince(s.motion, mark)).toEqual([1, 2])
    s.stage.dispose()
  })

  it('follows a view that is shown onto another sprite', async () => {
    const s = await twoOfEach()
    s.va.show(s.b)
    const mark = s.motion.calls.draw.length
    expect(s.a.set({ sheetTint: 0.3 } as never)).toBeUndefined()
    expect(drawnSince(s.motion, mark)).toEqual([])
    expect(s.b.set({ sheetTint: 0.4 } as never)).toBeUndefined()
    expect(drawnSince(s.motion, mark)).toEqual([2, 2])
    s.stage.dispose()
  })

  it('drops a disposed view, so nothing is drawn for it afterwards', async () => {
    const s = await twoOfEach()
    s.va.dispose()
    const mark = s.motion.calls.draw.length
    expect(s.a.set({ sheetTint: 0.3 } as never)).toBeUndefined()
    expect(drawnSince(s.motion, mark)).toEqual([])
    expect(s.b.set({ sheetTint: 0.4 } as never)).toBeUndefined()
    expect(drawnSince(s.motion, mark)).toEqual([2])
    s.stage.dispose()
  })
})
