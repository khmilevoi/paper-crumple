import { ABORTED, type Aborted } from '@paper-crumple/core'
import { abortVar, action, clearStack, context, isAbort, withAbort, wrap } from '@reatom/core'
import { describe, expect, it, vi } from 'vitest'
import { reatomRun } from './run.js'
import { createRun } from './testing.js'

function isolated(test: () => void | Promise<void>) {
  return async () => {
    const frame = context.start()
    try {
      await frame.run(test)
    } finally {
      frame.run(context.reset)
      clearStack()
    }
  }
}

describe('reatomRun', () => {
  it(
    'keeps the already-started raw run and exposes stop synchronously',
    isolated(() => {
      const stop = vi.fn()
      const handle = createRun<{ completed: boolean } | Error | Aborted>(stop)
      const raw = handle.run

      const model = reatomRun<{ completed: boolean }>(raw, 'run.sync')
      model.stop()

      expect(stop).toHaveBeenCalledTimes(1)
      expect(model.raw).toBe(raw)
      handle.settle({ completed: true })
    }),
  )

  it(
    'starts one native tracker immediately and keeps one completion promise',
    isolated(async () => {
      const handle = createRun<number | Error | Aborted>(() => {})
      const model = reatomRun<number>(handle.run, 'run.once')
      const subscriptions = [
        model.completion.data.subscribe(),
        model.completion.error.subscribe(),
        model.completion.pending.subscribe(),
        model.completion.ready.subscribe(),
      ]

      expect(model.completion.pending()).toBe(1)
      expect(model.completion.ready()).toBe(false)
      expect(model.completion.data()).toBeNull()
      expect(model.completion.done).toBe(model.completion.done)
      expect(model.completion.pending()).toBe(1)

      handle.settle(7)
      const [first, second] = await wrap(
        Promise.all([model.completion.done, model.completion.done]),
      )
      expect(first).toBe(7)
      expect(second).toBe(7)
      expect(model.completion.data()).toBe(7)
      expect(model.completion.error()).toBeUndefined()
      expect(model.completion.pending()).toBe(0)
      expect(model.completion.ready()).toBe(true)

      subscriptions.forEach((unsubscribe) => unsubscribe())
    }),
  )

  it(
    'turns core Error and ABORTED values into native rejected completion state',
    isolated(async () => {
      const failure = new Error('failed')
      const failedHandle = createRun<string | Error | Aborted>(() => {})
      const failedDone = failedHandle.run.done
      let failedSignal: AbortSignal | undefined
      Object.defineProperty(failedHandle.run, 'done', {
        get() {
          failedSignal = abortVar.require().signal
          return failedDone
        },
      })
      const failed = reatomRun<string>(failedHandle.run, 'run.failed')
      const failedRemove = vi.spyOn(failedSignal as AbortSignal, 'removeEventListener')
      failedHandle.settle(failure)

      const [failedOutcome] = await wrap(Promise.allSettled([failed.completion.done]))
      expect(failedOutcome).toEqual({ status: 'rejected', reason: failure })
      expect(failed.completion.data()).toBeNull()
      expect(failed.completion.error()).toBe(failure)
      expect(failed.completion.pending()).toBe(0)
      expect(failed.completion.ready()).toBe(true)
      expect(failedRemove).toHaveBeenCalledWith('abort', expect.any(Function))

      const abortedHandle = createRun<string | Error | Aborted>(() => {})
      const abortedDone = abortedHandle.run.done
      let abortedSignal: AbortSignal | undefined
      Object.defineProperty(abortedHandle.run, 'done', {
        get() {
          abortedSignal = abortVar.require().signal
          return abortedDone
        },
      })
      const aborted = reatomRun<string>(abortedHandle.run, 'run.aborted')
      const abortedRemove = vi.spyOn(abortedSignal as AbortSignal, 'removeEventListener')
      abortedHandle.settle(ABORTED)
      const [outcome] = await wrap(Promise.allSettled([aborted.completion.done]))

      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected') expect(isAbort(outcome.reason)).toBe(true)
      expect(aborted.completion.data()).toBeNull()
      expect(aborted.completion.error()).toBeUndefined()
      expect(aborted.completion.pending()).toBe(0)
      expect(aborted.completion.ready()).toBe(true)
      expect(abortedRemove).toHaveBeenCalledWith('abort', expect.any(Function))
    }),
  )

  it(
    'forwards every stop call after settlement to the owned raw run',
    isolated(async () => {
      const stop = vi.fn()
      const handle = createRun<number | Error | Aborted>(stop)
      const model = reatomRun<number>(handle.run, 'run.stop')
      handle.settle(3)
      await wrap(model.completion.done)

      model.stop()
      model.stop()

      expect(stop).toHaveBeenCalledTimes(2)
    }),
  )

  it('owns cancellation in the context that created the model and cleans settled listeners', async () => {
    const owner = context.start()
    const firstStop = vi.fn()
    const firstHandle = createRun<number | Error | Aborted>(firstStop)
    const firstDone = firstHandle.run.done
    let firstSignal: AbortSignal | undefined
    Object.defineProperty(firstHandle.run, 'done', {
      get() {
        firstSignal = abortVar.require().signal
        return firstDone
      },
    })
    const first = owner.run(() => reatomRun<number>(firstHandle.run, 'run.owner.first'))
    const firstRemove = vi.spyOn(firstSignal as AbortSignal, 'removeEventListener')

    expect(owner.run(first.completion.pending)).toBe(1)
    firstHandle.settle(1)
    await first.completion.done
    expect(firstRemove).toHaveBeenCalledWith('abort', expect.any(Function))

    const secondStop = vi.fn(() => secondHandle.settle(ABORTED))
    const secondHandle = createRun<number | Error | Aborted>(secondStop)
    const secondRawDone = secondHandle.run.done
    let secondSignal: AbortSignal | undefined
    Object.defineProperty(secondHandle.run, 'done', {
      get() {
        secondSignal = abortVar.require().signal
        return secondRawDone
      },
    })
    let second!: ReturnType<typeof reatomRun<number>>
    let hold: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      hold = resolve
    })
    const own = owner.run(() =>
      action(async () => {
        second = reatomRun<number>(secondHandle.run, 'run.owner.second')
        await wrap(held)
      }, 'run.owner').extend(withAbort('manual')),
    )
    const ownerDone = owner.run(own)
    const secondRemove = vi.spyOn(secondSignal as AbortSignal, 'removeEventListener')
    const secondDone = second.completion.done

    owner.run(own.abort)
    hold()
    const [ownerOutcome, outcome] = await Promise.allSettled([ownerDone, secondDone])

    expect(ownerOutcome.status).toBe('rejected')
    expect(outcome.status).toBe('rejected')
    if (outcome.status === 'rejected') expect(isAbort(outcome.reason)).toBe(true)
    expect(firstStop).not.toHaveBeenCalled()
    expect(secondStop).toHaveBeenCalledTimes(1)
    expect(secondRemove).toHaveBeenCalledWith('abort', expect.any(Function))
    clearStack()
  })

  it('publishes native state in a non-default owner context', async () => {
    const owner = context.start()
    const handle = createRun<{ ok: true } | Error | Aborted>(() => {})
    const model = owner.run(() => reatomRun<{ ok: true }>(handle.run, 'run.context'))

    expect(owner.run(model.completion.pending)).toBe(1)
    expect(owner.run(model.completion.data)).toBeNull()
    handle.settle({ ok: true })
    await model.completion.done

    expect(owner.run(model.completion.data)).toEqual({ ok: true })
    expect(owner.run(model.completion.ready)).toBe(true)
    owner.run(context.reset)
    clearStack()
  })

  it(
    'keeps automatic rejection handled while preserving the rejected done promise',
    isolated(async () => {
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      try {
        const failure = new Error('unobserved by caller')
        const handle = createRun<number | Error | Aborted>(() => {})
        const model = reatomRun<number>(handle.run, 'run.handled')
        handle.settle(failure)
        await wrap(new Promise((resolve) => setTimeout(resolve, 0)))

        expect(unhandled).not.toHaveBeenCalled()
        const [outcome] = await wrap(Promise.allSettled([model.completion.done]))
        expect(outcome).toEqual({ status: 'rejected', reason: failure })
      } finally {
        process.off('unhandledRejection', unhandled)
      }
    }),
  )

  it(
    'freezes a non-callable completion facade without tracker controls',
    isolated(() => {
      const handle = createRun<number | Error | Aborted>(() => {})
      const model = reatomRun<number>(handle.run, 'run.facade')

      expect(Object.isFrozen(model.completion)).toBe(true)
      expect(typeof model.completion).toBe('object')
      expect(Object.keys(model.completion)).toEqual(['done', 'data', 'error', 'pending', 'ready'])
      expect(model.completion).not.toHaveProperty('retry')
      expect(model.completion).not.toHaveProperty('reset')
      expect(model.completion).not.toHaveProperty('abort')
      handle.settle(1)
    }),
  )
})
