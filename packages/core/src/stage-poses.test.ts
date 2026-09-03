import { describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { PoseError } from './errors.js'
import { createStage } from './stage.js'
import { createFakeTimers } from './testing/fake-timers.js'
import { fakeMotion, fakeSheet, stageEnv, type FakeMotionOptions } from './testing/fake-slots.js'

function destCanvas() {
  return {
    width: 64,
    height: 64,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
  } as unknown as HTMLCanvasElement
}

async function scene(options: FakeMotionOptions) {
  const timers = createFakeTimers()
  const sheet = fakeSheet()
  const motion = fakeMotion(options)
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    stageEnv({ timers }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  const view = stage.view({ canvas: destCanvas(), tag: 'tile' })
  if (view instanceof Error) return expect.fail('view refused')
  // A closure does not inherit the narrowing the guard above gave `stage`; a const after it does.
  const live = stage
  async function sprite(key: string) {
    const s = await live.add(`/${key}.png`, { key })
    if (s instanceof Error || isAborted(s)) return expect.fail('add refused')
    return s
  }
  return { stage, timers, view, sprite }
}

/** See `crumple-stage.test.ts`: a real macrotask boundary, so the target's settlement lands. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("MotionClip.dwells is the view's schedule (§7.2)", () => {
  it("plays a three-pose clip on the clip's own table, and resolves 'ball' to its last pose", async () => {
    const s = await scene({ poseCount: 3, dwells: [10, 20, 30] })
    s.view.show(await s.sprite('a'))
    const steps: Array<{ pose: number; ms: number }> = []
    s.view.on('step', (e) => steps.push({ pose: e.pose, ms: e.ms }))
    const run = s.view.play('flat', 'ball')
    s.timers.advance(10_000)
    await run
    expect(steps).toEqual([
      { pose: 0, ms: 0 },
      { pose: 1, ms: 10 },
      { pose: 2, ms: 30 },
    ])
    expect(s.view.pose).toBe(2)
    s.stage.dispose()
  })

  it('swaps through the table too: the rise and the fall both walk its gaps', async () => {
    const s = await scene({ poseCount: 3, dwells: [10, 20, 30] })
    s.view.show(await s.sprite('a'))
    const b = await s.sprite('b')
    const steps: Array<{ pose: number; ms: number }> = []
    s.view.on('step', (e) => steps.push({ pose: e.pose, ms: e.ms }))
    const run = s.view.crumpleTo(b)
    s.timers.advance(10_000)
    await flushMicrotasks()
    s.timers.advance(10_000)
    expect(await run).toBeUndefined()
    expect(steps.map((x) => x.pose)).toEqual([0, 1, 2, 1, 0])
    // The rise, against the run's start; the fall is re-based on leaving the ball (§7.2), so only
    // its gap — `dwells[1]` — is a fixed number.
    expect(steps.slice(0, 3).map((x) => x.ms)).toEqual([0, 10, 30])
    expect(steps[4].ms - steps[3].ms).toBe(20)
    s.stage.dispose()
  })

  it('rebuilds the controller when the table changes, and the view is idle — not disposed — after it', async () => {
    let table: readonly number[] = [10, 20, 30]
    const s = await scene({
      poseCount: 3,
      get dwells() {
        return table
      },
    })
    const a = await s.sprite('a')
    table = [5, 5, 5]
    const b = await s.sprite('b')

    s.view.show(a)
    const first = s.view.play('flat', 'ball')
    s.timers.advance(10_000)
    await first

    // Same pose count, a different table: the controller is re-created for this play — and this
    // play is refused, which is exactly when the runner's `'disposed'` announcement used to stick.
    s.view.show(b)
    const refused = await s.view.play(7, 'flat')
    expect(refused).toBeInstanceOf(PoseError)
    expect(s.view.state).toBe('idle')
    expect(s.view.run).toBeNull()

    const steps: number[] = []
    s.view.on('step', (e) => steps.push(e.ms))
    const again = s.view.play('flat', 'ball')
    expect(s.view.state).toBe('playing')
    s.timers.advance(10_000)
    expect(await again).toBeUndefined()
    expect(steps).toEqual([0, 5, 10])
    s.stage.dispose()
  })

  it('keeps one controller while the table is the same reference', async () => {
    const table: readonly number[] = [10, 20, 30]
    const s = await scene({ poseCount: 3, dwells: table })
    s.view.show(await s.sprite('a'))
    const b = await s.sprite('b')
    const ends: boolean[] = []
    s.view.on('end', (e) => ends.push(e.completed))
    const first = s.view.play('flat', 'ball')
    s.timers.advance(10_000)
    await first
    s.view.show(b)
    const second = s.view.play('ball', 'flat')
    s.timers.advance(10_000)
    await second
    // Two runs, two completed ends — and no `completed: false` from a controller torn down
    // between them.
    expect(ends).toEqual([true, true])
    s.stage.dispose()
  })
})
