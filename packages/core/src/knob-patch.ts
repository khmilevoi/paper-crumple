import type { Invalidates, KnobDescriptor, SharedKnob } from './knobs.js'
import type { Flatten, KnobValue, KnobsAt } from './knob-types.js'
import type { SHARED_KNOBS } from './shared-knobs.js'
import type { SetResult } from './results.js'

type Slot = readonly KnobDescriptor[]

/**
 * Descriptors that opt into a core-declared shared value. A bound descriptor is addressed by its
 * `binds` key and never by `${slot}.${key}` — that redirection is what makes the declared binding
 * of §6.2 unbreakable, and `docs/USAGE.md` §7 writes the panel's write-back the same way:
 * `` k.binds ? k.key : `${ns}.${k.key}` ``.
 */
export type BoundKnobs<D extends Slot> = Extract<D[number], { binds: SharedKnob }>

/** Descriptors that own their key outright. Ambiguity is computed over these alone. */
export type OwnKnobs<D extends Slot> = Exclude<D[number], { binds: SharedKnob }>

/**
 * # Amendment 18 — the keys the flat union excludes
 *
 * Two ways a bare key stops being unambiguous:
 *
 * 1. **Both slots own it.** `grain` and `debug` are the built-in pair's collisions, and they are
 *    not accidentally-identical knobs: the two `grain` values are tuned separately against a flat
 *    sheet and a shaded 3D mesh, and `edge.js:86` already forces `debug: 0` into the 2D engine's
 *    params when building the front. There was never one `grain` to set.
 * 2. **A slot owns a key core already declares as shared.** The shared knob keeps the bare key,
 *    because `stage.set({ paperColor: '#f7f4ed' })` is the design's own worked example; the
 *    slot's unrelated key survives, namespaced.
 *
 * ## Release checklist — this is the exposure amendment 18 buys
 *
 * A slot that adds a key colliding with an existing unique one **removes that key from the
 * generated flat union and breaks a TypeScript consumer's build in a minor release**. That is the
 * cost of moving ambiguity from a return value to the compiler, and it is deliberate: the old
 * rule made a duplicate key a `KnobError` **at mount**, under which `paperSheet` gaining one knob
 * in `1.3.0` retroactively kills a working application on `pnpm update` and neither author can
 * fix it without a breaking rename. A source break at one call site beats a dead application, and
 * it is visible at the keystroke rather than in production.
 *
 * **So: review descriptor keys for collisions before every minor.** The exposure is compile-time
 * only — the runtime validator still returns a `KnobError` for an ambiguous bare key, so a
 * JavaScript consumer is unaffected. `knob-patch.test-d.ts` pins the behaviour, and
 * `knob-registry.test.ts` pins that the runtime agrees with it.
 */
export type AmbiguousKeys<S extends Slot, M extends Slot> =
  | Extract<OwnKnobs<S>['key'], OwnKnobs<M>['key']>
  | Extract<OwnKnobs<S>['key'] | OwnKnobs<M>['key'], SharedKnob>

type AtLevel<D extends Slot, L extends Invalidates> = Exclude<
  Extract<D[number], { invalidates: L }>,
  { binds: SharedKnob }
>

/**
 * The core-declared shared knobs at a level. Their invalidation class is **core's** declaration —
 * both are `'front'`, so `paperColor` is sprite-scoped and absent from `view.set`, which is what
 * §6.6 says about a front-class knob. A slot that binds one may raise its effective level; the
 * runtime takes the maximum across core and every binder, and `shared-knobs.test.ts` pins core's
 * declaration so the two tiers cannot drift.
 */
export type SharedKnobsAt<L extends Invalidates> = KnobsAt<typeof SHARED_KNOBS, L>

/** The bare half of the patch type: slot-owned keys at `L`, minus the ambiguous ones. */
export type FlatKnobsAt<S extends Slot, M extends Slot, L extends Invalidates> = {
  [
    E in AtLevel<S, L> | AtLevel<M, L> as E['key'] extends AmbiguousKeys<S, M> ? never : E['key']
  ]: KnobValue<E>
}

/** The namespaced half — always unambiguous, and the ground truth the bare half resolves into. */
export type NamespacedKnobsAt<S extends Slot, M extends Slot, L extends Invalidates> = {
  [E in AtLevel<S, L> as `sheet.${E['key']}`]: KnobValue<E>
} & {
  [E in AtLevel<M, L> as `motion.${E['key']}`]: KnobValue<E>
}

