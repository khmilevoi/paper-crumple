/**
 * The error convention of §10: functions return `Error | T`, callers narrow with
 * `instanceof Error` and exit early. Nothing in this file throws.
 */

/**
 * The brand every core error carries, in the shared symbol registry for the same reason
 * `ABORTED` is (§10.4, §10.5): two copies of this package must recognise each other's
 * errors, and a per-copy `Symbol()` would make `Err.is()` fail exactly where `instanceof`
 * already does.
 */
const CRUMPLE_BRAND: unique symbol = Symbol.for('paper-crumple.error')

/** Anything with a `.is()` narrowing guard — every class this file produces has one. */
export interface ErrorGuard<E> {
  is(x: unknown): x is E
}

/** The two members every core error accepts however it is constructed. */
export interface CrumpleErrorInit {
  readonly message: string
  readonly cause?: unknown
}

/** The shape of a tagged error's own typed properties. */
export type ErrorProps = Record<string, unknown>

/** A tagged error with no typed properties of its own. */
export type NoProps = Record<never, never>

type ErrorExtra<P extends object> = P & { readonly cause?: unknown }

/**
 * The trailing constructor argument is optional exactly when the class declares no typed
 * properties, and required when it declares some. `[keyof P] extends [never]` is written
 * with the tuple wrapper so a union of keys does not distribute.
 */
type ExtraArgs<P extends object> = [keyof P] extends [never]
  ? [extra?: ErrorExtra<P>]
  : [extra: ErrorExtra<P>]

/** An instance of a class `taggedError` produced. */
export type TaggedError<Tag extends string, P extends object> = CrumpleError & {
  readonly _tag: Tag
} & Readonly<P>

/** The class `taggedError` produces. */
export interface TaggedErrorConstructor<Tag extends string, P extends object> extends ErrorGuard<
  TaggedError<Tag, P>
> {
  new (message: string, ...extra: ExtraArgs<P>): TaggedError<Tag, P>
  new (init: ErrorExtra<P> & CrumpleErrorInit): TaggedError<Tag, P>
  readonly tag: Tag
  readonly code: string
}

/**
 * The one home for `_tag`, `code` and `Symbol.toStringTag`, and the documented
 * breadth-over-precision opt-out. **Never a return type** (§10.3): it appears in no
 * signature in this library, so it cannot dilute "every error is visible in the return
 * type".
 */
export abstract class CrumpleError extends Error {
  abstract readonly _tag: string
  abstract readonly code: string

  constructor(init: CrumpleErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    Object.defineProperty(this, CRUMPLE_BRAND, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }

  get [Symbol.toStringTag](): string {
    return this._tag
  }

  /**
   * Tag-based and brand-based, never `instanceof` (§10.4): a second copy of this package
   * declares a second set of classes, and `instanceof` across that seam is `false` on an
   * error that is ours.
   */
  static is(x: unknown): x is CrumpleError {
    return (
      typeof x === 'object' &&
      x !== null &&
      (x as Record<symbol, unknown>)[CRUMPLE_BRAND] === true &&
      typeof (x as { _tag?: unknown })._tag === 'string'
    )
  }
}

/**
 * `createTaggedError`, taken from errore under this name. Produces a concrete
 * `CrumpleError` subclass carrying `_tag`, `code`, typed properties, `cause` and a
 * static `.is()`.
 */
export function taggedError<Tag extends string, P extends object = NoProps>(
  tag: Tag,
  code: string,
): TaggedErrorConstructor<Tag, P> {
  class Tagged extends CrumpleError {
    readonly _tag: Tag = tag
    readonly code: string = code

    static readonly tag: Tag = tag
    static readonly code: string = code

    constructor(a: string | (ErrorExtra<P> & CrumpleErrorInit), b?: ErrorExtra<P>) {
      const init: Record<string, unknown> =
        typeof a === 'string' ? { ...(b ?? {}), message: a } : (a as Record<string, unknown>)
      super({ message: String(init.message ?? ''), cause: init.cause })
      this.name = tag
      for (const key of Object.keys(init)) {
        if (key === 'message' || key === 'cause') continue
        Object.defineProperty(this, key, {
          value: init[key],
          enumerable: true,
          writable: false,
          configurable: true,
        })
      }
    }

    static override is(x: unknown): x is Tagged {
      return CrumpleError.is(x) && x._tag === tag
    }
  }

  return Tagged as unknown as TaggedErrorConstructor<Tag, P>
}

/** §5.1, §7.3 — anything the GL foundation could not do. */
export const GlError = taggedError('GlError', 'ERR_GL')
/** §9 — a CRMP pack that is malformed, mis-versioned or internally inconsistent. */
export const PackError = taggedError('PackError', 'ERR_PACK')
/** §5.2 — the sheet slot could not source, build or release. */
export const SheetError = taggedError('SheetError', 'ERR_SHEET')
/** §6 — an unknown key, an ambiguous bare key, or a value out of range. */
export const KnobError = taggedError('KnobError', 'ERR_KNOB')
/** §8.5 — a fetch, a decode or a bitmap that did not arrive. */
export const AssetError = taggedError('AssetError', 'ERR_ASSET')
/**
 * §10.5 — **a cause, never a return.** Cancellation returns `ABORTED`; this class exists
 * for the wrapping case, where an error must record that the thing underneath it was
 * cancelled, and for `unwrap`, which is the one place an abort has to become a throw.
 */
export const AbortedError = taggedError('AbortedError', 'ERR_ABORTED')
/** §5.3 — `MotionSource.fit()` was handed a rect it cannot fit. */
export const MotionError = taggedError('MotionError', 'ERR_MOTION')
/** §10.1 — a pose index outside `0 … poseCount - 1` for the pack in hand. */
export const PoseError = taggedError('PoseError', 'ERR_POSE')
/** §8.5 — `build()` was called with a handle whose artwork left the scratch pool. */
export const SourceExpiredError = taggedError('SourceExpiredError', 'ERR_SOURCE_EXPIRED')
/** §4.0.1 — the element already carries a non-2D context, or already has a live view. */
export const ViewError = taggedError('ViewError', 'ERR_VIEW')
/** §10.4, amendment 7 — two copies of `@paper-crumple/core` are live in one realm. */
export const CoreDuplicateError = taggedError<
  'CoreDuplicateError',
  { version: string; existing: string }
>('CoreDuplicateError', 'ERR_CORE_DUPLICATE')
