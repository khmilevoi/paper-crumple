/**
 * The byte accounting (spec 8.1, 8.5, 8.9).
 *
 * Every figure here reproduces a number the specification states, and each one is derived rather
 * than asserted: the front tier from the bucket sizes, Pool A from two independent readings of
 * 8.1, Pool B from the source dimensions.
 */
import type { Size } from './geometry.js'

/** RGBA8, no mipmaps, non-premultiplied (spec 8.7). */
export const FRONT_BYTES_PER_TEXEL = 4

/**
 * Pool A's field term is 28.25 bytes per `sdfRes` texel, written as `113 / 4` so the law never
 * leaves integer arithmetic. `sdfRes` is always a multiple of 64, so `sdfRes² / 4` is an integer.
 *
 * Spec 8.1 states the constant twice and both readings agree. At `maxSize` 384 the artwork is
 * 326 x 326 x 4 = 425 104 B and Pool A is 1 466 512 B, leaving 1 041 408 B = 28.25 x 192². On the
 * `exact` path 8.1 states the field term alone: 7 405 568 B at `sdfRes` 512 = 28.25 x 512².
 *
 * **Which textures realise those bytes is P6's, not this module's** - the JFA ping-pong, the hull
 * mask, the hull field and the hull canvas, which 8.1 names but does not itemise by format. P6's
 * Pool A allocation must sum to `poolABytes`.
 */
export const POOL_A_FIELD_BYTES_NUMERATOR = 113

/**
 * The per-sprite field pair inside Pool A, 2.125 bytes per texel written as `17 / 8`: a tight R16F
 * field at 2 B/texel plus a loose field at quarter linear size, also R16F, at 0.125 B/texel. At
 * `sdfRes` 192 that is 73 728 + 4 608 = 78 336 B, roughly six times *smaller* than a front - which
 * is what 8.1 corrects, the original having claimed the fields were larger.
 */
export const SPRITE_FIELD_BYTES_NUMERATOR = 17

/** The cold-hull `Float32Array`, allocated and freed inside the call, never pooled (spec 8.1). */
export const CPU_SDF_BYTES_PER_TEXEL = 4

/**
 * `handleBytes` is a declared budget model, not a heap measurement: a JavaScript engine's object
 * sizes are not observable from JavaScript, so spec 8.9's handle tier can only ever be a model.
 * Every term is enumerated below and the two properties spec 11 names - under 4096 bytes, and
 * independent of source size - are asserted directly rather than inferred from the total.
 */
export const HANDLE_OBJECT_BYTES = 32

/** One property slot: a double, or a pointer to another object. */
export const HANDLE_SLOT_BYTES = 8

/** One typed-array view object plus its `ArrayBuffer` header, excluding the elements. */
export const HANDLE_VIEW_BYTES = 96

/** A front costs `w x h x 4` bytes and nothing else. */
export function frontBytes(size: Size): number {
  return size.w * size.h * FRONT_BYTES_PER_TEXEL
}

/** Anything with a byte length - every `ArrayBufferView` satisfies this structurally. */
export interface CountedBuffer {
  readonly byteLength: number
}

/**
 * Everything a handle retains, resident and unbudgeted (spec 8.5): `rect`; the derived `overscan`;
 * `sdfRes`; the source dimensions and aspect; the `exact` flag; and the hull polygon.
 *
 * **A handle holds no image data at all.** The original left this tier unbudgeted while a handle
 * held the uploaded padded RGBA8 source - a mean 3 596 288 B per sprite, 359.6 MB per 100, 5.4x
 * the entire stated budget.
 */
export interface HandleFacts {
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly overscan: number
  readonly sdfRes: number
  readonly srcW: number
  readonly srcH: number
  readonly aspect: number
  readonly exact: boolean
  /**
   * The packed hull polygon's buffers - typically the points and their component offsets, and more
   * when the silhouette has several islands. P8 owns the layout; this module reads only
   * `byteLength`, so nothing here constrains it.
   */
  readonly hull: readonly CountedBuffer[]
}

