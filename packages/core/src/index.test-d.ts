import { expectTypeOf, test } from 'vitest'
import type * as root from './index.js'
import type * as unstable from './unstable.js'

/**
 * Every type name `@paper-crumple/core` owes its consumers, referenced once. A dropped or
 * misspelled `export type` in `index.ts` is a compile error here and nowhere else:
 * `barrel.test.ts` is a runtime check and can only see the exported values.
 */
export type RootTypeSurface = [
  root.Aborted,
  root.ErrorGuard<Error>,
  root.SourceError,
  root.BuildError,
  root.LoadError,
  root.AddError,
  root.ReadyError,
  root.PlayResult,
  root.SwapResult,
  root.MountResult,
  root.SetResult,
  root.MatchHandlers<void>,
  root.NoAbortedElement<number>,
  root.Rect,
  root.Size,
  root.PoseRef,
  root.GlCaps,
  root.DrawTarget,
  root.SheetFront,
  root.SheetRenderer,
  root.SourceOptions,
  root.MotionSource,
  root.DrawArgs<unstable.MotionFit, unstable.MotionClip, root.Knobs>,
  root.DrawResult,
  root.ViewTarget,
  root.BlitTarget,
  root.DirectTarget,
  root.HostedTarget,
  root.Surface,
  root.StageOptions,
  root.StageOptionsBase,
  root.Events,
  root.EventName,
  root.StageEvent<'error'>,
  root.NoPayload,
  root.View,
  root.Knobs,
  root.KnobDescriptor,
  root.SheetKnobs<root.Knobs>,
  root.MotionKnobs<root.Knobs>,
]

/** The slot-authoring surface of `@paper-crumple/core/unstable` (§14). */
export type UnstableTypeSurface = [
  unstable.GlContext,
  unstable.DrawScope,
  unstable.Program,
  unstable.Texture,
  unstable.Target,
  unstable.TextureDesc,
  unstable.SheetHandle,
  unstable.MotionFit,
  unstable.MotionClip,
  unstable.TaggedError<'X', Record<never, never>>,
  unstable.TaggedErrorConstructor<'X', Record<never, never>>,
  unstable.CrumpleErrorInit,
  unstable.ErrorProps,
  unstable.NoProps,
]

test('both barrels export every type name they owe', () => {
  expectTypeOf<RootTypeSurface['length']>().toEqualTypeOf<40>()
  expectTypeOf<UnstableTypeSurface['length']>().toEqualTypeOf<14>()
})
