/**
 * IEEE 754 binary16 to and from a JavaScript number. Round-to-nearest-even on encode, so it
 * agrees bit for bit with Python's `struct` format `"e"`, which is what `bake/pack.py` writes a
 * pack's positions with (spec 9). That agreement is the whole cross-language contract: a
 * rounding mode that differs by one ulp makes the three-way fixture check fail while presenting
 * as a geometry bug.
 */

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** A number to its binary16 bit pattern, as a uint16. */
export function toHalf(value: number): number {
  f32[0] = value
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0) // inf / nan
  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00 // overflow -> inf
  if (e <= 0) {
    if (e < -10) return sign // underflow -> signed zero
    mant |= 0x800000 // subnormal: shift the hidden bit down
    const shift = 14 - e
    let half = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    if (rem > halfway || (rem === halfway && half & 1)) half++
    return sign | half
  }
  let half = sign | (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  // Carry from rounding rolls into the exponent by construction (1.111.. -> 10.000..).
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++
  return half
}

/** A binary16 bit pattern back to a number. */
export function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exp = (bits >>> 10) & 0x1f
  const mant = bits & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 0x1f) return mant ? NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}
