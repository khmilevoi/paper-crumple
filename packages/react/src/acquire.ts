import { createAcquisitions } from '@paper-crumple/core/bindings'
import type { Aborted, AddError, BlitStage, Sprite, SpriteSource } from '@paper-crumple/core'

/** Thin React compatibility wrappers over the stage-owned shared registry. */
export function stageSignal(stage: BlitStage): AbortSignal {
  return createAcquisitions(stage).signal
}

export function pendingAcquisition(stage: BlitStage, key: string) {
  return createAcquisitions(stage).pending(key)
}

export function acquire(
  stage: BlitStage,
  key: string,
  src: SpriteSource,
  pin: true | undefined,
  mySignal: AbortSignal,
): Promise<Sprite | AddError | Aborted> {
  return createAcquisitions(stage).acquire(key, src, pin, mySignal)
}
