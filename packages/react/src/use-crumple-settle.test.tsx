/**
 * @vitest-environment jsdom
 */
import {
  SheetError,
  type PlayResult,
  type Run,
  type Sprite,
  type SwapResult,
} from '@paper-crumple/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import {
  createRunController,
  type CrumpleTarget,
  type RunController,
} from '../../core/src/runner.js'
import { createFakeTimers } from '../../core/src/testing/fake-timers.js'
import { acquire } from './acquire.js'
import { createFakeStage } from './testing/fake-stage.js'
import { readyScene, renderCrumple } from './testing/crumple-probe.js'
import { deferred } from './testing/deferred.js'
import { flush } from './testing/render.js'
import { useCrumple } from './use-crumple.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Keep core's synchronous lifecycle and run results; only pixels and time are fake. */
function installRealRuns(
  fake: ReturnType<typeof createFakeStage>,
  options: { poseCount?: number; render?: () => Error | undefined } = {},
) {
  const timers = createFakeTimers()
  const controllers: RunController<Sprite>[] = []
  const runs: Run<PlayResult | SwapResult>[] = []
  const createView = fake.stage.view.bind(fake.stage)
  vi.spyOn(fake.stage, 'view').mockImplementation((target) => {
    const view = createView(target)
    if (view instanceof Error) return view
    const handle = fake.views.find((candidate) => candidate.view === view)
    if (handle === undefined) return view
    const poseCount = options.poseCount ?? 2
    const controller = createRunController<Sprite>(
      {
        timers,
        emit: (event, payload) => handle.emit(event, payload),
        reportError: (error) => fake.emit('error', { error, observed: false, view }),
        render: (pose) => {
          view.draw(pose)
          return options.render?.()
        },
        frameFor: (pose) => pose,
        setState: (state) => handle.setState(state),
      },
      { poseCount, dwells: Array.from({ length: poseCount }, () => 10) },
    )
    controllers.push(controller)
    // Source and built declarations give ABORTED distinct unique-symbol types, but both use
    // Symbol.for('paper-crumple.aborted') at runtime. Bridge that declaration boundary here.
    const remember = <R extends PlayResult | SwapResult>(run: Run<unknown>): Run<R> => {
      const published = run as Run<R>
      runs.push(published)
      return published
    }
    vi.spyOn(view, 'play').mockImplementation((from, to, opts) =>
      remember<PlayResult>(controller.play(from, to, opts)),
    )
    vi.spyOn(view, 'swapTo').mockImplementation((_src, opts) =>
      remember<SwapResult>(
        controller.crumple(view.pose, fake.addSprite(opts?.key ?? 'target'), {
          ...opts,
          adopt: (sprite) => view.show(sprite),
        }),
      ),
    )
    vi.spyOn(view, 'crumpleTo').mockImplementation((sprite, opts) =>
      remember<SwapResult>(
        controller.crumple(view.pose, sprite as CrumpleTarget<Sprite>, {
          ...opts,
          adopt: (next) => view.show(next),
        }),
      ),
    )
    vi.spyOn(view, 'stop').mockImplementation(() => controller.stop())
    const dispose = view.dispose.bind(view)
    vi.spyOn(view, 'dispose').mockImplementation(() => {
      controller.dispose()
      dispose()
    })
    return view
  })
  return { controllers, runs, timers }
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches, media: query }) as unknown as MediaQueryList),
  )
}

test('a flat entrance settles once and leaves pending null (§2.1)', async () => {
  const onSettle = vi.fn()
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  // The DEFAULT entrance. Under a three-clear-site reading this request would latch on
  // `acquiring` forever and never settle; §2.1's "exactly once per request that reaches an
  // outcome" says otherwise.
  expect(probe.current.pending).toBeNull()
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(onSettle).toHaveBeenCalledWith({ key: 'a', error: null, reduced: false })
  await probe.unmount()
})

test('an uncrumple entrance is pending: entering with the run, and settles at its end (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', entrance: 'uncrumple', onSettle },
    { scene: readyScene(fake.stage) },
  )
  expect(probe.current.pending).toMatchObject({ key: 'a', phase: 'entering' })
  expect(probe.current.pending?.run).not.toBeNull()
  expect(onSettle).not.toHaveBeenCalled()
  fake.views[0]?.settleRun(undefined)
  await flush()
  expect(probe.current.pending).toBeNull()
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(onSettle).toHaveBeenCalledWith({ key: 'a', error: null, reduced: false })
  await probe.unmount()
})

