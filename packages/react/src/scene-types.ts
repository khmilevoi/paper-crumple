import type {
  Aborted,
  BlitStage,
  Knobs,
  PoseRef,
  StageEvent,
  StagePlayOptions,
  StagePlayReport,
  View,
} from '@paper-crumple/core'

export type SceneStatus = 'building' | 'ready' | 'failed'

/**
 * What `create` resolves to when the consumer has build metadata to carry (§3.2). Returning a
 * bare `BlitStage` is still legal and means `meta` is `undefined` — which is exactly what the
 * `M = undefined` default type parameter describes.
 */
export interface SceneBuild<M> {
  readonly stage: BlitStage
  readonly meta: M
}

export interface SceneOptions<M = undefined> {
  /**
   * `onError` is handed DOWN so the consumer can spread it into `paperStage`'s own `onError`.
   * `StageOptions.onError` is wired before the surface exists, and the consumer writes the
   * `paperStage(...)` call, so it is the only reach the binding has into the pre-mount window.
   * A consumer who drops the parameter loses that window and nothing else.
   */
  create: (
    signal: AbortSignal,
    onError: (e: StageEvent<'error'>) => void,
  ) => Promise<SceneBuild<M> | BlitStage | Error | Aborted>
  /**
   * A rebuild is decided by `deps` and by nothing else. Structural comparison of the options bag
   * was rejected: `sheet` and `motion` are objects returned by factory calls, so a consumer who
   * forgets a `useMemo` would recreate the WebGL2 context on every render.
   */
  deps: readonly unknown[]
  /**
   * Core's own `Knobs` (§4.2). The binding used to declare a `KnobValue` of its own, which
   * collided by name with core's *generic* `KnobValue<D>` and gave one type three spellings.
   * `Record<string, …>` is the honest type: the binding cannot name the slots by design.
   */
  knobs?: Knobs
  onError?: (e: StageEvent<'error'>) => void
  /**
   * A declarative knob write the stage refused. `onError` also receives it (§0.3), but a
   * `StageEvent` has nowhere to put the key, and the key is the only thing that tells a consumer
   * which control to roll back. A carry-forward onto a replacement stage stays silent here for
   * exactly the reason it stays silent on `onError` (§4.1): the consumer did not write it.
   */
  onKnobRefused?: (key: string, value: Knobs[string], error: Error) => void
}

/** The reactive half of a `Scene`, rebuilt as one cached object per store bump (§5.5). */
export interface SceneSnapshot<M = undefined> {
  readonly status: SceneStatus
  /** Non-null exactly when `status === 'ready'`. */
  readonly stage: BlitStage | null
  /**
   * The landed build's metadata (§3.2). It lives beside `stage` and is cleared with it on
   * rebuild, failure and loss — non-null exactly when `status === 'ready'`, and `undefined`
   * rather than `null` when `create` returned a bare stage.
   */
  readonly meta: M | null
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
export interface Scene<M = undefined> extends SceneSnapshot<M> {
  /**
   * On a scene that is not `ready` this is not an error and does not queue: it resolves to an
   * empty report with `completed: false`, which is what a broadcast over zero eligible views
   * reports. It never returns an Error and never rejects.
   */
  play(from: PoseRef, to: PoseRef, o?: StagePlayOptions): Promise<StagePlayReport<View>>
  /** A no-op on a scene that is not `ready`. */
  stop(o?: { all?: boolean }): void
}
