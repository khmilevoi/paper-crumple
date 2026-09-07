import { KnobError } from './errors.js'
import type { Hex } from './knobs.js'

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * The validation domain of a `ColorKnob`. `Hex` is `` `#${string}` ``, which the compiler can
 * only check so far; this is the runtime half, and it is what stops
 * `stage.set({ paperColor: 'not a colour' })` from reaching `hexToRgb` (§6.1).
 */
export function isHex(v: unknown): v is Hex {
  return typeof v === 'string' && HEX.test(v)
}

/**
 * Convert a validated hex colour to three channels in **0…1**, which is the range
 * `material.js:170-171` feeds `uPaperColor` and `uPaperBack`.
 *
 * Moved into core because both slots need it and both bind the same two colours (§6.2). It
 * returns a `KnobError` for a malformed input rather than `[NaN, NaN, NaN]`, which is the failure
 * §6.1 opens with: the original renders black with no error at any layer.
 */
export function hexToRgb(
  hex: string,
): readonly [number, number, number] | InstanceType<typeof KnobError> {
  if (!isHex(hex)) return new KnobError(`not a hex colour: ${JSON.stringify(hex)}`)
  const body = hex.slice(1)
  const full =
    body.length === 3 ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}` : body
  const n = Number.parseInt(full, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
