import type {
  Aborted,
  BlitStage,
  PoseRef,
  StageEvent,
  StagePlayOptions,
  StagePlayReport,
  View,
} from '@paper-crumple/core'

/** What a knob value may be (spec §4.3, §6.2): flat primitives, nothing structured. */
export type KnobValue = string | number | boolean

export type SceneStatus = 'building' | 'ready' | 'failed'

export interface SceneOptions {
  /**
   * `onError` is handed DOWN so the consumer can spread it into `paperStage`'s own `onError`.
   * `StageOptions.onError` is wired before the surface exists, and the consumer writes the
   * `paperStage(...)` call, so it is the only reach the binding has into the pre-mount window.
   * A consumer who drops the parameter loses that window and nothing else.
   */
  create: (
    signal: AbortSignal,
    onError: (e: StageEvent<'error'>) => void,
  ) => Promise<BlitStage | Error | Aborted>
  /**
   * A rebuild is decided by `deps` and by nothing else. Structural comparison of the options bag
   * was rejected: `sheet` and `motion` are objects returned by factory calls, so a consumer who
   * forgets a `useMemo` would recreate the WebGL2 context on every render.
   */
  deps: readonly unknown[]
  knobs?: Readonly<Record<string, KnobValue>>
  onError?: (e: StageEvent<'error'>) => void
  /**
   * A declarative knob write the stage refused. `onError` also receives it (§0.3), but a
   * `StageEvent` has nowhere to put the key, and the key is the only thing that tells a consumer
   * which control to roll back. A carry-forward onto a replacement stage stays silent here for
   * exactly the reason it stays silent on `onError` (§4.1): the consumer did not write it.
   */
  onKnobRefused?: (key: string, value: KnobValue, error: Error) => void
}

/** The reactive half of a `Scene`, rebuilt as one cached object per store bump (§5.5). */
export interface SceneSnapshot {
  readonly status: SceneStatus
  /** Non-null exactly when `status === 'ready'`. */
  readonly stage: BlitStage | null
  /** Non-null exactly when `status === 'failed'`. */
  readonly error: Error | null
  /** `stage.warnings`, re-read on every bump — the array grows at runtime. */
  readonly warnings: readonly Error[]
  /** `stage.lost`. A lost context also moves `status` to `'failed'`. */
  readonly lost: boolean
  /** Bumped on every landed build. A knob write is not a build and must not appear here. */
  readonly generation: number
  /** Bumped after every knob batch is written (§4.3). */
  readonly knobEpoch: number
}

/**
 * Memoised, and changes identity only when one of its fields does (§2.1): it is the value of
 * `<PaperScene value={scene}>`, so a fresh identity per render would re-render the whole subtree
 * and re-run every crumple effect that depends on it.
 */
export interface Scene extends SceneSnapshot {
  /**
   * On a scene that is not `ready` this is not an error and does not queue: it resolves to an
   * empty report with `completed: false`, which is what a broadcast over zero eligible views
   * reports. It never returns an Error and never rejects.
   */
  play(from: PoseRef, to: PoseRef, o?: StagePlayOptions): Promise<StagePlayReport<View>>
  /** A no-op on a scene that is not `ready`. */
  stop(o?: { all?: boolean }): void
}