test('an uncrumple entrance under reduce settles with reduced: true (§2.1)', async () => {
  stubReducedMotion(true)
  const onSettle = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', entrance: 'uncrumple', onSettle },
    { scene: readyScene(createFakeStage().stage) },
  )
  expect(onSettle).toHaveBeenCalledWith({ key: 'a', error: null, reduced: true })
  await probe.unmount()
})

test('a failed acquisition settles with the error and clears pending (§2.1, §7)', async () => {
  const failed = new SheetError('the source never decoded')
  const onSettle = vi.fn()
  const onError = vi.fn()
  const fake = createFakeStage({ add: async () => failed })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle, onError },
    { scene: readyScene(fake.stage) },
  )
  await flush()
  expect(probe.current.pending).toBeNull()
  expect(probe.current.error).toBe(failed)
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(onSettle).toHaveBeenCalledWith({ key: 'a', error: failed, reduced: false })
  // The error keeps its existing route as well: one value, two exits, both observed (§7).
  expect(onError).toHaveBeenCalledTimes(1)
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: failed, observed: true }))
  await probe.unmount()
})

test('an unmounted request never settles (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', entrance: 'uncrumple', onSettle },
    { scene: readyScene(fake.stage) },
  )
  const view = fake.views[0]
  expect(view).toBeDefined()
  if (view === undefined) return
  onSettle.mockClear()
  await probe.unmount()
  view.settleRun(undefined)
  await flush()
  expect(onSettle).not.toHaveBeenCalled()
})

test('a request that opens sets pending: acquiring before anything is known (§2.1)', async () => {
  const fake = createFakeStage({ add: () => new Promise(() => undefined) })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  expect(probe.current.pending).toEqual({ key: 'a', phase: 'acquiring', run: null })
  await probe.unmount()
})

test('a superseded entrance never settles, and never clears its successor pending (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', entrance: 'uncrumple', onSettle },
    { scene: readyScene(fake.stage) },
  )
  const opened = probe.current.pending
  expect(opened?.phase).toBe('entering')
  if (opened === null || opened.phase !== 'entering') return
  const superseded = opened.run
  // Supersession bumps `live.seq`, so the entrance's own continuation is stale from here on.
  await probe.rerender({
    options: { spriteKey: 'b', src: 'b.png', entrance: 'uncrumple', onSettle },
  })
  onSettle.mockClear()
  // `stop()` settles the superseded run with ABORTED — the microtask §2.1 warns about, the one
  // that would otherwise fire for a dead request and clear the LIVE request's `pending` on the
  // way past.
  await probe.run(() => {
    superseded.stop()
  })
  expect(onSettle).not.toHaveBeenCalled()
  expect(probe.current.pending).not.toBeNull()
  expect(probe.current.pending?.key).toBe('b')
  await probe.unmount()
})

test('a settled entrance settles exactly once, across re-renders and a repeat settlement (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage()
  const options = { spriteKey: 'a', src: 'a.png', entrance: 'uncrumple' as const, onSettle }
  const probe = await renderCrumple(options, { scene: readyScene(fake.stage) })
  fake.views[0]?.settleRun(undefined)
  await flush()
  expect(onSettle).toHaveBeenCalledTimes(1)
  // Nothing downstream of the settlement may fire it a second time: neither a second settlement
  // of the same run, nor a re-render with the same request, nor a bare store bump.
  fake.views[0]?.settleRun(undefined)
  await flush()
  await probe.rerender({ options: { ...options } })
  await probe.run(() => {
    probe.current.sync()
  })
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(probe.current.pending).toBeNull()
  await probe.unmount()
})

test('an animated swap is pending: swapping with the run, and settles at the run s end (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  onSettle.mockClear()
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onSettle } })
  expect(probe.current.pending).toMatchObject({ key: 'b', phase: 'swapping' })
  expect(probe.current.pending?.run).not.toBeNull()
  expect(onSettle).not.toHaveBeenCalled()
  fake.views[0]?.settleRun(undefined)
  await flush()
  expect(probe.current.pending).toBeNull()
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(onSettle).toHaveBeenCalledWith({ key: 'b', error: null, reduced: false })
  await probe.unmount()
})

