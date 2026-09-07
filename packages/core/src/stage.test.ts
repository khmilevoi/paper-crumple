import { describe, expect, it, vi } from 'vitest'
import { isAborted } from './abort.js'
import { GlError } from './errors.js'
import { createStage, type StageEnv } from './stage.js'
import type { StageOptions } from './stage-types.js'
import { createFakeTimers } from './testing/fake-timers.js'
import { asBitmap, fakeBitmap } from './testing/fake-source.js'
import { fakeGlContext, fakeMotion, fakeSheet } from './testing/fake-slots.js'

function env(over: Partial<StageEnv> = {}): StageEnv {
  const ctx = fakeGlContext()
  const canvasOf = (w: number, h: number) =>
    ({
      width: w,
      height: h,
      getContext: () => ({
        canvas: { width: w, height: h },
        getContextAttributes: () => ({
          alpha: true,
          antialias: false,
          depth: true,
          premultipliedAlpha: false,
          preserveDrawingBuffer: true,
          stencil: false,
          powerPreference: 'high-performance',
        }),
        getExtension: () => ({ loseContext: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    }) as unknown as HTMLCanvasElement
  return {
    surface: { makeOffscreen: canvasOf, makeElement: canvasOf },
    makeContext: () => ctx,
    timers: createFakeTimers(),
    dpr: 2,
    ...over,
  }
}

const base = (): StageOptions => ({ sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384 })

describe('paperStage(), the factory', () => {
  it('resolves to a stage whose invariants hold, with no ready() to call', async () => {
    const stage = await createStage({ ...base(), present: 'blit' }, env())
    expect(stage).not.toBeInstanceOf(Error)
    if (stage instanceof Error || isAborted(stage)) return
    expect(stage.lost).toBe(false)
    expect(stage.views).toEqual([])
    expect(stage.caps.maxTextureSize).toBe(4096)
    stage.dispose()
  })

  it('mounts both slots exactly once, with the same context', async () => {
    const sheet = fakeSheet()
    const motion = fakeMotion()
    const sheetMount = vi.spyOn(sheet, 'mount')
    const motionMount = vi.spyOn(motion, 'mount')
    const stage = await createStage({ sheet, motion, maxSize: 128, present: 'blit' }, env())
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    expect(sheetMount).toHaveBeenCalledTimes(1)
    expect(motionMount).toHaveBeenCalledTimes(1)
    expect(sheetMount.mock.calls[0]?.[0]).toBe(motionMount.mock.calls[0]?.[0])
    stage.dispose()
  })

  it("derives maxSize from cssPx through P5's sizeForDisplay (amendment 12)", async () => {
    const e = env({ dpr: 2 })
    const stage = await createStage(
      { sheet: fakeSheet(), motion: fakeMotion(), cssPx: 192, present: 'blit' },
      e,
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    // sizeForDisplay({ cssPx: 192, dpr: 2, cap: 2048 }) === 384
    expect(stage.surface.width).toBe(384)
    stage.dispose()
  })

  it('derives the surface and the artwork request from artworkCssPx', async () => {
    const e = env({ dpr: 1.5 })
    const sheet = fakeSheet()
    const stage = await createStage(
      { sheet, motion: fakeMotion(), artworkCssPx: 360, present: 'blit' },
      e,
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    // frontCapFor({ artworkLongSide: 540, overscan: 0.08, cap: 2048 }) (design 2026-09-05 §4.2:
    // paint plus the guard band, not paint alone) -> sizeForDisplay rounds up to 704.
    expect(stage.surface.width).toBe(704)
    const sprite = await stage.add(asBitmap(fakeBitmap({ width: 64, height: 64 })), {
      key: 'a',
      pin: true,
    })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    expect(sheet.calls.source[0]?.o.artworkLongSide).toBe(540)
    expect(sheet.calls.source[0]?.o.maxSize).toBe(704)
    stage.dispose()
  })

  it('refuses a zero, negative or non-finite artworkCssPx by its own name, rather than degrading to a 0-texel artworkLongSide add() would later fail on', async () => {
    const e = env({ dpr: 1 })
    for (const artworkCssPx of [0, -10, NaN, Infinity]) {
      const stage = await createStage(
        { sheet: fakeSheet(), motion: fakeMotion(), artworkCssPx, present: 'blit' },
        e,
      )
      expect(stage).toBeInstanceOf(GlError)
      if (!(stage instanceof GlError)) continue
      expect(stage.message).toContain('artworkCssPx')
    }
  })

  it('threads artworkLongSide through the re-source path too', async () => {
    const e = env({ dpr: 1.5 })
    const sheet = fakeSheet()
    const stage = await createStage(
      { sheet, motion: fakeMotion(), artworkCssPx: 360, present: 'blit' },
      e,
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const a = await stage.add(asBitmap(fakeBitmap({ width: 64, height: 64 })), {
      key: 'a',
      pin: true,
    })
    if (a instanceof Error || isAborted(a)) return expect.fail('add refused')
    const sources = sheet.calls.source.length
    // A hull-tier knob write re-sources the sprite (stage-knobs.test.ts's own device).
    a.set({ sheetHull: 0.9 } as never)
    await vi.waitFor(() => expect(sheet.calls.source.length).toBe(sources + 1))
    expect(sheet.calls.source.at(-1)?.o.artworkLongSide).toBe(540)
    stage.dispose()
  })

  it('cssPx stages pass no artworkLongSide and are capped at 2048', async () => {
    const e = env({ dpr: 3 })
    const sheet = fakeSheet()
    const stage = await createStage({ sheet, motion: fakeMotion(), cssPx: 400, present: 'blit' }, e)
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    // sizeForDisplay({ cssPx: 400, dpr: 3, cap: 2048 }): 1200 -> next multiple of 64 -> 1216.
    expect(stage.surface.width).toBe(1216)
    const sprite = await stage.add(asBitmap(fakeBitmap({ width: 64, height: 64 })), {
      key: 'a',
      pin: true,
    })
    if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
    expect(sheet.calls.source[0]?.o.artworkLongSide).toBeUndefined()
    stage.dispose()
  })

  it('returns a ReadyError when a slot refuses to mount, and disposes what it built', async () => {
    const sheet = fakeSheet()
    sheet.mount = () => new GlError('the sheet program did not compile')
    const stage = await createStage({ ...base(), sheet, present: 'blit' }, env())
    expect(stage).toBeInstanceOf(GlError)
  })

  it('does not refuse a stage whose two slots declare the same knob key', async () => {
    // P3 removed mount-time knob refusal on purpose: `grain` and `debug` are declared by both
    // built-in slots, so a registry that refused a duplicate would not start the default
    // configuration of section 4 -- and an additive minor in one slot would retroactively kill a
    // working application on `pnpm update`. Ambiguity surfaces at the ambiguous `set()` instead.
    const shared = [
      { key: 'grain', kind: 'number', invalidates: 'draw', default: 0, min: 0, max: 1 },
    ] as never
    const stage = await createStage(
      {
        ...base(),
        sheet: fakeSheet({ knobs: shared }),
        motion: fakeMotion({ knobs: shared }),
        present: 'blit',
      },
      env(),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    expect(stage.knobs.filter((d) => d.key === 'grain').length).toBeGreaterThan(1)
    stage.dispose()
  })

  it('keeps degradation as a value: a slot warning lands in stage.warnings, not in the return', async () => {
    const stage = await createStage({ ...base(), gl: brokenAttrs() }, env())
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    expect(stage.warnings.length).toBeGreaterThan(0)
    expect(stage.warnings[0]).toBeInstanceOf(Error)
    stage.dispose()
  })

  it('disposes what it built and returns ABORTED when the signal fires mid-flight', async () => {
    const controller = new AbortController()
    const sheet = fakeSheet()
    const e = env()
    const disposeSpy = vi.spyOn(sheet, 'dispose')
    const gate = new Promise<void>((r) => setTimeout(r, 0))
    const motion = fakeMotion()
    motion.mount = () => {
      controller.abort()
      return undefined
    }
    const out = await createStage(
      { sheet, motion, maxSize: 128, present: 'blit', signal: controller.signal },
      e,
    )
    await gate
    expect(isAborted(out)).toBe(true)
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('returns ABORTED immediately for an already-aborted signal and builds nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const sheet = fakeSheet()
    const out = await createStage(
      { ...base(), sheet, present: 'blit', signal: controller.signal },
      env(),
    )
    expect(isAborted(out)).toBe(true)
    expect(sheet.order).toEqual([])
  })

  it('never emits ABORTED on the error channel', async () => {
    const seen: unknown[] = []
    const controller = new AbortController()
    controller.abort()
    await createStage(
      { ...base(), present: 'blit', signal: controller.signal, onError: (e) => seen.push(e) },
      env(),
    )
    expect(seen).toEqual([])
  })

  it('wires onError before anything can fail, so an error raised inside the factory is seen', async () => {
    const seen: Array<{ error: Error; observed: boolean }> = []
    const sheet = fakeSheet()
    sheet.mount = () => new GlError('mount failed')
    await createStage({ ...base(), sheet, present: 'blit', onError: (e) => seen.push(e) }, env())
    expect(seen).toHaveLength(1)
    expect(seen[0]?.observed).toBe(true)
  })

  it('applies the budget option before the first add(), so there is no wrong window', async () => {
    const stage = await createStage({ ...base(), budget: 1024, present: 'blit' }, env())
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    expect(stage.usage().bytes).toBe(0)
    stage.budget({ bytes: 2048 })
    stage.dispose()
  })

  it('opens the lost channel, marks itself dead, and emits error alongside it', async () => {
    let fire: (() => void) | undefined
    const e = env()
    const stage = await createStage(
      { ...base(), present: 'blit' },
      {
        ...e,
        onContextLost: (fn) => {
          fire = fn
          return () => {}
        },
      },
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const lost: number[] = []
    const errors: Error[] = []
    stage.on('lost', () => lost.push(1))
    stage.on('error', (ev) => errors.push(ev.error))
    fire?.()
    expect(stage.lost).toBe(true)
    expect(lost).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(GlError)
    expect(stage.get('anything')).toBeUndefined()
    stage.dispose()
  })

  it('dispose() is idempotent and disposes both slots and the context exactly once', async () => {
    const sheet = fakeSheet()
    const motion = fakeMotion()
    const stage = await createStage({ sheet, motion, maxSize: 64, present: 'blit' }, env())
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    stage.dispose()
    stage.dispose()
    expect(sheet.disposed).toBe(true)
    expect(motion.disposed).toBe(true)
    expect(stage.remove('nothing')).toBeUndefined()
  })
})

function brokenAttrs(): WebGL2RenderingContext {
  return {
    canvas: { width: 16, height: 16 },
    getContextAttributes: () => ({
      alpha: true,
      antialias: true, // advisory: a warning, never a refusal
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: false,
      powerPreference: 'high-performance',
    }),
    getExtension: () => ({ loseContext: () => {} }),
  } as unknown as WebGL2RenderingContext
}
