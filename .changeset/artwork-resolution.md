---
'@paper-crumple/core': major
'@paper-crumple/paper': major
---

**The artwork's resolution is aspect-independent, and `artworkCssPx` sizes the picture rather than the paper.**

`paperSheet()` reserves the paper margin **per axis, in texels** — `ceil(overscan × artwork.h)` on
every side — instead of one uv fraction scaled by the sprite's `h / w`. A portrait sprite no
longer pays its aspect twice over: at the same `maxSize` a 2:3 sprite's artwork grows from
`maxSize / (1 + 2·p·h/w)` to `maxSize / (1 + 2p)` (at 512: jeans 355 → 404 texels, avatar 322 →
404, sneakers 405 → 451), fronts change shape (the artwork plus an equal margin, no longer the
source's aspect), and `PaperSheetHandle.overscan` equals the factory's `overscan` for every
sprite. The paint reach does not change. **A bitmap-filling photo at `overscanHeadroom: 0` can now
hit the guard band on y for a portrait sprite, as it already did on x** — pass headroom.
`freezeOverscan` loses its third parameter.

`paperStage({ artworkCssPx })` is the third member of the exactly-one-of
`maxSize | cssPx | artworkCssPx`. `cssPx` keeps meaning the CSS long side of the box the
**paper** is fitted into (front = `sizeForDisplay(cssPx × dpr)`; how much of it is artwork depends
on the source's aspect, since the margin is reserved against the artwork's height — a portrait or
square source sits near `1 / (1 + 2·overscan)` of the front, and slightly under it, while a
landscape source gets more — drawn 1:1 under `fit: 'contain'`). `View.frame.artwork` is the
authoritative per-sprite number; do not derive it from that formula. `artworkCssPx` is the CSS long side the **artwork** holds on
screen: the stage sizes its surface to `frontCapFor({ artworkLongSide: ceil(artworkCssPx × dpr),
overscan: sheet.overscan })` and asks the sheet for that many artwork texels through the new,
optional `SourceOptions.artworkLongSide`, so `View.frame.artwork` scaled by
`artworkCssPx / max(artwork.w, artwork.h)` is 1:1 at `devicePixelRatio`. USAGE's "pin the
picture" paragraph used `cssPx` for this and was wrong: it pinned the artwork at a size the front
was never built for — a 1.3–1.7× upscale in `hull`, up to 5× in `both` on tall sprites. A custom
`SheetRenderer` that ignores `artworkLongSide` degrades `artworkCssPx` to the `maxSize` reading.

The cap on the front's long side is **`FRONT_LONG_SIDE_CAP = 2048` texels** (WebGL2's guaranteed
`MAX_TEXTURE_SIZE` floor), exported next to `sizeForDisplay` with `frontCapFor`. It was 512 and
misnamed `CSS_PX_CAP`: it was applied to `cssPx × dpr`, so a 360-px tile at dpr 1.5 was already
capped. A `cssPx` stage whose tile exceeds 512 device px now gets larger fronts and a larger
surface — concretely, not just proportionally: an existing `cssPx: 400` stage at dpr 3 goes from a
512×512 surface (1 MiB) to 1216×1216 (5.6 MiB), and a stage that reaches the new ceiling costs
16 MiB (2048×2048) where it used to cost at most 1 MiB. This is the STAGE's own owned surface, not
the front LRU: `budget` bounds resident **fronts** only (`packages/core/src/front-lru.ts`'s own
"the pools are whole-stage"), so it does not shrink to compensate — and each resident front is now
roughly 5.6× larger in bytes at the same `cssPx`/dpr, so the same `budget: 64 MiB` holds
proportionally fewer of them, meaning more evictions and rebuilds in a grid.

Known limitation, unchanged: `exact: true` under `present: 'blit'` draws a front larger than the
surface clipped; use it with `present: 'direct'` or a sufficient `maxSize`.
