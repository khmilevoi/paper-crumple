import { describe, expectTypeOf, it } from 'vitest'
import type { Aborted } from './abort.js'
import type { GlError, ViewError } from './errors.js'
import type { ReadyError } from './results.js'
import {
  paperStage,
  type BlitStage,
  type DirectStage,
  type Fit,
  type HostedStage,
} from './stage.js'
import type { StageOptions } from './stage-types.js'
import { fakeMotion, fakeSheet } from './testing/fake-slots.js'

const base = { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384 }

describe('the three overloads (amendment 8)', () => {
  it('picks the stage type from `present`', async () => {
    expectTypeOf(await paperStage({ ...base, present: 'blit' })).toEqualTypeOf<
      BlitStage | ReadyError | Aborted
    >()
    expectTypeOf(await paperStage({ ...base, present: 'direct' })).toEqualTypeOf<
      DirectStage | ReadyError | Aborted
    >()
    expectTypeOf(await paperStage({ ...base, gl: {} as WebGL2RenderingContext })).toEqualTypeOf<
      HostedStage | ReadyError | Aborted
    >()
  })

  it('refuses an options bag with neither `present` nor `gl`, because there is no default', () => {
    // @ts-expect-error `present` loses its default and must be written (amendment 8): an overload
    // set cannot pick a return type from an absent property.
    paperStage(base)
  })

  it('refuses maxSize and cssPx together, and refuses neither', () => {
    // @ts-expect-error exactly one of maxSize / cssPx is required (amendment 12)
    paperStage({ sheet: fakeSheet(), motion: fakeMotion(), maxSize: 1, cssPx: 1, present: 'blit' })
    // @ts-expect-error and one of them must be present
    paperStage({ sheet: fakeSheet(), motion: fakeMotion(), present: 'blit' })
  })

  it('accepts cssPx as the other half of that union', async () => {
    expectTypeOf(
      await paperStage({ sheet: fakeSheet(), motion: fakeMotion(), cssPx: 192, present: 'blit' }),
    ).toEqualTypeOf<BlitStage | ReadyError | Aborted>()
  })

  it('accepts artworkCssPx as the third member of that union', async () => {
    expectTypeOf(
      await paperStage({
        sheet: fakeSheet(),
        motion: fakeMotion(),
        artworkCssPx: 360,
        present: 'blit',
      }),
    ).toEqualTypeOf<BlitStage | ReadyError | Aborted>()
  })

  it('still infers when the options are built in a variable', async () => {
    // The `Stage<P>` shape this replaces collapsed to `Stage<Present>` here (D1). An overload set
    // resolves on the argument type, so a variable is as good as a literal.
    const o: StageOptions & { present: 'direct' } = { ...base, present: 'direct' }
    expectTypeOf(await paperStage(o)).toEqualTypeOf<DirectStage | ReadyError | Aborted>()
  })
})

declare const blit: BlitStage
declare const direct: DirectStage
declare const hosted: HostedStage

describe('view() narrows to its own target type', () => {
  it('accepts the right target on each stage', () => {
    expectTypeOf(blit.view({ canvas: {} as HTMLCanvasElement })).toEqualTypeOf<
      View | InstanceType<typeof ViewError>
    >()
    direct.view({ rect: { x: 0, y: 0, w: 1, h: 1 } })
    hosted.view({
      framebuffer: {} as WebGLFramebuffer,
      viewport: { x: 0, y: 0, w: 1, h: 1 },
    })
  })

  it('refuses the wrong one', () => {
    // @ts-expect-error a rect target needs `present: 'direct'`
    blit.view({ rect: { x: 0, y: 0, w: 1, h: 1 } })
    // @ts-expect-error a blit target needs `present: 'blit'`
    direct.view({ canvas: {} as HTMLCanvasElement })
    // @ts-expect-error D2: the *static* refusal; the runtime one is `surface.presentable`
    hosted.view({ rect: { x: 0, y: 0, w: 1, h: 1 } })
  })
})

describe('resize and surface (amendment 8)', () => {
  it('is present on the two owned modes and returns a GlError or undefined', () => {
    expectTypeOf(blit.resize).toEqualTypeOf<
      (w: number, h: number) => InstanceType<typeof GlError> | undefined
    >()
    expectTypeOf(direct.resize).toBeCallableWith(1, 1)
  })

  it('is absent from HostedStage, so reaching it is a compile error and not a runtime one', () => {
    // @ts-expect-error the stage owns nothing about an injected context, its canvas's size included
    hosted.resize(1, 1)
  })

  it('types DirectStage.surface.canvas as HTMLCanvasElement, so the cast disappears', () => {
    expectTypeOf(direct.surface.canvas).toEqualTypeOf<HTMLCanvasElement>()
    expectTypeOf(blit.surface.canvas).toEqualTypeOf<HTMLCanvasElement | OffscreenCanvas>()
  })
})

describe('Fit (D7)', () => {
  it("is BlitTarget's own fit and cannot drift from it", () => {
    expectTypeOf<Fit>().toEqualTypeOf<'stretch' | 'contain'>()
  })
})

// `View` is declared by Task 12; this file compiles against the name from the same barrel a
// consumer would use.
import type { View } from './view.js'