/**
 * The handle's resident cost.
 *
 * The identity key is deliberately not counted: spec 8.8 puts the stable identity key in the
 * application's ownership, so the handle holds a reference to the application's string rather than
 * owning its characters. Counting them would make this figure a function of a caller's naming
 * convention.
 */
export function handleBytes(h: HandleFacts): number {
  // The handle itself: rect, overscan, sdfRes, srcW, srcH, aspect, exact, hull - eight slots.
  // srcW and srcH cost one slot each. They are the whole of this function's dependence on the
  // source, which is what makes the figure independent of source *size*.
  let total = HANDLE_OBJECT_BYTES + 8 * HANDLE_SLOT_BYTES
  // The rect: x, y, w, h.
  total += HANDLE_OBJECT_BYTES + 4 * HANDLE_SLOT_BYTES
  // The array holding the hull's buffers.
  total += HANDLE_OBJECT_BYTES + h.hull.length * HANDLE_SLOT_BYTES
  for (const buffer of h.hull) total += HANDLE_VIEW_BYTES + buffer.byteLength
  return total
}

/**
 * The tight and loose distance fields for one sprite (spec 8.1) - the per-sprite pair only, 2.125
 * of `poolABytes`' 28.25 bytes per texel. This is **not** the whole Pool A field term; `poolABytes`
 * uses `POOL_A_FIELD_BYTES_NUMERATOR` for that and never calls this function.
 */
export function fieldBytes(sdfRes: number): number {
  return (sdfRes * sdfRes * SPRITE_FIELD_BYTES_NUMERATOR) / 8
}

/** The cold-hull CPU EDT scratch, freed inside the call (spec 8.1). */
export function cpuSdfBytes(sdfRes: number): number {
  return sdfRes * sdfRes * CPU_SDF_BYTES_PER_TEXEL
}

/**
 * Pool A - artwork, JFA ping-pong, fields, hull mask, hull field, hull canvas. **Sized by
 * `maxSize`**, resident for everything after the resample.
 */
export function poolABytes(artwork: Size, sdfRes: number): number {
  return frontBytes(artwork) + ((sdfRes * sdfRes) / 4) * POOL_A_FIELD_BYTES_NUMERATOR
}

/**
 * Pool B - source staging, one slot, released after an idle interval. **Sized by the source**, not
 * by `maxSize`.
 *
 * There are two pools and not one because these two laws differ. Folding them together would
 * re-import the exact failure `maxSize` exists to delete: one 4000 px asset in a wardrobe would
 * permanently size the stage's scratch to tens of megabytes. Their lifetimes are disjoint too -
 * staging is live only across the resample, the first pass of a build, while the fields and hull
 * slots are live for everything after it.
 */
export function poolBBytes(source: Size): number {
  return frontBytes(source)
}

export interface ScratchRequest {
  /** `A`, the artwork rect the resample writes into - front-derived, never source-derived. */
  readonly artwork: Size
  readonly sdfRes: number
  /** The source, whose dimensions size Pool B alone. */
  readonly source: Size
}

export interface ScratchBytes {
  readonly poolA: number
  readonly poolB: number
  /** Pool A plus Pool B: the transient high-water mark of one build. */
  readonly peak: number
}

/**
 * The two pools and the build peak (spec 8.1).
 *
 * On the `exact` path the caller passes the source dimensions as the artwork too - `A === source`,
 * because `identityResample` is the identity there - and the result is a **dedicated, non-pooled**
 * scratch set that is released synchronously at the end of the build. It must never grow either
 * pool, or one tap on a thumbnail permanently sizes the stage's scratch to ~39 MB and 8.9's grid
 * budget stops being true.
 */
export function scratchBytes(r: ScratchRequest): ScratchBytes {
  const poolA = poolABytes(r.artwork, r.sdfRes)
  const poolB = poolBBytes(r.source)
  return { poolA, poolB, peak: poolA + poolB }
}
