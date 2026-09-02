---
'@paper-crumple/motion': minor
'@paper-crumple/core': minor
---

`bakedMotion()`: the `MotionSource` half of the package, and one export subpath per built-in pack.

`fit(rect, override?)` is pure — it picks the bucket, covers the box and returns `frontSize` with
an opaque `sortKey` the core batches on without interpreting. `load(fit)` replaces the original's
`load(variant)`, which had no legal caller because `MotionFit` is opaque to the core, and it
returns the `ABORTED` sentinel on cancellation rather than an `AbortedError` — abort is not a
failure, and `LoadError` no longer carries one. Per-bucket state lives in a `Map` and on the clip,
never as two scalars on the source that two loaded buckets would leave describing whichever landed
last. The shared per-bucket fetch is deduped, refcounted, and **never cancelled by a per-sprite
signal**: it is shared by every sprite in that bucket, and cancelling a 539 KB fetch to save
bandwidth on a scroll costs a re-download two tiles later.

The sheet mesh is twelve preconfigured VAOs per bucket, thirty-six in total, with no per-pose
`bufferSubData` — a whole class of mutable state removed, which is what makes N sprites cheap. The
attribute layout `position: 0, normal: 1, ao: 2, uv: 3` matches the `layout(location = N)`
declarations in the GLSL, and the VAO lives with the slot rather than the stage, because a VAO *is*
the attribute-layout binding. `SHEET_VS` and `SHEET_FS` bind exactly two textures and clear
nothing: the view performs a scissored clear over its own rect, and the slot cannot clear at all.

Each of the three packs is one module and one export subpath, with its manifest inlined, `sim` a
separate export so it tree-shakes to zero, and its binary reached with
`new URL('./2x3.bin', import.meta.url)` from a module shipped beside it. The main entry imports
`./packs` not at all, and an unsupplied bucket returns an `AssetError` naming the subpath the
consumer forgot to import.

`@paper-crumple/core` gains the two members of `DrawResult` that §5.3 named and never gave.
