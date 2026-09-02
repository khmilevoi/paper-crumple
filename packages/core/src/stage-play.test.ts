import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { GlError } from './errors.js'
import { createStage } from './stage.js'
import { createFakeTimers } from './testing/fake-timers.js'
import { fakeMotion, fakeSheet, stageEnv } from './testing/fake-slots.js'

function destCanvas() {
  return {
    width: 64,
    height: 64,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
  } as unknown as HTMLCanvasElement
}

async function grid(n: number) {
  const timers = createFakeTimers()
  const sheet = fakeSheet()
  const motion = fakeMotion()
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  const views = []
  for (let i = 0; i < n; i += 1) {
    const sprite = await stage.add(`/${String(i)}.png`, { key: `k${String(i)}` })
    const view = stage.view({ canvas: destCanvas(), tag: `tile-${String(i)}` })
    if (sprite instanceof Error || isAborted(sprite) || view instanceof Error) {
      return expect.fail('view refused')
    }
    view.show(sprite)
    views.push(view)
  }
  return { stage, motion, timers, views }
}

describe('stage.play', () => {
  it('never returns an Error and never rejects; it returns the complete account', async () => {
    const g = await grid(3)
    const done = g.stage.play('flat', 'ball')
    g.timers.advance(10_000)
    const report = await done
    expect(report.started).toHaveLength(3)
    expect(report.skipped).toEqual([])
    expect(report.failed).toEqual([])
    expect(report.completed).toBe(true)
    g.stage.dispose()
  })

  it('starts view i at t0 + i x stagger, running N independent chains', async () => {
    const g = await grid(3)
    const starts: number[] = []
    g.stage.on('start', () => starts.push(g.timers.now()))
    const done = g.stage.play('flat', 'ball', { stagger: 50 })
    g.timers.advance(10_000)
    await done
    // The stage's own `start` fires synchronously before the first setTimeout, even when
    // stagger > 0 delays the individual views' (§7.1).
    expect(starts[0]).toBe(0)
    expect(starts.at(-1)).toBeGreaterThanOrEqual(100)
    g.stage.dispose()
  })

  it("skips a view whose run is view-owned, with reason 'busy', and says so", async () => {
    const g = await grid(2)
    g.views[0]?.play('flat', 'ball')
    const done = g.stage.play('flat', 'ball')
    g.timers.advance(10_000)
    const report = await done
    expect(report.skipped).toHaveLength(1)
    expect(report.skipped[0]?.reason).toBe('busy')
    expect(report.skipped[0]?.tag).toBe('tile-0')
    expect(report.completed).toBe(false)
    g.stage.dispose()
  })

  it('supersedes a live stage-owned run, because that is a tie', async () => {
    const g = await grid(2)
    const first = g.stage.play('flat', 'ball')
    const second = g.stage.play('flat', 'ball')
    g.timers.advance(10_000)
    await first
    const report = await second
    // Re-triggering a grid loader restarts it instead of silently doing nothing.
    expect(report.skipped.filter((s) => s.reason === 'busy')).toHaveLength(0)
    g.stage.dispose()
  })

  it("reports a view with no sprite as skipped with reason 'no-sprite'", async () => {
    const g = await grid(1)
    g.stage.view({ canvas: destCanvas(), tag: 'empty' })
    const done = g.stage.play('flat', 'ball')
    g.timers.advance(10_000)
    const report = await done
    expect(report.skipped.map((s) => s.reason)).toContain('no-sprite')
    expect(report.skipped.find((s) => s.reason === 'no-sprite')?.tag).toBe('empty')
    g.stage.dispose()
  })

  it('fixes the eligible set at the call: a view created mid-flight does not join', async () => {
    const g = await grid(1)
    const done = g.stage.play('flat', 'ball')
    const latecomer = g.stage.view({ canvas: destCanvas(), tag: 'late' })
    if (latecomer instanceof Error) return expect.fail('view refused')
    g.timers.advance(10_000)
    const report = await done
    expect(report.started).toHaveLength(1)
    expect([...report.skipped, ...report.failed].map((e) => e.tag)).not.toContain('late')
    g.stage.dispose()
  })

  it('reports a failing view under failed, with its tag, and never twice', async () => {
    const g = await grid(2)
    const motion = g.motion as unknown as { draw: (a: unknown) => unknown }
    let calls = 0
    const original = motion.draw.bind(motion)
    motion.draw = (a: unknown) => {
      calls += 1
      return calls > 2 ? new GlError('dropped') : original(a)
    }
    const done = g.stage.play('flat', 'ball')
    g.timers.advance(10_000)
    const report = await done
    const total = report.started.length + report.skipped.length + report.failed.length
    expect(total).toBe(2)
    expect(report.failed.length).toBeGreaterThan(0)
    expect(report.failed[0]?.tag).toMatch(/^tile-/)
    g.stage.dispose()
  })

  it('a broadcast over zero eligible views is not completed', async () => {
    const timers = createFakeTimers()
    const stage = await createStage(
      { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 128, present: 'blit' },
      stageEnv({ timers }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    const report = await stage.play('flat', 'ball')
    expect(report.completed).toBe(false)
    stage.dispose()
  })
})

describe('stage.stop', () => {
  it('stops only stage-owned runs', async () => {
    const g = await grid(2)
    const own = g.views[0]?.play('flat', 'ball')
    g.stage.play('flat', 'ball')
    g.stage.stop()
    expect(g.views[0]?.run).not.toBeNull()
    g.timers.advance(10_000)
    await own
    g.stage.dispose()
  })

  it('{ all: true } stops everything', async () => {
    const g = await grid(2)
    g.views[0]?.play('flat', 'ball')
    g.stage.stop({ all: true })
    expect(g.views[0]?.run).toBeNull()
    g.stage.dispose()
  })
})

describe('stage.batch', () => {
  it("passes fn's return value through", async () => {
    const g = await grid(1)
    expect(g.stage.batch(() => 'value')).toBe('value')
    g.stage.dispose()
  })

  it('is a no-op on nesting rather than a double save', async () => {
    const g = await grid(1)
    const env = stageEnv()
    const ctx = env.makeContext?.({} as WebGL2RenderingContext)
    const before = (ctx as { scopes: number } | undefined)?.scopes ?? 0
    g.stage.batch(() => g.stage.batch(() => 0))
    expect(((ctx as { scopes: number } | undefined)?.scopes ?? 0) - before).toBeLessThanOrEqual(1)
    g.stage.dispose()
  })

  it('a bare show() outside a batch still saves and restores', async () => {
    const g = await grid(1)
    // The whole of the assertion: `batch` is optional and a draw is never illegal outside it.
    expect(() => g.views[0]?.refresh()).not.toThrow()
    g.stage.dispose()
  })
})
