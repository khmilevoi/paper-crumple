import { expectTypeOf, it } from 'vitest'
import type {
  BlitStage,
  BlitTarget,
  DirectStage,
  DirectTarget,
  HostedStage,
  HostedTarget,
} from '../index.js'
import { createSceneController, createTargetViewController } from '../bindings.js'
import type { TargetFor, TargetViewController } from '../bindings.js'

declare const blit: BlitStage
declare const direct: DirectStage
declare const hosted: HostedStage

it('generic targets retain each raw stage mode and callback inference', () => {
  expectTypeOf<TargetFor<BlitStage>>().toEqualTypeOf<BlitTarget>()
  expectTypeOf<TargetFor<DirectStage>>().toEqualTypeOf<DirectTarget>()
  expectTypeOf<TargetFor<HostedStage>>().toEqualTypeOf<HostedTarget>()
  const a = createTargetViewController({
    scene: createSceneController(async () => blit),
    source: '/a.png',
    key: 'a',
    onChange() {},
    createView: (stage, target) => {
      expectTypeOf(target).toEqualTypeOf<BlitTarget>()
      return stage.view(target)
    },
  })
  const b = createTargetViewController({
    scene: createSceneController(async () => direct),
    source: '/a.png',
    key: 'a',
    onChange() {},
    createView: (stage, target) => {
      expectTypeOf(target).toEqualTypeOf<DirectTarget>()
      return stage.view(target)
    },
  })
  const c = createTargetViewController({
    scene: createSceneController(async () => hosted),
    source: '/a.png',
    key: 'a',
    onChange() {},
    createView: (stage, target) => {
      expectTypeOf(target).toEqualTypeOf<HostedTarget>()
      return stage.view(target)
    },
  })
  expectTypeOf(a).toEqualTypeOf<TargetViewController<BlitTarget>>()
  expectTypeOf(b).toEqualTypeOf<TargetViewController<DirectTarget>>()
  expectTypeOf(c).toEqualTypeOf<TargetViewController<HostedTarget>>()
  // @ts-expect-error Direct targets require a rectangle, not a Blit canvas.
  b.attach({ canvas: {} as HTMLCanvasElement })
  // @ts-expect-error Hosted framebuffer targets require a viewport.
  c.attach({ framebuffer: {} as WebGLFramebuffer })
})
