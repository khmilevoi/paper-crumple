import { CoreDuplicateError } from './errors.js'
import { VERSION } from './version.js'

/**
 * The same `Symbol.for` registry the abort sentinel uses (§10.5). Two copies of this package in
 * one realm see one key, which is the only reason a duplicate is detectable at all: `instanceof`
 * across that seam is already `false`.
 */
export const CORE_MARKER_KEY: unique symbol = Symbol.for('paper-crumple.core')

/** What a copy of core stashes on the realm. */
export interface CoreMarker {
  readonly version: string
}

/** Any object the marker can live on — `globalThis` in production, a literal in tests. */
export interface CoreRegistry {
  [CORE_MARKER_KEY]?: CoreMarker
}

/**
 * Claims `scope` for `marker` if it is unclaimed. Returns the marker already there, if any,
 * which is the signal that a second copy is live. Exported so the behaviour is testable without
 * a second realm; not re-exported from either barrel.
 */
export function registerCore(scope: CoreRegistry, marker: CoreMarker): CoreMarker | undefined {
  const existing = scope[CORE_MARKER_KEY]
  if (existing !== undefined) return existing
  scope[CORE_MARKER_KEY] = marker
  return undefined
}

/**
 * The testable core of `assertSingleCore`. A copy is alone exactly when the marker on the scope
 * is its own object — identity, not version equality, because two copies at the *same* version
 * are the hazard §10.4 is about just as much as two at different ones.
 */
export function checkSingleCore(
  scope: CoreRegistry,
  own: CoreMarker,
): InstanceType<typeof CoreDuplicateError> | undefined {
  const winner = scope[CORE_MARKER_KEY]
  if (winner === own) return undefined
  return new CoreDuplicateError(
    'two copies of @paper-crumple/core are live in this realm; `instanceof` across the seam is ' +
      'unreliable, so narrow with Err.is() and deduplicate the dependency',
    { version: own.version, existing: winner?.version ?? 'unknown' },
  )
}

const OWN_MARKER: CoreMarker = { version: VERSION }

const FOUND = registerCore(globalThis as CoreRegistry, OWN_MARKER)

if (FOUND !== undefined) {
  // Once per session, because module evaluation happens once (§10.4, belt and braces).
  console.warn(
    `[paper-crumple] two copies of @paper-crumple/core are live: ${FOUND.version} was already ` +
      `registered and this one is ${VERSION}. Call assertSingleCore() to make this a startup ` +
      `failure, and narrow errors with Err.is() rather than instanceof.`,
  )
}

/**
 * Promotes the once-per-session warning into something an application can fail on (amendment 7).
 * A `console.warn` is invisible in exactly the environment where duplication does the most damage
 * — a production build with a third-party wrapper in the graph — so this returns the error rather
 * than throwing it, in keeping with everything else here, and the application decides whether a
 * duplicate core is a startup failure or a logged degradation.
 */
export function assertSingleCore(): InstanceType<typeof CoreDuplicateError> | undefined {
  return checkSingleCore(globalThis as CoreRegistry, OWN_MARKER)
}
