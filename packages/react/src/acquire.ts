import { ABORTED, SheetError } from '@paper-crumple/core'
import type { Aborted, AddError, BlitStage, Sprite, SpriteSource } from '@paper-crumple/core'

type Acquisition = Promise<Sprite | AddError | Aborted>

interface StageAcquisitions {
  /** Keyed by sprite key. `add` refuses a key that is merely *reserved* — in flight and
   *  unfinished — and `reserved` is private to the core, so this map is the only place two
   *  `Crumple`s mounting on one picture in one commit can meet. */
  readonly inFlight: Map<string, Acquisition>
  /**
   * The shared acquisition's own lifetime. Passing the first caller's signal would hand every
   * joiner the first component's lifetime: the first unmounts, the shared promise settles
   * `ABORTED`, and the second `Crumple` stays blank forever. This controller dies with the stage,
   * which is the right lifetime for work several components share.
   */
  readonly controller: AbortController
}

/** Keyed on the stage instance, so the registry lives beside the stage and dies with it. */
const REGISTRY = new WeakMap<BlitStage, StageAcquisitions>()

function acquisitionsFor(stage: BlitStage): StageAcquisitions {
  const found = REGISTRY.get(stage)
  if (found !== undefined) return found
  const made: StageAcquisitions = { inFlight: new Map(), controller: new AbortController() }
  REGISTRY.set(stage, made)
  return made
}

/** The signal every demand this binding makes of a shared sprite runs under. */
export function stageSignal(stage: BlitStage): AbortSignal {
  return acquisitionsFor(stage).controller.signal
}

/**
 * The acquisition already in flight for `key`, if any. The swap consults it: the binding does not
 * call `swapTo` for a key whose acquisition is in flight — `add` would refuse it — it joins the
 * existing one and `crumpleTo`s the result (§5.3).
 */
export function pendingAcquisition(stage: BlitStage, key: string): Acquisition | undefined {
  return acquisitionsFor(stage).inFlight.get(key)
}

/**
 * `add() was called with the live key '…'` — `stage.ts:1798-1806`. The message is the only handle:
 * `reserved` is private, and neither `stage.get` nor `prepare` can see it, so a consumer
 * prefetching through `scene.stage` while a `Crumple` mounts on the same key makes both callers
 * see an absent key and one of them take this refusal for a perfectly correct sequence.
 */
function isLiveKeyRefusal(error: unknown, key: string): boolean {
  return (
    error instanceof SheetError &&
    error.message.startsWith(`add() was called with the live key '${key}'`)
  )
}

/**
 * `prepare() has no sprite under that key; add() it first` — the key is reserved (winner's `add`
 * still in flight) and not yet in `p.sprites`. This is a symptom, not a cause: the true cause is
 * the live-key refusal from `add`. See `stage.ts:1896-1901`.
 */
function isPrepareNoSpriteError(error: unknown, key: string): boolean {
  return (
    error instanceof SheetError &&
    error.message.startsWith(`prepare('${key}') has no sprite under that key`)
  )
}

/**
 * The one shape that turns a (key, source) pair into a sprite. Every place this package needs a
 * sprite goes through it — the first mount (§5.4) and the degraded swap alike (§5.3).
 */
export async function acquire(
  stage: BlitStage,
  key: string,
  src: SpriteSource,
  pin: true | undefined,
  mySignal: AbortSignal,
): Promise<Sprite | AddError | Aborted> {
  const { inFlight, controller } = acquisitionsFor(stage)
  let shared = inFlight.get(key)
  if (shared === undefined) {
    // `prepare`, not the resident sprite: eviction drops a front and leaves the sprite
    // rebuildable, so `stage.get` can hand back a sprite with no front — `show`ing it lifts §6's
    // placeholder over an empty canvas. `prepare` is the one demand that waits for the re-source.
    const started: Acquisition =
      stage.get(key) !== undefined
        ? stage.prepare(key, { signal: controller.signal })
        : stage.add(src, { key, signal: controller.signal, ...(pin && { pin }) })
    inFlight.set(key, started)
    void started.finally(() => {
      if (inFlight.get(key) === started) inFlight.delete(key)
    })
    shared = started
  }

  let got = await shared
  if (isLiveKeyRefusal(got, key)) {
    // Retryable exactly once, and only through `prepare`, which joins the winner of the race
    // instead of failing a correct sequence.
    const prepared = await stage.prepare(key, { signal: controller.signal })
    // If `prepare` itself fails with the "has no sprite" error, it means the key is reserved
    // (the winner's `add` is still in flight), so the original live-key refusal is the true cause.
    // Keep the original error, not the symptom.
    if (!isPrepareNoSpriteError(prepared, key)) {
      got = prepared
    }
  }
  // Each joiner checks its own signal after the await; "React changed its mind" is not a
  // condition a component renders, so the caller turns this into nothing at all.
  if (mySignal.aborted) return ABORTED
  return got
}
