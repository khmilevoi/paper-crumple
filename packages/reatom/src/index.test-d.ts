import { Crumple, useCrumple, usePaperScene, type CrumpleProps } from '@paper-crumple/react'
import { reatomScene, type RenderValue, type RunModel } from '@paper-crumple/reatom'
import type { BlitStage, DirectStage, HostedStage, Sprite } from '@paper-crumple/core'
import { action, withAsyncData, wrap } from '@reatom/core'
import { reatomComponent } from '@reatom/react'
import { createElement } from 'react'
import { expectTypeOf, test } from 'vitest'

declare const create: (signal: AbortSignal) => Promise<BlitStage>
declare const direct: () => Promise<DirectStage>
declare const hosted: () => Promise<HostedStage>
declare const bitmap: ImageBitmap
declare const canvas: HTMLCanvasElement

test('the approved application compiles entirely through public entries', () => {
  const scene = reatomScene({ name: 'artwork.scene', create })
  const picture = scene.view({ name: 'artwork.picture', source: '/first.webp' })
  const nextArtwork = action(async (source: string) => {
    await wrap(picture.swap(source))
    return source
  }, 'artwork.next').extend(withAsyncData({ initState: null as string | null }))
  const Result = reatomComponent(() => createElement('output', null, nextArtwork.data()))
  const Failure = reatomComponent(() => createElement('output', null, String(nextArtwork.error())))
  const Picture = reatomComponent(() => createElement(Crumple, { value: picture.render() }))
  expectTypeOf(Result).toBeFunction()
  expectTypeOf(Failure).toBeFunction()
  expectTypeOf(Picture).toBeFunction()
  expectTypeOf<CrumpleProps['value']>().toEqualTypeOf<RenderValue>()
  expectTypeOf(useCrumple).toBeFunction()
  expectTypeOf(usePaperScene).toBeFunction()
  expectTypeOf(picture.play('flat', 'ball')).toEqualTypeOf<RunModel<undefined>>()
  expectTypeOf(picture.swap('/second.webp')).toEqualTypeOf<Promise<Sprite>>()
  const minimal: RenderValue = {
    ref: () => {},
    shown: null,
    frameStyle: { width: '0px', height: '0px', left: '0px', top: '0px' },
  }
  createElement(Crumple, { value: minimal })
  // @ts-expect-error Borrowed bitmap requires pin.
  scene.view({ name: 'invalid', source: bitmap })
  scene.view({ name: 'pinned', source: bitmap, pin: true })
  const resource = scene.resource({ name: 'resource', key: 'resource', source: '/first.webp' })
  // @ts-expect-error Replacement borrowed bitmap also requires pin.
  resource.replace(bitmap)
  resource.replace(bitmap, { pin: true })
  const d = reatomScene({ name: 'direct', create: direct }).view({
    name: 'view',
    source: '/a',
    createView: (stage, target) => stage.view(target),
  })
  d.attach({ rect: { x: 0, y: 0, w: 10, h: 10 } })
  // @ts-expect-error Direct target is not a canvas.
  d.attach({ canvas })
  // @ts-expect-error Direct has no canvas renderer.
  d.render()
  const h = reatomScene({ name: 'hosted', create: hosted }).view({
    name: 'view',
    source: '/a',
    createView: (stage, target) => stage.view(target),
  })
  // @ts-expect-error Hosted target requires framebuffer and viewport.
  h.attach({ rect: { x: 0, y: 0, w: 10, h: 10 } })
  // @ts-expect-error Hosted has no canvas ref.
  h.ref(canvas)
})
