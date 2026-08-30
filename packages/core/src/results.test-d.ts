import { expectTypeOf, test } from 'vitest'
import { type Aborted } from './abort.js'
import {
  AbortedError,
  AssetError,
  GlError,
  KnobError,
  MotionError,
  PackError,
  PoseError,
  SheetError,
  SourceExpiredError,
  ViewError,
} from './errors.js'
import type { View } from './forward.js'
import type {
  AddError,
  BuildError,
  LoadError,
  MountResult,
  PlayResult,
  ReadyError,
  SetResult,
  SourceError,
  SwapResult,
} from './results.js'

type Gl = InstanceType<typeof GlError>
type Sheet = InstanceType<typeof SheetError>
type Pack = InstanceType<typeof PackError>
type Asset = InstanceType<typeof AssetError>
type Motion = InstanceType<typeof MotionError>
type Pose = InstanceType<typeof PoseError>
type Knob = InstanceType<typeof KnobError>
type Expired = InstanceType<typeof SourceExpiredError>
type ViewErr = InstanceType<typeof ViewError>

test('the five aliases of §10.2, with amendment 1 applied', () => {
  expectTypeOf<SourceError>().toEqualTypeOf<Sheet | Gl>()
  expectTypeOf<BuildError>().toEqualTypeOf<Sheet | Gl | Expired>()
  expectTypeOf<LoadError>().toEqualTypeOf<Pack | Asset>()
  expectTypeOf<AddError>().toEqualTypeOf<Sheet | Gl | Motion | Pack | Asset>()
  expectTypeOf<ReadyError>().toEqualTypeOf<Gl | Knob>()
})

test('AbortedError left SourceError, LoadError and AddError (amendment 1)', () => {
  const aborted = new AbortedError('cancelled')
  // @ts-expect-error - abort is a sentinel, never a member of an error union
  const a: SourceError = aborted
  // @ts-expect-error - abort is a sentinel, never a member of an error union
  const b: LoadError = aborted
  // @ts-expect-error - abort is a sentinel, never a member of an error union
  const c: AddError = aborted
  void a
  void b
  void c
})

test('the four aliases named at birth (amendment 6)', () => {
  expectTypeOf<PlayResult>().toEqualTypeOf<undefined | Pose | Aborted>()
  expectTypeOf<SwapResult>().toEqualTypeOf<undefined | Pose | AddError | Aborted>()
  expectTypeOf<MountResult>().toEqualTypeOf<View | AddError | ViewErr | Aborted>()
  expectTypeOf<SetResult>().toEqualTypeOf<Knob | undefined>()
})

test('SwapResult carries AddError and PlayResult does not', () => {
  expectTypeOf<Sheet>().toExtend<SwapResult>()
  expectTypeOf<Sheet>().not.toExtend<PlayResult>()
})
