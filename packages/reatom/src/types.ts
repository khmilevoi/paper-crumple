import type {
  BindingStage,
  SceneFactory,
  TargetFor,
  ViewInputs,
} from '@paper-crumple/core/bindings'
import type { AsyncDataExt } from '@reatom/core'
import type { BlitStage, PinFor, Sprite, SpriteSource, View } from '@paper-crumple/core'

export type ViewSettings = Omit<ViewInputs, 'source' | 'key'> & { key?: string }
export type ViewOptions<S extends BindingStage, Source extends SpriteSource = SpriteSource> = {
  name: string
  source: Source
} & Omit<ViewSettings, 'pin'> &
  PinFor<Source> &
  (S extends BlitStage
    ? { createView?: never }
    : { createView: (stage: S, target: TargetFor<S>) => View | Error })

export interface SceneOptions<S extends BindingStage> {
  name: string
  create: SceneFactory<S>
}

export type Ready<T> = (() => Promise<T>) &
  Pick<
    AsyncDataExt<[], T, T | null, T | null, Error | undefined>,
    'data' | 'error' | 'pending' | 'ready'
  >

export type SurfaceSize = Readonly<{ width: number; height: number }>

export type ResourceOptions<Source extends SpriteSource> = {
  name: string
  key: string
  source: Source
} & PinFor<Source>

export type ResourceReplace = (<Source extends SpriteSource>(
  source: Source,
  ...options: PinFor<Source> extends { pin: true }
    ? [options: PinFor<Source>]
    : [options?: PinFor<Source>]
) => Promise<Sprite>) &
  AsyncDataExt<
    [SpriteSource, { pin?: true }?],
    Sprite,
    Sprite | null,
    Sprite | null,
    Error | undefined
  >
