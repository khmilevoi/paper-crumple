import { ABORTED, type Aborted } from '@paper-crumple/core'
import {
  abortVar,
  action,
  clearStack,
  context,
  isAbort,
  throwAbort,
  withAsyncData,
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
    'matches native success, failure, cancellation, recovery and reset state',
    isolated(async () => {
      const operation = action(
        async (value: number | Error | Aborted) => toAsyncValue(value),
        'result.operation',
      ).extend(withAsyncData({ initState: 0 }))
      const control = action(async (value: number | Error | Aborted) => {
        if (value === ABORTED) return throwAbort()
        if (value instanceof Error) return Promise.reject(value)
        return value
      }, 'result.control').extend(withAsyncData({ initState: 0 }))
      const snapshot = (target: typeof operation) => ({
        data: target.data(),
        error: target.error(),
        pending: target.pending(),
        ready: target.ready(),
      })
      const failure = new Error('failed')
      for (const value of [7, failure, ABORTED, 9] as const) {
        const actual = operation(value)
        const native = control(value)
        expect(snapshot(operation)).toEqual(snapshot(control))
        expect(operation.pending()).toBe(1)
        expect(operation.ready()).toBe(false)
        const [actualResult, nativeResult] = await wrap(
          Promise.all([
            actual.then(
              (value) => value,
              (reason) => reason,
            ),
            native.then(
              (value) => value,
              (reason) => reason,
            ),
          ]),
        )
        if (value === ABORTED) {
          expect(isAbort(actualResult)).toBe(true)
          expect(isAbort(nativeResult)).toBe(true)
          expect(operation.data()).toBe(7)
        } else {
          expect(actualResult).toBe(value)
          expect(nativeResult).toBe(value)
        }
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
      const result = await wrap(operation().catch((reason) => reason))
      expect(observed).toBeInstanceOf(AbortSignal)
      expect(isAbort(result)).toBe(true)
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
      const pending = operation().catch((reason) => reason)
      operation.abort()
      finish(7)
      const result = await wrap(pending)
      expect(signal?.aborted).toBe(true)
      expect(isAbort(result)).toBe(true)
      expect(operation.data()).toBe(0)
      expect(operation.error()).toBeUndefined()
      expect(operation.pending()).toBe(0)
    }),
  )
})