test('the ball is not a settlement: pending outlives shown moving (§0.1, §2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage({ sprites: ['a', 'b'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  onSettle.mockClear()
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onSettle } })
  const view = fake.views[0]
  expect(view).toBeDefined()
  if (view === undefined) return
  // Core's `adopt` runs at the ball, between the descent's first two renders, so `shown` reads the
  // TARGET while the fold is still descending. That is the trap §0.1 records; `pending` beside it
  // is the code answer.
  view.view.show({ key: 'b' } as unknown as Parameters<typeof view.view.show>[0])
  view.emit('step', { pose: 5, frame: 1, ms: 16 })
  await flush()
  expect(probe.current.shown).toBe('b')
  expect(probe.current.pending).toMatchObject({ key: 'b', phase: 'swapping' })
  expect(onSettle).not.toHaveBeenCalled()
  await probe.unmount()
})

test('a rolled-back swap settles once, with the error (§2.1, §2.6)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  onSettle.mockClear()
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onSettle } })
  const failed = new SheetError('the target never arrived')
  fake.views[0]?.settleRun(failed)
  await flush()
  expect(probe.current.pending).toBeNull()
  expect(probe.current.error).toBe(failed)
  expect(probe.current.shown).toBe('a')
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(onSettle).toHaveBeenCalledWith({ key: 'b', error: failed, reduced: false })
  await probe.unmount()
})

test('a degraded swap settles reduced: true, where no end event exists to hear (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage({ sprites: ['a', 'b'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  onSettle.mockClear()
  stubReducedMotion(true)
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onSettle } })
  await flush()
  expect(fake.calls.filter((c) => c.method === 'view.swapTo')).toHaveLength(0)
  expect(probe.current.pending).toBeNull()
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(onSettle).toHaveBeenCalledWith({ key: 'b', error: null, reduced: true })
  await probe.unmount()
})

test('a superseded swap never settles, and its successor settles once (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  onSettle.mockClear()
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onSettle } })
  const opened = probe.current.pending
  expect(opened?.phase).toBe('swapping')
  if (opened === null || opened.phase !== 'swapping') return
  // `b`'s run has to be captured here: the fake settles only the run it handed out LAST
  // (`testing/fake-stage.ts:150`), so once `c` has opened, `settleRun` can no longer reach `b`.
  const superseded = opened.run
  await probe.rerender({ options: { spriteKey: 'c', src: 'c.png', onSettle } })
  // The `b` run settles late, after `c` superseded it. The superseded request reports nothing at
  // all — "React changed its mind" is not an outcome a consumer renders — and it must not clear
  // the live request's `pending` on its way past.
  await probe.run(() => {
    superseded.stop()
  })
  expect(onSettle).not.toHaveBeenCalled()
  expect(probe.current.pending).toMatchObject({ key: 'c', phase: 'swapping' })
  fake.views[0]?.settleRun(undefined)
  await flush()
  expect(onSettle).toHaveBeenCalledTimes(1)
  expect(onSettle).toHaveBeenCalledWith({ key: 'c', error: null, reduced: false })
  expect(probe.current.pending).toBeNull()
  await probe.unmount()
})

test('stopping a LIVE run cancels the request: no settlement, and pending is cleared (§2.1)', async () => {
  stubReducedMotion(false)
  const onSettle = vi.fn()
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  onSettle.mockClear()
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onSettle } })
  const opened = probe.current.pending
  expect(opened?.phase).toBe('swapping')
  if (opened === null || opened.phase !== 'swapping') return
  // §2.1 puts the run on `pending` precisely so a consumer can stop it. Nothing supersedes this
  // request, so `seq` is still live and the continuation is NOT stale — the cancellation has to be
  // recognised as one. A stop is none of the three outcomes `onSettle` documents, and `ABORTED` is
  // a sentinel rather than an `Error`, so mapping it to `error: null` would report a request that
  // never arrived as a success.
  await probe.run(() => {
    opened.run.stop()
  })
  expect(onSettle).not.toHaveBeenCalled()
  expect(probe.current.pending).toBeNull()
  expect(probe.current.error).toBeNull()
  await probe.unmount()
})

