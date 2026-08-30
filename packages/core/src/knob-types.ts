import type { Hex, Invalidates, KnobDescriptor } from './knobs.js'

/**
 * Collapses an intersection into one object type — hover and error-message hygiene (§6.8). The
 * `& {}` is load-bearing: it forces the mapped type to be evaluated eagerly, so a consumer hovers
 * `{ ambient: number; grain: number }` and not `Flatten<A & B & C>`.
 */
export type Flatten<T> = { [K in keyof T]: T[K] } & {}

/**
 * The value set a descriptor admits. The enum arm comes first because an `EnumKnob` also matches
 * nothing else, and putting it last would let a widened `kind` fall through.
 */
export type KnobValue<D> = D extends { kind: 'enum'; values: readonly (infer V extends string)[] }
  ? V
  : D extends { kind: 'color' }
    ? Hex
    : D extends { kind: 'bool' }
      ? boolean
      : D extends { kind: 'number' | 'int' }
        ? number
        : never

/** The resolved bag a descriptor tuple describes (§6.8). */
export type KnobsOf<D extends readonly KnobDescriptor[]> = Flatten<{
  [E in D[number] as E['key']]: KnobValue<E>
}>

/**
 * The same tuple, partitioned by invalidation class (§6.6, amendment 20). This is what gives
 * `View.set` the draw class alone and `Sprite.set` the whole ladder, so
 * `view.set({ tearAmp: 52 })` — a front-class knob on a draw-class scope — stops compiling
 * instead of failing at runtime.
 *
 * §6.6 writes this as `KnobsOf<Extract<D[number], { invalidates: L }>>`, which does not compile:
 * `KnobsOf` is constrained to `readonly KnobDescriptor[]` and `Extract` yields a *union* of
 * descriptors. The `[]` wrap is the smallest correction that keeps `KnobsOf` as the engine, which
 * is what "the same const-generic machinery that generates `KnobsOf` partitions on it" means.
 */
export type KnobsAt<D extends readonly KnobDescriptor[], L extends Invalidates> = KnobsOf<
  Extract<D[number], { invalidates: L }>[]
>
