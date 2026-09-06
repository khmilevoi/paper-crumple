/**
 * # `SwapToOptions` (spec §5.3)
 *
 * `swapTo`'s options ALONE. The pin that matters most here is the negative one: `SwapOptions` is
 * shared with `crumpleTo`, which takes a `Sprite` and for which a key is meaningless, so widening
 * the shared type would have added a member one of its two users silently ignores.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { SwapResult } from './results.js'
import type { Run } from './run.js'
import type { SwapOptions, SwapToOptions, View } from './view.js'

declare const view: View
declare const shared: SwapOptions
// Module scope, not inside an `it`: a `declare` modifier is illegal in a function body.
declare const sprite: Parameters<View['crumpleTo']>[0]

describe('SwapToOptions', () => {
  it('is SwapOptions plus one optional string key', () => {
    expectTypeOf<SwapToOptions>().toExtend<SwapOptions>()
    expectTypeOf<SwapToOptions['key']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<SwapToOptions['duration']>().toEqualTypeOf<number | undefined>()
  })

  it('leaves SwapOptions itself alone — crumpleTo`s half gains no member', () => {
    expectTypeOf<'key' extends keyof SwapOptions ? true : false>().toEqualTypeOf<false>()
  })
})

describe('view.swapTo', () => {
  it('still accepts what an existing SwapOptions call site already passes', () => {
    expectTypeOf(view.swapTo('/b.png')).toEqualTypeOf<Run<SwapResult>>()
    expectTypeOf(view.swapTo('/b.png', shared)).toEqualTypeOf<Run<SwapResult>>()
    expectTypeOf(view.swapTo('/b.png', { duration: 400 })).toEqualTypeOf<Run<SwapResult>>()
  })

  it('accepts a key, and refuses one that is not a string', () => {
    expectTypeOf(view.swapTo('/b.png', { key: 'b' })).toEqualTypeOf<Run<SwapResult>>()
    // @ts-expect-error `key` is a string.
    view.swapTo('/b.png', { key: 42 })
  })

  it('does not let a key through crumpleTo', () => {
    // @ts-expect-error `key` is `swapTo`'s alone (§5.3) — `crumpleTo` takes a resolved target.
    view.crumpleTo(sprite, { key: 'b' })
  })
})