test('a cancelled request neither sets nor clears the standing error (§2.1, §5.1)', async () => {
  stubReducedMotion(false)
  const boom = new SheetError('the stage reported this while the fold was running')
  const onSettle = vi.fn()
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onSettle },
    { scene: readyScene(fake.stage) },
  )
  onSettle.mockClear()
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png', onSettle } })
  const view = fake.views[0]
  const opened = probe.current.pending
  expect(view).toBeDefined()
  expect(opened?.phase).toBe('swapping')
  if (view === undefined || opened === null || opened.phase !== 'swapping') return
  await probe.run(() => {
    fake.emit('error', { error: boom, observed: false, view: view.view })
  })
  expect(probe.current.error).toBe(boom)
  // A cancellation reaches no outcome at all, so it is neither the moment a previous failure goes
  // stale nor a failure of its own: `error` is left exactly as the cancelled request found it.
  await probe.run(() => {
    opened.run.stop()
  })
  expect(onSettle).not.toHaveBeenCalled()
  expect(probe.current.error).toBe(boom)
  await probe.unmount()
})

test('a degraded retry clears the rolled-back error it recovers from (§2.6, §5.1)', async () => {
  stubReducedMotion(false)
  const failed = new SheetError('the target never arrived')
  const fake = createFakeStage({ sprites: ['a'] })
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(fake.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  fake.views[0]?.settleRun(failed)
  await flush()
  expect(probe.current.error).toBe(failed)
  expect(probe.current.status).toBe('rolled-back')
  // The escape §2.6 added, taken under the accommodation §5.3 added: the degraded swap emits no
  // `start`, so `onRunStart` — the only other site that clears `error` — never runs, and the notice
  // a consumer renders from `error !== null` would outlive the request that superseded it.
  stubReducedMotion(true)
  await probe.run(() => {
    probe.current.retry()
  })
  expect(probe.current.shown).toBe('b')
  expect(probe.current.error).toBeNull()
  expect(probe.current.status).toBe('shown')
  await probe.unmount()
})

test('a replayed flat entrance clears the error the swap it replaces left standing (§5.1)', async () => {
  stubReducedMotion(false)
  const failed = new SheetError('the target never arrived')
  const first = createFakeStage({ sprites: ['a'] })
  const second = createFakeStage()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png' },
    { scene: readyScene(first.stage) },
  )
  await probe.rerender({ options: { spriteKey: 'b', src: 'b.png' } })
  first.views[0]?.settleRun(failed)
  await flush()
  expect(probe.current.error).toBe(failed)
  // A rebuilt stage hands back a view with nothing in it, so the request replays as an ENTRANCE
  // (§5.4). The default entrance is one `show()` — the second settlement that reaches an outcome
  // with no `start` behind it.
  await probe.rerender({ scene: readyScene(second.stage, { generation: 2 }) })
  await flush()
  expect(second.calls.filter((c) => c.method === 'view.show')).toHaveLength(1)
  expect(probe.current.shown).toBe('b')
  expect(probe.current.error).toBeNull()
  await probe.unmount()
})

test.each(['entrance', 'fresh acquisition', 'shared acquisition'] as const)(
  'retry from synchronous %s onStart leaves a pending handle that stops the successor',
  async (scenario) => {
    const fake = createFakeStage({ sprites: ['a'], add: () => new Promise(() => {}) })
    const real = installRealRuns(fake)
    const onSettle = vi.fn()
    let retried = false
    const onStart = vi.fn(() => {
      if (retried) return
      retried = true
      probe.current.retry()
    })
    const options = {
      spriteKey: 'a',
      src: 'a.png',
      reducedMotion: 'off' as const,
      onSettle,
      onStart,
    }
    const probe = await renderCrumple(options, { scene: null })
    if (scenario === 'entrance') {
      await probe.rerender({
        scene: readyScene(fake.stage),
        options: { ...options, entrance: 'uncrumple' },
      })
    } else {
      await probe.rerender({ scene: readyScene(fake.stage) })
      onSettle.mockClear()
      if (scenario === 'shared acquisition') {
        void acquire(fake.stage, 'b', 'b.png', undefined, new AbortController().signal)
      }
      await probe.rerender({ options: { ...options, spriteKey: 'b', src: 'b.png' } })
      expect(fake.views[0]?.view.crumpleTo).toHaveBeenCalled()
    }
    expect(onStart).toHaveBeenCalledTimes(2)
    expect(real.controllers[0]?.live).toBe(true)
    expect(probe.current.pending?.phase).toBe('swapping')
    await probe.run(() => probe.current.pending?.run?.stop())
    expect(real.controllers[0]?.live).toBe(false)
    expect(probe.current.pending).toBeNull()
    expect(onSettle).not.toHaveBeenCalled()
    await probe.unmount()
  },
)

