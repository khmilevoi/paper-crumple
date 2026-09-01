/**
 * The two aliases every geometry module in this package shares.
 *
 * Everything here works in FIELD TEXELS at texel-centre coordinates. The caller converts its
 * reference-px knobs into texels; the sheet renderer (P10) owns that `k` derivation.
 */

/** `[x, y]`, mutable because the tracer and the repair pass build loops by pushing into them. */
export type Point = [number, number]

/** A closed loop of points. The first point is not repeated at the end. */
export type Loop = Point[]
