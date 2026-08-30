import { KnobError } from './errors.js'
import { isHex } from './color.js'
import type { KnobDescriptor } from './knobs.js'

/** Safe for any input, symbols included — `String(aSymbol)` throws, and nothing here may throw. */
function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) {
    return String(v)
  }
  return `a ${typeof v}`
}

/**
 * The runtime validation domain of a descriptor (§6.1). **This is the half amendment 18 does not
 * touch**: a value is not a name, and no type can bound a number the consumer computed, so
 * `KnobError` for an out-of-range value stays for the typed and the untyped caller alike.
 *
 * `min` and `max` are required on the numeric kinds precisely so that this function can keep
 * `set()`'s promise; the original had them optional while promising the error.
 */
export function validateKnobValue(
  d: KnobDescriptor,
  value: unknown,
): InstanceType<typeof KnobError> | undefined {
  switch (d.kind) {
    case 'number':
    case 'int': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return new KnobError(`'${d.key}' takes a finite number, got ${show(value)}`)
      }
      if (d.kind === 'int' && !Number.isInteger(value)) {
        return new KnobError(`'${d.key}' takes an integer, got ${show(value)}`)
      }
      if (value < d.min || value > d.max) {
        return new KnobError(
          `'${d.key}' is out of range: ${show(value)} is not within [${show(d.min)}, ${show(d.max)}]`,
        )
      }
      return undefined
    }
    case 'bool':
      return typeof value === 'boolean'
        ? undefined
        : new KnobError(`'${d.key}' takes a boolean, got ${show(value)}`)
    case 'color':
      return isHex(value)
        ? undefined
        : new KnobError(`'${d.key}' takes a hex colour like '#f7f4ed', got ${show(value)}`)
    case 'enum':
      return typeof value === 'string' && d.values.includes(value)
        ? undefined
        : new KnobError(
            `'${d.key}' takes one of ${d.values.map((v) => `'${v}'`).join(', ')}, got ${show(value)}`,
          )
  }
}
