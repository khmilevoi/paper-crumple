/**
 * design 2026-09-05 §6's four cells, declared once.
 *
 * **Test-only source**, on the same footing as `gl-fixture.ts` and `fixture-sources.ts` beside it:
 * reachable from neither `index.ts` nor `tiles.ts`, so `tsdown` bundles none of it and it ships in
 * no tarball, and a plain `.ts` file so several suites can import it without Vitest collecting it
 * as a suite of its own.
 *
 * `EdgeMode` is gone; `hull` WAS `smooth`/`clean` by its descriptor set (§2.4's 24 keys), so every
 * `defaultsFor('hull')` in the level-2 suites is `defaultsFor(SMOOTH_CLEAN)`. That sentence used to
 * be copied, with the constant under it, into nine test files; this is the one place it lives now.
 */
import type { EdgeSpec } from '@paper-crumple/core/unstable'

/** §6's default cell — `develop`'s `hull`, by its descriptor set. */
export const SMOOTH_CLEAN: EdgeSpec = { shape: 'smooth', finish: 'clean', widthUnit: 'px' }
export const SMOOTH_PAPER: EdgeSpec = { shape: 'smooth', finish: 'paper', widthUnit: 'px' }
export const TORN_CLEAN: EdgeSpec = { shape: 'torn', finish: 'clean', widthUnit: 'px' }
export const TORN_PAPER: EdgeSpec = { shape: 'torn', finish: 'paper', widthUnit: 'px' }

/** The four `shape x finish` combinations at `widthUnit: 'px'` — §6's table, in reading order. */
export const ALL_FOUR_CELLS: readonly EdgeSpec[] = [
  SMOOTH_CLEAN,
  SMOOTH_PAPER,
  TORN_CLEAN,
  TORN_PAPER,
]
