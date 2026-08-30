import { KnobError } from './errors.js'
import { maxInvalidation } from './invalidation.js'
import { validateKnobValue } from './knob-validate.js'
import { SHARED_KNOBS } from './shared-knobs.js'
import type { Invalidates, KnobDescriptor, Knobs } from './knobs.js'

export type SlotName = 'sheet' | 'motion'
export type KnobScope = 'core' | SlotName
export type KnobPrimitive = string | number | boolean

/**
 * The registry's storage, and §6.2's ground truth: **every value under its namespaced path** —
 * `core.paperColor`, `sheet.grain`, `motion.grain`. The bare form a consumer writes is a resolver
 * over this, never a second store.
 */
export type KnobValues = Readonly<Record<string, KnobPrimitive>>

type Fault = InstanceType<typeof KnobError>

export interface KnobTarget {
  readonly scope: KnobScope
  /** `${scope}.${descriptor.key}` — the path this descriptor's value lives under. */
  readonly path: string
  readonly descriptor: KnobDescriptor
}

export interface KnobRegistry {
  /** Core first, then each slot in declaration order. This is `stage.knobs` (§10.6). */
  readonly descriptors: readonly KnobDescriptor[]
  readonly bySlot: Readonly<Record<KnobScope, readonly KnobDescriptor[]>>
  /**
   * The bare keys `AmbiguousKeys` excludes from the slot-owned half of the flat union — both
   * slots owning one key, and a slot owning a key core declares as shared. Exposed so that
   * `knob-registry.test.ts` can pin the two tiers against each other; a *shared* key in this set
   * still resolves, to the shared knob, which is what the type does too.
   */
  readonly ambiguous: ReadonlySet<string>
  resolve(key: string): readonly KnobTarget[] | Fault
  normalise(
    patch: Readonly<Record<string, unknown>>,
    scope: readonly Invalidates[],
  ): KnobValues | Fault
  /** Every descriptor's own default, under its namespaced path. */
  defaults(): KnobValues
  /** The strongest level a namespaced delta touches, or `undefined` if it touches nothing. */
  invalidationOf(delta: KnobValues): Invalidates | undefined
  /**
   * §5.5's filtered view, **built once at mount and reused**: the returned function closes over
   * this slot's key list and does no per-draw scan of the other slot's descriptors. It allocates
   * a fresh bag per call rather than reusing one, because a slot that retains the bag would be an
   * invisible aliasing bug and the contract cannot forbid retention.
   */
  projector(slot: SlotName): (values: KnobValues) => Knobs
}

const SHARED_KEYS: ReadonlySet<string> = new Set(SHARED_KNOBS.map((d) => d.key))

/**
 * Build the knob registry for one stage, from the two slots the consumer passed. Called once at
 * mount.
 *
 * **Construction can never fail on a name.** The original made a duplicate key a `KnobError` at
 * mount, under which the default configuration of §4 does not start — `grain` and `debug` are
 * declared by both built-in slots — and, worse, an additive minor becomes a breaking change:
 * `paperSheet` gaining one knob in `1.3.0` retroactively collides with a third-party motion
 * source's knob and kills a working application on `pnpm update`, with neither author able to fix
 * it without a breaking rename. Ambiguity surfaces at the ambiguous `set()` instead, which is the
 * only place ambiguity actually exists.
 */
