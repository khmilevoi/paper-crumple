import type { BlitStage, DirectStage, HostedStage, Sprite, View } from '@paper-crumple/core'
import type { RenderValue } from '@paper-crumple/core/bindings'
import type { Atom } from '@reatom/core'
import { expectTypeOf, test } from 'vitest'
import { reatomScene, type RunModel } from './index.js'

declare const blitFactory: () => Promise<BlitStage>
declare const directFactory: () => Promise<DirectStage>
declare const hostedFactory: () => Promise<HostedStage>
declare const canvas: HTMLCanvasElement
declare const framebuffer: WebGLFramebuffer
declare const bitmap: ImageBitmap

test('view targets and canvas rendering are specific to the scene mode', () => {
  const blit = reatomScene({ name: 'blit', create: blitFactory })
  const direct = reatomScene({ name: 'direct', create: directFactory })
  const hosted = reatomScene({ name: 'hosted', create: hostedFactory })
  const picture = blit.view({ name: 'picture', source: '/a.png' })
  expectTypeOf(picture.render).toEqualTypeOf<Atom<RenderValue>>()
  expectTypeOf(picture.ref).toEqualTypeOf<RenderValue['ref']>()
  expectTypeOf(picture.ready()).toEqualTypeOf<Promise<Sprite>>()
  expectTypeOf(picture.ready.data()).toEqualTypeOf<Sprite | null>()
  expectTypeOf(picture.swap('/b.png')).toEqualTypeOf<Promise<Sprite>>()
  expectTypeOf(picture.play('flat', 'ball')).toEqualTypeOf<RunModel<undefined>>()
  expectTypeOf(picture.readPose()).toEqualTypeOf<View['pose'] | null>()
  expectTypeOf(picture.progress()).toEqualTypeOf<{
    pose: number
    frame: number
    ms: number
  } | null>()
  picture.attach({ canvas })
  picture.attach(null)
  // @ts-expect-error Direct targets cannot attach to a Blit model.
  picture.attach({ rect: { x: 0, y: 0, w: 100, h: 100 } })
  const directView = direct.view({
    name: 'direct.picture',
    source: '/a.png',
    createView: (stage, target) => stage.view(target),
  })
  directView.attach({ rect: { x: 0, y: 0, w: 100, h: 100 } })
  // @ts-expect-error Direct models do not carry a canvas render atom.
  directView.render()
  // @ts-expect-error Direct models have no canvas ref.
  directView.ref(canvas)
  // @ts-expect-error Direct targets have no canvas.
  directView.attach({ canvas })
  // @ts-expect-error Noncanvas construction must provide its actual stage.view invocation.
  direct.view({ name: 'invalid', source: '/a.png' })
  const hostedView = hosted.view({
    name: 'hosted.picture',
    source: '/a.png',
    createView: (stage, target) => stage.view(target),
  })
  hostedView.attach({
    framebuffer,
    viewport: { x: 0, y: 0, w: 100, h: 100 },
    rect: { x: 0, y: 0, w: 100, h: 100 },
  })
  // @ts-expect-error Hosted models have no canvas rendering atom.
  hostedView.render()
  // @ts-expect-error Hosted models have no canvas callback ref.
  hostedView.ref(canvas)
  // @ts-expect-error A one-shot bitmap must be pinned.
  blit.view({ name: 'bitmap', source: bitmap })
  blit.view({ name: 'bitmap', source: bitmap, pin: true })
})
