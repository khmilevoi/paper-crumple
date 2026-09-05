---
'@paper-crumple/core': patch
---

**The per-sprite view fan-out walks a snapshot of the view index, not the live set.**

`stage.set()` at draw class and the re-source's redraw refresh every view showing the sprite. A
`show()` of one of those views onto the same sprite from inside that refresh — the shape a
consumer's `on('error')` or orphan handler (spec 10.6) can take — moves the view to the end of the
index's live `Set`, and a `Set` iterator visits entries appended during iteration, so the fan-out
revisited the view and never ran out. Both loops now iterate a copy taken before the first refresh,
as `remove({ detach })` already did.