/**
 * Everything settable at a level: the shared knobs, the unambiguous bare keys, and the namespaced
 * ground truth. **Ambiguity is computed over the whole registry, not over the level**, so a key
 * both slots declare at different levels is excluded everywhere — the runtime resolver knows
 * nothing about scope when it decides a name is ambiguous, and the two tiers have to agree.
 */
export type KnobPatchAt<S extends Slot, M extends Slot, L extends Invalidates> = Flatten<
  SharedKnobsAt<L> & FlatKnobsAt<S, M, L> & NamespacedKnobsAt<S, M, L>
>

/** The whole ladder — what a stage and a sprite accept. */
export type KnobPatch<S extends Slot, M extends Slot> = KnobPatchAt<S, M, Invalidates>

/** §6.6 — a view is a draw-class scope. */
export type ViewKnobPatch<S extends Slot, M extends Slot> = KnobPatchAt<S, M, 'draw'>

/**
 * §6.6 — a sprite takes the whole ladder, **`'draw'` included**. The resolution order
 * "core defaults → slot defaults → sprite → view" says a sprite may carry draw-class values, and
 * amendment 20 resolves the section's contradiction in the order's favour. This is the same union
 * as `KnobPatch`; it exists as a name so P9 writes the scope it means rather than the one that
 * happens to coincide.
 */
export type SpriteKnobPatch<S extends Slot, M extends Slot> = KnobPatchAt<S, M, Invalidates>

/**
 * # Amendment 19 — one `set()`
 *
 * `setExact()` is cut. The hole it existed to close — a patch built in a **variable**, where
 * excess-property checking does not run, which is exactly where presets and config objects live —
 * is closed by the parameter type instead, at every call site, with no second method for a
 * consumer to know about and choose between.
 *
 * `Partial<Allowed>` checks the values of the keys that are allowed; the `Record` maps every key
 * the argument has and `Allowed` does not to `never`, which nothing can satisfy. Used as the
 * *constraint* of a naked type parameter rather than as an intersection in the parameter
 * position, so that a fresh object literal is also checked against it.
 *
 * **Observed on TypeScript 5.9.3:** with the `@ts-expect-error` directives temporarily removed,
 * `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` (run from the workspace root, the
 * only `tsconfig.json` this workspace has) reports, for `set({ ambiant: 0.5 })`:
 * `packages/core/src/knob-patch.test-d.ts(81,9): error TS2322: Type 'number' is not assignable
 * to type 'never'.` For `set(preset)`, where `preset` is a variable:
 * `packages/core/src/knob-patch.test-d.ts(86,7): error TS2345: Argument of type '{ tearAmp:
 * number; ambiant: number; }' is not assignable to parameter of type 'NoExcess<{ tearAmp:
 * number; ambiant: number; }, { … }>'. Type '{ tearAmp: number; ambiant: number; }' is not
 * assignable to type 'Record<"ambiant", never>'. Types of property 'ambiant' are incompatible.
 * Type 'number' is not assignable to type 'never'.` **Neither position produces `TS2561`, and
 * neither carries a "Did you mean to write 'ambient'?" suggestion.** §6.8's claim does not hold
 * under this design: because the parameter of `KnobSetter` is a naked, self-referential type
 * parameter (`<T extends NoExcess<T, P>>`) rather than a concrete object type, TypeScript infers
 * `T` from the argument — literal or variable alike — and then checks the inferred `T` against
 * the instantiated constraint. That is a constraint-satisfaction check, not the "is this a fresh
 * object literal assigned to a known target type" check that produces excess-property errors
 * with spelling suggestions, so both positions fail the same way, via the `Record<…, never>` arm
 * of `NoExcess`, and neither fires `TS2561`. The contract this plan owes — rejection in both
 * positions — holds regardless; only the message differs from what §6.8 predicted.
 */
export type NoExcess<T, Allowed> = Partial<Allowed> & Record<Exclude<keyof T, keyof Allowed>, never>

/**
 * The shape of `stage.set`, `sprite.set` and `view.set`. The return is **`KnobError | undefined`**
 * — `undefined` and not `void` — so `if (err)` narrows and the result is storable, which is
 * §10's convention holding at the most-used method in the library. `SetResult` is P2's alias for
 * exactly that union.
 */
export type KnobSetter<P> = <T extends NoExcess<T, P>>(patch: T) => SetResult
