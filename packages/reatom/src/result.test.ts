import { ABORTED, type Aborted } from '@paper-crumple/core'
import {
  abortVar,
  action,
  type AsyncExt,
  clearStack,
  context,
  isAbort,
  throwAbort,
  withAsyncData,
  withCallHook,
  wrap,
} from '@reatom/core'
import { describe, expect, it } from 'vitest'
import { toAsyncValue } from './result.js'

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

describe('Result conversion into native Reatom async state', () => {
  it(
    'preserves successful values and ordinary Error identity',
    isolated(() => {
      const value = { id: 7 }
      const failure = new Error('aborted is only text')
      expect(toAsyncValue(value)).toBe(value)
      expect(toAsyncValue(undefined)).toBeUndefined()
      expect(() => toAsyncValue(failure)).toThrow(failure)
      expect(isAbort(failure)).toBe(false)
    }),
  )

  it(
    'converts deferred Result fulfillment into native outcomes, events and status',
    isolated(async () => {
      const operation = action(
        async (input: Promise<number | Error | Aborted>) => toAsyncValue(await wrap(input)),
        'result.operation',
      ).extend(withAsyncData({ initState: 0, status: true }))
      const control = action(async (input: Promise<number | Error | Aborted>) => {
        const value = await wrap(input)
        if (value === ABORTED) return throwAbort()
        if (value instanceof Error) return Promise.reject(value)
        return value
      }, 'result.control').extend(withAsyncData({ initState: 0, status: true }))
      const unconverted = action(
        async (input: Promise<number | Error | Aborted>) => await wrap(input),
        'result.unconverted',
      ).extend(withAsyncData({ initState: 0, status: true }))
      const snapshot = (target: typeof operation) => ({
        data: target.data(),
        error: target.error(),
        pending: target.pending(),
        ready: target.ready(),
        status: target.status(),
      })
      const observe = <T>(
        target: AsyncExt<[Promise<number | Error | Aborted>], T, Error | undefined>,
      ) => {
        const rejected: unknown[] = []
        const settled: unknown[] = []
        target.onReject.extend(withCallHook(({ error }) => rejected.push(error)))
        target.onSettle.extend(withCallHook((result) => settled.push(result)))
        return { rejected, settled }
      }
      const actualEvents = observe(operation)
      const nativeEvents = observe(control)
      const rawEvents = observe(unconverted)
      const failure = new Error('failed')
      for (const value of [7, failure, ABORTED, 9] as const) {
        let finish: (value: number | Error | Aborted) => void = () => {}
        const input = new Promise<number | Error | Aborted>((resolve) => {
          finish = resolve
        })
        const actual = operation(input)
        const native = control(input)
        const raw = unconverted(input)
        const previousSettled = actualEvents.settled.length
        expect(snapshot(operation)).toEqual(snapshot(control))
        expect(operation.pending()).toBe(1)
        expect(operation.ready()).toBe(false)
        expect(operation.status().isPending).toBe(true)
        finish(value)
        const [actualResult, nativeResult, rawResult] = await wrap(
          Promise.allSettled([actual, native, raw]),
        )
        expect(rawResult).toEqual({ status: 'fulfilled', value })
        expect(unconverted.data()).toBe(value)
        expect(unconverted.error()).toBeUndefined()
        expect(unconverted.status().isFulfilled).toBe(true)
        expect(rawEvents.rejected).toEqual([])
        expect(rawEvents.settled.at(-1)).toEqual({ payload: value, params: [input] })
        if (value === ABORTED) {
          expect(actualResult.status).toBe('rejected')
          expect(nativeResult.status).toBe('rejected')
          if (actualResult.status === 'rejected' && nativeResult.status === 'rejected') {
            expect(isAbort(actualResult.reason)).toBe(true)
            expect(isAbort(nativeResult.reason)).toBe(true)
            expect(actualEvents.settled.at(-1)).toEqual({
              error: actualResult.reason,
              params: [input],
            })
            expect(nativeEvents.settled.at(-1)).toEqual({
              error: nativeResult.reason,
              params: [input],
            })
          }
          // Cancellation settles, but does not add another onReject event.
          expect(actualEvents.rejected).toEqual([failure])
          expect(nativeEvents.rejected).toEqual([failure])
          expect(operation.data()).toBe(7)
        } else if (value === failure) {
          expect(actualResult).toEqual({ status: 'rejected', reason: failure })
          expect(nativeResult).toEqual({ status: 'rejected', reason: failure })
          if (actualResult.status === 'rejected' && nativeResult.status === 'rejected') {
            expect(actualResult.reason).toBe(failure)
            expect(nativeResult.reason).toBe(failure)
          }
          expect(actualEvents.rejected).toEqual([failure])
          expect(nativeEvents.rejected).toEqual([failure])
          expect(actualEvents.settled.at(-1)).toEqual({ error: failure, params: [input] })
          expect(nativeEvents.settled.at(-1)).toEqual({ error: failure, params: [input] })
          expect(operation.status().isRejected).toBe(true)
        } else {
          expect(actualResult).toEqual({ status: 'fulfilled', value })
          expect(nativeResult).toEqual({ status: 'fulfilled', value })
          expect(actualEvents.settled.at(-1)).toEqual({ payload: value, params: [input] })
          expect(nativeEvents.settled.at(-1)).toEqual({ payload: value, params: [input] })
          expect(operation.status().isFulfilled).toBe(true)
        }
        expect(actualEvents.settled).toHaveLength(previousSettled + 1)
        expect(nativeEvents.settled).toHaveLength(previousSettled + 1)
        expect(rawEvents.settled).toHaveLength(previousSettled + 1)
        if (value === failure) expect(operation.error()).toBe(failure)
        expect(snapshot(operation)).toEqual(snapshot(control))
        expect(operation.pending()).toBe(0)
      }
      // 1001.3.0 exposes reset on actions, but only reactive targets support it.
      expect(() => operation.reset()).toThrow('Only reactive atoms can be reset')
      expect(() => control.reset()).toThrow('Only reactive atoms can be reset')
      operation.data.reset()
      control.data.reset()
      expect(snapshot(operation)).toEqual(snapshot(control))
      expect(operation.data()).toBe(0)
    }),
  )

  it(
    'keeps the active signal when converting a cancellation',
    isolated(async () => {
      let observed: AbortSignal | undefined
      const operation = action(async () => {
        const signal = abortVar.require().signal
        observed = signal
        try {
          return toAsyncValue<number>(ABORTED)
        } finally {
          expect(abortVar.require().signal).toBe(signal)
          expect(signal.aborted).toBe(false)
        }
      }, 'result.signal').extend(withAsyncData({ initState: 0 }))
      const [result] = await wrap(Promise.allSettled([operation()]))
      expect(observed).toBeInstanceOf(AbortSignal)
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(isAbort(result.reason)).toBe(true)
      expect(operation.error()).toBeUndefined()
    }),
  )

  it(
    'propagates native action cancellation through the active signal',
    isolated(async () => {
      let signal: AbortSignal | undefined
      let finish: (value: number) => void = () => {}
      const operation = action(async () => {
        signal = abortVar.require().signal
        return toAsyncValue(
          await wrap(
            new Promise<number>((resolve) => {
              finish = resolve
            }),
          ),
        )
      }, 'result.callerAbort').extend(withAsyncData({ initState: 0 }))
      const pending = Promise.allSettled([operation()])
      operation.abort()
      finish(7)
      const [result] = await wrap(pending)
      expect(signal?.aborted).toBe(true)
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(isAbort(result.reason)).toBe(true)
      expect(operation.data()).toBe(0)
      expect(operation.error()).toBeUndefined()
      expect(operation.pending()).toBe(0)
    }),
  )
})