export function createKnobRegistry(slots: {
  readonly sheet: readonly KnobDescriptor[]
  readonly motion: readonly KnobDescriptor[]
}): KnobRegistry {
  const targets: KnobTarget[] = []
  const push = (scope: KnobScope, list: readonly KnobDescriptor[]): void => {
    for (const descriptor of list) {
      targets.push({ scope, path: `${scope}.${descriptor.key}`, descriptor })
    }
  }
  push('core', SHARED_KNOBS)
  push('sheet', slots.sheet)
  push('motion', slots.motion)

  const byPath = new Map(targets.map((t) => [t.path, t]))

  // Bare keys a slot owns outright. A bound descriptor is addressed by its `binds` key, so it
  // contributes no bare key of its own and takes no part in ambiguity.
  const own = new Map<string, KnobTarget[]>()
  for (const t of targets) {
    if (t.scope === 'core' || t.descriptor.binds !== undefined) continue
    const list = own.get(t.descriptor.key)
    if (list === undefined) own.set(t.descriptor.key, [t])
    else list.push(t)
  }

  // A shared group: core's declaration, then every descriptor that binds it. Setting the shared
  // key writes all of them, which is what "identical in the 2D sheet and in the 3D fill" means.
  const shared = new Map<string, KnobTarget[]>()
  for (const t of targets) if (t.scope === 'core') shared.set(t.descriptor.key, [t])
  for (const t of targets) {
    const binds = t.descriptor.binds
    if (binds === undefined) continue
    shared.get(binds)?.push(t)
  }

  const ambiguous = new Set<string>()
  for (const [key, list] of own) {
    if (list.length > 1 || SHARED_KEYS.has(key)) ambiguous.add(key)
  }

  const resolve = (key: string): readonly KnobTarget[] | Fault => {
    const dot = key.indexOf('.')
    if (dot >= 0) {
      const ns = key.slice(0, dot)
      if (ns !== 'sheet' && ns !== 'motion') {
        return new KnobError(
          `unknown knob namespace '${ns}' in '${key}' — expected 'sheet.' or 'motion.'`,
        )
      }
      const target = byPath.get(key)
      if (target === undefined) return new KnobError(`unknown knob '${key}'`)
      const binds = target.descriptor.binds
      if (binds !== undefined) {
        return new KnobError(
          `'${key}' is bound to the core-declared shared knob '${binds}'; set '${binds}' instead, which is what keeps every bound slot identical`,
        )
      }
      return [target]
    }
    const group = shared.get(key)
    if (group !== undefined) return group
    if (ambiguous.has(key)) {
      return new KnobError(
        `ambiguous knob '${key}': declared by more than one slot — use 'sheet.${key}' or 'motion.${key}'`,
      )
    }
    const list = own.get(key)
    if (list === undefined) return new KnobError(`unknown knob '${key}'`)
    return list
  }

  const normalise = (
    patch: Readonly<Record<string, unknown>>,
    scope: readonly Invalidates[],
  ): KnobValues | Fault => {
    const out: Record<string, KnobPrimitive> = {}
    for (const [key, value] of Object.entries(patch)) {
      const resolved = resolve(key)
      if (KnobError.is(resolved)) return resolved
      // A shared key spans several descriptors; its effective class is the strongest of them, so
      // a slot that binds at a higher level than core declared is handled rather than smuggled.
      const level = maxInvalidation(resolved.map((t) => t.descriptor.invalidates))
      if (level !== undefined && !scope.includes(level)) {
        return new KnobError(
          `'${key}' is a ${level}-class knob and cannot be set on this scope — front-class knobs live on the sprite`,
        )
      }
      for (const target of resolved) {
        const bad = validateKnobValue(target.descriptor, value)
        if (bad !== undefined) return bad
        out[target.path] = value as KnobPrimitive
      }
    }
    return out
  }

  const defaults = (): KnobValues => {
    const out: Record<string, KnobPrimitive> = {}
    for (const t of targets) out[t.path] = t.descriptor.default
    return out
  }

  const invalidationOf = (delta: KnobValues): Invalidates | undefined =>
    maxInvalidation(
      Object.keys(delta).flatMap((path) => {
        const target = byPath.get(path)
        return target === undefined ? [] : [target.descriptor.invalidates]
      }),
    )

  const projector = (slot: SlotName): ((values: KnobValues) => Knobs) => {
    // Core first, then the slot: "core defaults -> slot defaults", so a slot's own key wins on a
    // collision with a shared one. Built here, at mount, and never rebuilt.
    const pairs: Array<readonly [string, string]> = []
    for (const t of targets) if (t.scope === 'core') pairs.push([t.descriptor.key, t.path])
    for (const t of targets) if (t.scope === slot) pairs.push([t.descriptor.key, t.path])
    return (values) => {
      const bag: Record<string, KnobPrimitive> = {}
      for (const [key, path] of pairs) {
        const value = values[path]
        if (value !== undefined) bag[key] = value
      }
      return bag
    }
  }

  return {
    descriptors: targets.map((t) => t.descriptor),
    bySlot: { core: SHARED_KNOBS, sheet: slots.sheet, motion: slots.motion },
    ambiguous,
    resolve,
    normalise,
    defaults,
    invalidationOf,
    projector,
  }
}

/**
 * §6.6's resolution order, as a function: **core defaults → slot defaults → sprite → view**,
 * later wins. P9 calls it with `[registry.defaults(), spriteDelta, viewDelta]`.
 */
export function resolveKnobValues(layers: readonly KnobValues[]): KnobValues {
  const out: Record<string, KnobPrimitive> = {}
  for (const layer of layers) {
    for (const [path, value] of Object.entries(layer)) out[path] = value
  }
  return out
}
