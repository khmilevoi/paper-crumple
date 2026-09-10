import type { KnobDescriptor, Knobs, NumberKnob, IntKnob } from '@paper-crumple/core'
import type { BuiltStage } from './config'

/**
 * The write-back key. A `binds` descriptor is one core-owned value both slots share, and the
 * bare key is the one that addresses it; everything else is slot-local and needs its namespace,
 * or `stage.set` comes back with a `KnobError` on the two keys both slots own.
 */
function patchKey(ns: 'sheet' | 'motion', k: KnobDescriptor): string {
  return k.binds ? k.key : `${ns}.${k.key}`
}

export interface Entry {
  readonly key: string
  readonly k: KnobDescriptor
}

/** Every descriptor the live stage declares, in slot order, keyed the way `stage.set` wants. */
export function collectDescriptors(built: BuiltStage): Entry[] {
  const out: Entry[] = []
  for (const k of built.sheet.knobs) out.push({ key: patchKey('sheet', k), k })
  for (const k of built.motion.knobs) out.push({ key: patchKey('motion', k), k })
  return out
}

export function isNumberLike(k: KnobDescriptor): k is NumberKnob | IntKnob {
  return k.kind === 'number' || k.kind === 'int'
}

/** `IntKnob` declares no `step` at all — not even `undefined` — so the fallback has to be picked
 *  under a `kind` narrow rather than by reading `k.step` on the unnarrowed union. */
export function stepOf(k: NumberKnob | IntKnob): number {
  return k.kind === 'number' ? (k.step ?? (k.max - k.min) / 200) : 1
}

/** How many decimals a step implies — the design's own `decimals()`, verbatim. */
export function decimals(step: number): number {
  return step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
}

/** The design's own `pctOf()`, verbatim. */
export function pctOf(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100))
}

export function defaultValue(k: KnobDescriptor): Knobs[string] {
  return k.default
}
