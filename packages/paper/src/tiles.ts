/**
 * `@paper-crumple/paper/tiles` — the opt-in tile subpath (§14).
 *
 * **A named export, never a default** (§18, closing USAGE open question 4): the specifier and the
 * identifier then match, a consumer reading the import line can tell what it brought in, and
 * `attw` has a name to check rather than an anonymous binding.
 *
 * ```ts
 * import { paperSheet } from '@paper-crumple/paper'
 * import { tiles } from '@paper-crumple/paper/tiles'
 * const sheet = paperSheet({ edgeShape: 'torn', edgeFinish: 'paper', tiles })
 * ```
 *
 * The default is `tiles: null`, and the reason is **not** weight — the re-encoding measurement
 * put these four files at 0.74x one motion pack, so the old "5.6x one pack" argument does not
 * survive it. The reason is that **the default cell is `smooth`/`clean`** (design 2026-09-05 §2,
 * §8.6), which needs no tear, no teeth and no fibre at all, so the modal consumer would be
 * charged for an asset their configuration cannot use.
 *
 * Every URL is `new URL('./tiles/<name>.webp', import.meta.url)` from a module shipped beside the
 * asset (§14). `tsdown.config.ts` copies the four files into `dist/tiles/`, so the specifier
 * resolves identically from `src/` under Vitest and from `dist/` in a tarball.
 */
import type { PaperTileSet } from './tile-set.js'

export type { PaperTileSet } from './tile-set.js'

export const tiles: PaperTileSet = {
  crumpleR: new URL('./tiles/crumple-r.webp', import.meta.url),
  crumpleG: new URL('./tiles/crumple-g.webp', import.meta.url),
  crumpleA: new URL('./tiles/crumple-a.webp', import.meta.url),
  fibreA: new URL('./tiles/fibre-a.webp', import.meta.url),
}
