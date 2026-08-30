import type { View } from './forward.js'

/**
 * No payload. A mapped type with no keys rather than `{}`, which the lint rule forbids and which
 * — as `Record<string, never>` — would collapse `view` to `never` when intersected with the
 * stage-side handler type.
 */
export type NoPayload = { [K in never]: never }

/**
 * The event map (§7.1).
 *
 * `error` is an object like the other members so the stage can add `view` when re-emitting.
 * `observed: true` means the error is, or will be, a return value someone can narrow;
 * `observed: false` means it is an orphan and this event is its only escape (§10.6, amendment 5).
 * **The field is a contract type here, the emitter is P4, and the policy that decides a given
 * error's value for it is P9.** A returned `ABORTED` is not an error and is never emitted at all.
 *
 * `lost` carries no payload — there is exactly one context, and there is nothing to say about
 * losing it beyond that it happened (§4.6, amendment 16).
 *
 * Every numeric member here is a *resolved* index, never a `PoseRef`: `PoseRef` is an input type
 * only (amendment 21), which is why `via?: number` and the `from` / `to` / `pose` members are
 * unchanged by it.
 */
export type Events = {
  start: { from: number; to: number; duration?: number; via?: number }
  step: { pose: number; frame: number; ms: number }
  end: { from: number; to: number; completed: boolean }
  error: { error: Error; observed: boolean }
  lost: NoPayload
}

/** The names `on` and `once` accept. */
export type EventName = keyof Events

/**
 * The stage-side handler payload, settled here (§7.1, closing USAGE open question 5):
 *
 * ```ts
 * on<E extends EventName>(event: E, fn: (e: StageEvent<E>) => void): () => void
 * ```
 *
 * `view` lives here rather than in `Events` because the view-side `on()` has no `view` to add,
 * and a consumer annotating a handler against `Events['end']` should not have to accept a field
 * that is always absent there. `view === null` is what distinguishes a stage-originated event
 * from a re-emission.
 *
 * With amendment 5 this already carries `observed` on the `error` member; it is one field, in
 * one place, and not a second declaration of it.
 */
export type StageEvent<E extends EventName> = Events[E] & { view: View | null }
