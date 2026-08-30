/**
 * # §6.1 — the knob descriptor union
 *
 * The core owns the registry; slots only declare descriptors, and the core declares the shared
 * ones (`./shared-knobs.ts`). A descriptor is the engine's validation domain *and* the seed of
 * the generated types, which is why the presentation fields are quarantined in `ui`.
 */

/** A CSS hex colour, `#rgb` or `#rrggbb`. Validated by `isHex` in `./color.ts`. */
export type Hex = `#${string}`

/**
 * The invalidation ladder (§6.3), ordered: **a level implies every level to its left**.
 *
 * ```
 * draw   -> next draw only
 * front  -> rebuild the front texture
 * hull   -> invalidate the hull cache, then front
 * field  -> re-run the SDF / looseness field, then hull, then front
 * ```
 *
 * `invalidates` has two jobs and a descriptor author must know both. It is a cache signal, and
 * since amendment 20 it is also the partition that decides *where* a knob can be set: `KnobsAt`
 * extracts the descriptors at a given level, so a knob declared `'front'` is absent from
 * `view.set`'s parameter type rather than accepted and refused at runtime (§6.6). A descriptor
 * whose `invalidates` is wrong no longer produces a stale texture; it produces a knob a consumer
 * cannot reach, which is the louder failure and the right way round.
 */
export type Invalidates = 'draw' | 'front' | 'hull' | 'field'

/**
 * Presentation only, and **optional on purpose**: a consumer's bundle does not carry ~45 English
 * label strings for a UI this library does not own (§6.1). A panel that wants labels supplies its
 * own, or the slot ships them and the consumer pays for what they asked for.
 */
export interface KnobUi {
  readonly label?: string
  readonly unit?: string
  readonly group?: string
}

/**
 * The core-declared shared values a slot descriptor may bind to (§6.2). `paperColor` and
 * `paperBack` are declared bindings — `material.js:170-171` sets both — and not naming
 * coincidences. `lightAngle` is deliberately **not** here: `material.js:167` sets `uLight` from
 * the manifest's light vector, which §9.3 bakes into the pack, so it is paper-only.
 */
export type SharedKnob = 'paperColor' | 'paperBack'

export interface KnobBase {
  /** Slot-local, and carrying no namespace of its own. The registry adds one. */
  readonly key: string
  /** Opt in to a core-declared shared value. A bound knob is addressed by `binds`, never by
   *  `${slot}.${key}` — that is what keeps the two slots identical (§6.2). */
  readonly binds?: SharedKnob
  readonly invalidates: Invalidates
  /** Excluded from presets and the default UI panel. */
  readonly dev?: boolean
  readonly ui?: KnobUi
}

export interface NumberKnob extends KnobBase {
  readonly kind: 'number'
  readonly default: number
  /** Required, not optional: `set()` promises a `KnobError` for an out-of-range value, which is
   *  unenforceable for any knob whose author omitted the bound (§6.1). */
  readonly min: number
  readonly max: number
  readonly step?: number
  /** Quoted against a 1000 px-tall sprite; the renderer rescales, the UI shows it unscaled
   *  (§6.4). Use `scaleKnob` below. */
  readonly reference?: 'sprite-px'
}

export interface IntKnob extends KnobBase {
  readonly kind: 'int'
  readonly default: number
  readonly min: number
  readonly max: number
}

export interface BoolKnob extends KnobBase {
  readonly kind: 'bool'
  readonly default: boolean
}

export interface ColorKnob extends KnobBase {
  readonly kind: 'color'
  readonly default: Hex
}

export interface EnumKnob extends KnobBase {
  readonly kind: 'enum'
  readonly values: readonly string[]
  readonly default: string
}

export type KnobDescriptor = NumberKnob | IntKnob | BoolKnob | ColorKnob | EnumKnob

/**
 * A resolved knob bag: key to value. This is what a slot receives, filtered to its own keys plus
 * the core-declared shared ones (§5.5). `KnobsOf` in `./knob-types.ts` is what produces a precise
 * one from a descriptor tuple.
 */
export type Knobs = Readonly<Record<string, string | number | boolean>>

/** The height the px-valued knobs are quoted against (`paper.js:34`, §6.4). */
export const KNOB_REFERENCE_PX = 1000

/**
 * Declare a slot's descriptors. The `const` type parameter is what preserves every literal — the
 * keys, the `invalidates` levels, the enum members — so the generated types can be built from the
 * tuple. **This is the 5.0 floor** (§6.8): `const` type parameters are emitted verbatim into
 * `.d.ts` and on 4.9 that is `TS1139`, which kills the whole declaration file for a consumer who
 * never calls this function.
 */
export function knobs<const D extends readonly KnobDescriptor[]>(d: D): D {
  return d
}

/** What `enumKnob` takes: an `EnumKnob` minus the `kind` it fills in. */
export interface EnumKnobSpec extends KnobBase {
  readonly values: readonly string[]
  readonly default: string
}

/**
 * Declare an enum knob. It exists because `default ∈ values` is a **cross-field** constraint: the
 * alternative, a mapped-type validator on `knobs()`, compiles but collapses the offending tuple
 * element to `never` and reports six errors, none of which points at `default`. This factory
 * reports `TS2820: … Did you mean '"normals"'?` at the field that is wrong. Two enum knobs exist
 * in the whole library, so the factory costs nothing (§6.8).
 */
export function enumKnob<const D extends EnumKnobSpec>(
  d: D & { readonly default: D['values'][number] },
): D & { readonly kind: 'enum' } {
  // The assertion is the spread's, not the caller's: TypeScript cannot express that spreading a
  // generic `D` and adding one literal member yields `D & { kind: 'enum' }`.
  return { ...d, kind: 'enum' } as D & { readonly kind: 'enum' }
}

/** `engine.js`'s `pxScale = asset.image.height / KNOB_REFERENCE_PX` (§6.4). */
export function pxScale(spriteHeightPx: number): number {
  return spriteHeightPx / KNOB_REFERENCE_PX
}

/**
 * Rescale a value that was quoted against the reference height. A renderer calls this; the UI
 * never does, because §6.4 shows the unscaled number.
 */
export function scaleKnob(d: KnobDescriptor, value: number, spriteHeightPx: number): number {
  return d.kind === 'number' && d.reference === 'sprite-px'
    ? value * pxScale(spriteHeightPx)
    : value
}
