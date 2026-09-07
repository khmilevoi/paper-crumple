import { expectTypeOf, test } from 'vitest'
import type { ScratchPoolsOptions } from './gl-pools.js'
import type { Timers } from './stepper.js'

/** A slot author's clock: the three members `createScratchPools` uses, and nothing else. */
interface Clock {
  now(): number
  setTimeoutFn(fn: () => void, ms: number): unknown
  clearTimeoutFn(handle: unknown): void
}

test("createScratchPools accepts a clock without yield(): the lane's yield is the stage's, not a slot's (§8.10, §14)", () => {
  expectTypeOf<Clock>().toExtend<NonNullable<ScratchPoolsOptions['timers']>>()
  // The full `Timers` still requires `yield`; only the pools' option is narrowed.
  expectTypeOf<Clock>().not.toExtend<Timers>()
  expectTypeOf<Timers>().toExtend<NonNullable<ScratchPoolsOptions['timers']>>()
})
