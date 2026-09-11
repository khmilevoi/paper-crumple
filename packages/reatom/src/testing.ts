import type { Run } from '@paper-crumple/core'

interface RunHandle<R> {
  readonly run: Run<R>
  readonly settled: boolean
  settle(value: R): void
}

export function createRun<R>(stop: () => void): RunHandle<R> {
  let settled = false
  let resolve: (value: R) => void = () => {}
  const done = new Promise<R>((r) => {
    resolve = r
  })
  const run: Run<R> = {
    done,
    stop,
    then<T1 = R, T2 = never>(
      onfulfilled?: ((value: R) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ): PromiseLike<T1 | T2> {
      return done.then(onfulfilled, onrejected)
    },
  }
  return {
    run,
    get settled() {
      return settled
    },
    settle(value) {
      if (settled) return
      settled = true
      resolve(value)
    },
  }
}
