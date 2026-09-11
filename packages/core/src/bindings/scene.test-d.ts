import { expectTypeOf, it } from 'vitest'
import { createSceneController } from '../bindings.js'
import type { BindingStage, SceneController, SceneFactory } from '../bindings.js'
import type {
  BlitStage,
  BlitTarget,
  DirectStage,
  DirectTarget,
  HostedStage,
  HostedTarget,
  Surface,
  Aborted,
} from '../index.js'

declare const blit: BlitStage
declare const direct: DirectStage
declare const hosted: HostedStage

type Target<S extends BindingStage> = Parameters<S['view']>[0]
type SceneSurface<S extends BindingStage> = S['surface']

it('BindingStage preserves the raw stage union and downstream surface and target types', () => {
  expectTypeOf<BindingStage>().toEqualTypeOf<BlitStage | DirectStage | HostedStage>()
  expectTypeOf<SceneSurface<BlitStage>>().toEqualTypeOf<Surface>()
  expectTypeOf<SceneSurface<DirectStage>['canvas']>().toEqualTypeOf<HTMLCanvasElement>()
  expectTypeOf<Target<BlitStage>>().toEqualTypeOf<BlitTarget>()
  expectTypeOf<Target<DirectStage>>().toEqualTypeOf<DirectTarget>()
  expectTypeOf<Target<HostedStage>>().toEqualTypeOf<HostedTarget>()
})

it('factory inference keeps each stage mode and its target restrictions', () => {
  const blitScene = createSceneController(async () => blit)
  const directScene = createSceneController(async () => direct)
  const hostedScene = createSceneController(async () => hosted)
  expectTypeOf(blitScene.stage).toEqualTypeOf<BlitStage | null>()
  expectTypeOf(directScene.stage).toEqualTypeOf<DirectStage | null>()
  expectTypeOf(hostedScene.stage).toEqualTypeOf<HostedStage | null>()
  blitScene.stage?.view({ canvas: {} as HTMLCanvasElement })
  directScene.stage?.view({ rect: { x: 0, y: 0, w: 10, h: 10 } })
  hostedScene.stage?.view({
    framebuffer: {} as WebGLFramebuffer,
    viewport: { x: 0, y: 0, w: 10, h: 10 },
  })
  // @ts-expect-error A direct stage cannot accept a blit target.
  directScene.stage?.view({ canvas: {} as HTMLCanvasElement })
  // @ts-expect-error A hosted stage has no owned-surface resize command.
  hostedScene.stage?.resize(10, 10)
})

it('SceneController and SceneFactory default to BlitStage and expose disposed', () => {
  expectTypeOf<SceneController>().toEqualTypeOf<SceneController<BlitStage>>()
  expectTypeOf<SceneFactory>().toEqualTypeOf<SceneFactory<BlitStage>>()
  expectTypeOf<SceneController['stage']>().toEqualTypeOf<BlitStage | null>()
  expectTypeOf<SceneController['disposed']>().toEqualTypeOf<boolean>()
  expectTypeOf<ReturnType<SceneFactory>>().toEqualTypeOf<Promise<BlitStage | Error | Aborted>>()
})
