import type { Aborted } from './abort.js'
import type { StagePlayReport } from './collisions.js'
import { GlError, type SheetError, type ViewError } from './errors.js'
import type { KnobDescriptor } from './forward.js'
import type { FrontLruUsage } from './front-lru.js'
import type { GlCaps } from './gl.js'
import type { EventName, StageEvent } from './events.js'
import type { KnobPatch, KnobSetter } from './knob-patch.js'
import type { PoseRef } from './pose.js'
import type { AddError, ReadyError } from './results.js'
import type { StagePlayOptions } from './runner.js'
import type { PinFor, SpriteSource } from './source.js'
import type { Sprite } from './sprite.js'
import type {
  BlitTarget,
  DirectTarget,
  HostedTarget,
  StageOptions,
  Surface,
} from './stage-types.js'
import type { View } from './view.js'

/**
 * D4 — the widest slot type. `KnobPatch`, `ViewKnobPatch` and `SpriteKnobPatch` are parameterised
 * on the two slots' **descriptor tuples**, and nothing in the surface P2 shipped carries one, so
 * they are instantiated here at `readonly KnobDescriptor[]`. At that instantiation the patch
 * degrades to an index-signature bag and **P3's runtime registry is the enforcement**:
 * `registry.normalise()` returns a `KnobError` for an unknown, ambiguous or out-of-range key.
 * A later widening re-instantiates these three names and rewrites nothing.
 */
type AnySlot = readonly KnobDescriptor[]

/** D7 — §4.2's `mount` writes `fit?: Fit` and no section declares it. Derived, never restated. */
export type Fit = NonNullable<BlitTarget['fit']>

/** `stage.add`'s options bag. `PinFor<S>` is what makes `pin: true` required for a bare bitmap. */
export type AddOptions<S extends SpriteSource> = {
  key: string
  signal?: AbortSignal
  exact?: boolean
} & PinFor<S>

/** Everything not specific to a surface mode (amendment 8). */
export interface StageCommon {
  // --- degradation, capabilities and the two channels (§4.0, §4.6, amendment 14, amendment 16) ---
  /** Degradation is a value, not a rejection: a paper tile that failed to fetch leaves a usable
   *  stage that renders without grain. */
  readonly warnings: readonly Error[]
  /** Re-exported from `GlContext.caps`: a consumer choosing `maxSize` or `exact: true` needs
   *  `maxTextureSize` **before** the `add()` that would fail on it. */
  readonly caps: GlCaps
  /** `readonly KnobDescriptor[]` at runtime, so a JS consumer gets ranges, kinds and labels from
   *  the same descriptors that generate the types (§10.6). */
  readonly knobs: readonly KnobDescriptor[]
  /** The synchronous form of the `lost` event: a `useEffect` that runs after the event has
   *  already fired has no other way to ask (amendment 16). */
  readonly lost: boolean
  /** §4.5's list, in registration order — the same one `stage.play()` already snapshots. */
  readonly views: readonly View[]

  on<E extends EventName>(event: E, fn: (e: StageEvent<E>) => void): () => void
  once<E extends EventName>(event: E, fn: (e: StageEvent<E>) => void): () => void

  // --- sprites (§4.1, amendments 9, 10, 17) ---
  add<S extends SpriteSource>(src: S, o: AddOptions<S>): Promise<Sprite | AddError | Aborted>
  addAll<S extends SpriteSource>(
    entries: ReadonlyArray<{ src: S } & AddOptions<S>>,
    o?: { signal?: AbortSignal },
  ): Promise<Array<Sprite | AddError> | Aborted>
  /** A missing key is not a failure, so this is not an `Error` union under any reading and
   *  nothing about it should be narrowed (amendment 17). */
  get(key: string): Sprite | undefined
  replace<S extends SpriteSource>(
    key: string,
    src: S,
    o?: { signal?: AbortSignal; exact?: boolean },
  ): Promise<Sprite | AddError | Aborted>
  prepare(key: string, o?: { signal?: AbortSignal }): Promise<Sprite | AddError | Aborted>
  /** `detach: true` disposes the views the stage now knows about through `mount`; without it the
   *  behaviour, `SheetError` while attached included, is unchanged (amendment 17). */
  remove(key: string, o?: { detach?: true }): InstanceType<typeof SheetError> | undefined

