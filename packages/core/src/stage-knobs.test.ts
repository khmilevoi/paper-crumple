import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { KnobError } from './errors.js'
import { createStage } from './stage.js'
import { createFakeTimers } from './testing/fake-timers.js'
import { asBitmap, fakeBitmap } from './testing/fake-source.js'
import { fakeMotion, fakeSheet, stageEnv } from './testing/fake-slots.js'

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

describe('budget and usage', () => {
  it('the accounting closes: bytes is fronts plus handles plus pools', async () => {
    const s = await scene()
    const u = s.stage.usage()
    expect(u.fronts).toBe(1)
    expect(u.handles).toBe(1)
    expect(u.attached).toBe(1)
    expect(u.bytes).toBeGreaterThan(0)
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
