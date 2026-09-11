import type { BlitStage, DirectStage, HostedStage, Sprite, SpriteSource } from '@paper-crumple/core'
import type { Atom } from '@reatom/core'
import { expectTypeOf, test } from 'vitest'
import { reatomScene, type ResourceModel } from './index.js'

declare const bitmap: ImageBitmap
declare const canvas: HTMLCanvasElement
declare const image: HTMLImageElement
declare const blit: BlitStage
declare const direct: DirectStage
declare const hosted: HostedStage

test('resource commands preserve native payloads and core PinFor requirements', () => {
  const scene = reatomScene({ name: 'types', create: async () => blit })
  const resource = scene.resource({ name: 'a', key: 'a', source: '/a.png' })
  expectTypeOf(resource).toEqualTypeOf<ResourceModel>()
  expectTypeOf(resource.raw).toExtend<Atom<Sprite | null>>()
  expectTypeOf(resource.source()).toEqualTypeOf<SpriteSource>()
  expectTypeOf(resource.prepare()).toEqualTypeOf<Promise<Sprite>>()
  expectTypeOf(resource.prepare.data()).toEqualTypeOf<Sprite | null>()
  expectTypeOf(resource.prepare.error()).toEqualTypeOf<Error | undefined>()
  expectTypeOf(resource.remove()).toEqualTypeOf<void>()
  expectTypeOf(resource.replace('/b.png')).toEqualTypeOf<Promise<Sprite>>()
  expectTypeOf(resource.replace.data()).toEqualTypeOf<Sprite | null>()
  scene.resource({ name: 'bitmap', key: 'bitmap', source: bitmap, pin: true })
  scene.resource({ name: 'canvas', key: 'canvas', source: canvas, pin: true })
  scene.resource({ name: 'image', key: 'image', source: image, pin: true })
  resource.replace(bitmap, { pin: true })
  resource.replace(canvas, { pin: true })
  resource.replace(image, { pin: true })
  // @ts-expect-error borrowed bitmap creation requires pin.
  scene.resource({ name: 'bad', key: 'bad', source: bitmap })
  // @ts-expect-error borrowed canvas creation requires pin.
  scene.resource({ name: 'bad', key: 'bad', source: canvas })
  // @ts-expect-error borrowed image creation requires pin.
  scene.resource({ name: 'bad', key: 'bad', source: image })
  // @ts-expect-error borrowed bitmap replacement requires pin.
  resource.replace(bitmap)
  // @ts-expect-error borrowed canvas replacement requires pin.
  resource.replace(canvas)
  // @ts-expect-error borrowed image replacement requires pin.
  resource.replace(image, {})
})

test('resources remain stage-common in every surface mode', () => {
  const directScene = reatomScene({ name: 'direct', create: async () => direct })
  const hostedScene = reatomScene({ name: 'hosted', create: async () => hosted })
  expectTypeOf(
    directScene.resource({ name: 'a', key: 'a', source: '/a.png' }),
  ).toEqualTypeOf<ResourceModel>()
  expectTypeOf(
    hostedScene.resource({ name: 'a', key: 'a', source: '/a.png' }),
  ).toEqualTypeOf<ResourceModel>()
})