  // --- composition (§4.2, amendment 11) ---
  mount(
    item: {
      key: string
      src: SpriteSource
      canvas: HTMLCanvasElement
      fit?: Fit
      tag?: string
      pin?: true
    },
    o?: { signal?: AbortSignal },
  ): Promise<View | AddError | InstanceType<typeof ViewError> | Aborted>

  // --- broadcast playback (§4.4) ---
  play(from: PoseRef, to: PoseRef, o?: StagePlayOptions): Promise<StagePlayReport<View>>
  /** Stops only stage-owned runs; `{ all: true }` stops everything, so a broadcast stop cannot
   *  silently kill a user-initiated garment swap. */
  stop(o?: { all?: boolean }): void

  // --- GL discipline, budget and knobs (§7.3, §8.8, §6.8) ---
  /** One save/restore around a batch of draws. Passes `fn`'s return value through; a nested
   *  `batch` is a no-op rather than a double save; **optional** — a bare `show()` outside a batch
   *  still saves and restores. Renamed from `stage.frame` because `frame` means a stored geometry
   *  frame everywhere else in the design (§7.3). */
  batch<T>(fn: () => T): T
  budget(o: { bytes?: number; artworkSlots?: number }): void
  usage(): FrontLruUsage & { readonly handles: number; readonly attached: number }
  pin(key: string): void
  unpin(key: string): void
  set: KnobSetter<KnobPatch<AnySlot, AnySlot>>

  /** Idempotent (§4.6). After it, every method returns a `GlError`; `show(null)` and `remove()`
   *  are no-ops, because React runs cleanups child-first. */
  dispose(): void
}

export interface BlitStage extends StageCommon {
  view(t: BlitTarget): View | InstanceType<typeof ViewError>
  resize(w: number, h: number): InstanceType<typeof GlError> | undefined
  readonly surface: Surface
}

export interface DirectStage extends StageCommon {
  view(t: DirectTarget): View | InstanceType<typeof ViewError>
  resize(w: number, h: number): InstanceType<typeof GlError> | undefined
  /** Not `HTMLCanvasElement | OffscreenCanvas`: a `direct` surface is by definition the element
   *  the consumer appends, so the `as HTMLCanvasElement` cast disappears from consumer code. */
  readonly surface: Surface & { canvas: HTMLCanvasElement }
}

export interface HostedStage extends StageCommon {
  /**
   * D2. The static parameter is `HostedTarget` and nothing else. The **runtime** guard on a
   * `{ rect }` target — reachable from JavaScript, from a `ViewTarget`-typed variable and from a
   * cast — returns a `ViewError` naming `surface.presentable`, which is the result of grading the
   * *granted* attributes (§4.0.2) and is not statically knowable. `resize` is absent by design.
   */
  view(t: HostedTarget): View | InstanceType<typeof ViewError>
  readonly surface: Surface
}

export function paperStage(
  o: StageOptions & { present: 'blit' },
): Promise<BlitStage | ReadyError | Aborted>
export function paperStage(
  o: StageOptions & { present: 'direct' },
): Promise<DirectStage | ReadyError | Aborted>
export function paperStage(
  o: StageOptions & { gl: WebGL2RenderingContext },
): Promise<HostedStage | ReadyError | Aborted>
export function paperStage(
  _o: StageOptions & { present?: 'blit' | 'direct'; gl?: WebGL2RenderingContext },
): Promise<BlitStage | DirectStage | HostedStage | ReadyError | Aborted> {
  void _o
  return Promise.resolve(new GlError('paperStage() is not implemented yet'))
}