test('retry from the aborted predecessor onEnd owns the successor controller', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const real = installRealRuns(fake)
  const onStart = vi.fn()
  const onSettle = vi.fn()
  let retried = false
  const onEnd = vi.fn(() => {
    if (retried) return
    retried = true
    probe.current.retry()
  })
  const options = {
    spriteKey: 'a',
    src: 'a.png',
    reducedMotion: 'off' as const,
    onStart,
    onEnd,
    onSettle,
  }
  const probe = await renderCrumple(options, { scene: readyScene(fake.stage) })
  onSettle.mockClear()
  await probe.rerender({ options: { ...options, spriteKey: 'b', src: 'b.png' } })
  await probe.run(() => probe.current.retry())
  // The outer retry became stale during abort; it must not start a third run after onEnd returns.
  expect(onStart).toHaveBeenCalledTimes(2)
  expect(real.controllers[0]?.live).toBe(true)
  await probe.run(() => probe.current.pending?.run?.stop())
  expect(real.controllers[0]?.live).toBe(false)
  expect(probe.current.pending).toBeNull()
  expect(onSettle).not.toHaveBeenCalled()
  await probe.unmount()
})

test('synchronous unmount from onError suppresses onSettle', async () => {
  const failed = new SheetError('the acquisition failed')
  const acquisition = deferred<Sprite | typeof failed>()
  const fake = createFakeStage({ add: () => acquisition.promise })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const onSettle = vi.fn()
  const onError = vi.fn(() => root.unmount())
  const scene = readyScene(fake.stage)
  function Probe() {
    const crumple = useCrumple({ spriteKey: 'a', src: 'a.png', scene, onError, onSettle })
    return createElement('canvas', { ref: crumple.ref })
  }
  await act(async () => root.render(createElement(Probe)))
  await act(async () => acquisition.resolve(failed))
  expect(onError).toHaveBeenCalledTimes(1)
  expect(fake.views[0]?.disposed).toBe(true)
  expect(container.childElementCount).toBe(0)
  expect(onSettle).not.toHaveBeenCalled()
  container.remove()
})

test('synchronous retry from onError settles only the successful successor', async () => {
  const failed = new SheetError('the first acquisition failed')
  const acquisition = deferred<Sprite | typeof failed>()
  let attempts = 0
  const fake = createFakeStage({
    add: async () => {
      attempts += 1
      return attempts === 1 ? acquisition.promise : fake.addSprite('a')
    },
  })
  const onSettle = vi.fn()
  const probe = await renderCrumple(
    { spriteKey: 'a', src: 'a.png', onError: () => probe.current.retry(), onSettle },
    { scene: readyScene(fake.stage) },
  )
  await probe.run(() => acquisition.resolve(failed))
  expect(onSettle).toHaveBeenCalledExactlyOnceWith({ key: 'a', error: null, reduced: false })
  expect(probe.current.error).toBeNull()
  await probe.unmount()
})

test.each(['entrance', 'swap'] as const)(
  'a current %s frame failure survives Run.done resolving undefined',
  async (path) => {
    const boom = new SheetError('render failed')
    const fake = createFakeStage({ sprites: ['a'] })
    let failed = false
    const real = installRealRuns(fake, {
      poseCount: path === 'entrance' ? 1 : 2,
      render: () => {
        if (failed) return undefined
        failed = true
        return boom
      },
    })
    const onError = vi.fn()
    const onEnd = vi.fn()
    const onSettle = vi.fn()
    const options = {
      spriteKey: 'a',
      src: 'a.png',
      reducedMotion: 'off' as const,
      onError,
      onEnd,
      onSettle,
    }
    const probe = await renderCrumple(
      { ...options, entrance: path === 'entrance' ? 'uncrumple' : 'flat' },
      { scene: readyScene(fake.stage) },
    )
    if (path === 'swap') {
      onSettle.mockClear()
      await probe.rerender({ options: { ...options, spriteKey: 'b', src: 'b.png' } })
      await probe.run(() => real.timers.advance(100))
    }
    expect(await real.runs[0]?.done).toBeUndefined()
    expect(onEnd).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ completed: false }))
    expect(probe.current.pending).toBeNull()
    expect(probe.current.error).toBe(boom)
    expect(onSettle).toHaveBeenCalledExactlyOnceWith({
      key: path === 'entrance' ? 'a' : 'b',
      error: boom,
      reduced: false,
    })
    expect(onError).toHaveBeenCalledTimes(1)
    await probe.unmount()
  },
)
