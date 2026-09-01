---
'@paper-crumple/paper': minor
---

The CPU half of the sheet renderer: the exact Euclidean distance transform moved in from the spike's
`tools/sdf.mjs`, the band-limited marching-squares hull tracer, the packed hull polygon, the hull
cache and the alpha-mask utilities. Level 1 throughout — no GL, no DOM, no browser.

`extractContours` visits only the cells next to a texel within `CANDIDATE_BAND` of the iso value,
which turns a 250 000-cell scan into one tight pass over the field plus a few thousand real cells.
Its scratch is a **three-slot** cache rather than the single slot the spike held, because a grid
whose sprites are not all the same size reallocated on nearly every call — measured at 1.8x — and
the design has exactly three fixed front buckets, which makes three slots exactly sufficient.

Every outer loop is kept, not just the largest, so a pair of sneakers gets two pieces of paper.

`cpuSdfFromAlpha` is the **degraded** source for the CPU field and is labelled as one. The specified
path is a read-back of the GPU field, measured at 0.40-0.90 ms per sprite across a 32-sprite grid;
the exact transform is 4.06-5.68 ms per sprite in the same place. The Worker that was deferred out
of v1 is recorded as a mitigation for the fallback branch specifically.

The hull cache carries an **explicit invalidate-by-key entry point**. It takes a sprite key alone,
drops every variant registered under it, and exists because the library itself can now re-point a
key: a URL-derived re-supplier whose conditional request comes back `200` has different bytes under
the same key, and the caller on that path knows the key and nothing else.

`alphaBbox` and `rasterizeHull` return `undefined` for their absence cases rather than an `Error`.
An empty silhouette and a canvas that will not give a 2D context are absences, not failures, and the
sheet renderer maps each onto the `SheetError` its `source()` contract owes.
