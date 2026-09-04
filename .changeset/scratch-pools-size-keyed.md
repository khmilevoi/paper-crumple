---
'@paper-crumple/core': patch
'@paper-crumple/paper': patch
---

**Size-keyed scratch slots, and `TextureFactory` now needs `target` too** (the `/unstable`
slot-authoring surface, spec 8.1).

`createScratchPools().poolA` gains `acquireSized(slot, desc)`: a slot that keeps one render target
per distinct description resident instead of reallocating on every change, so a sheet that builds
its field at two framings per `add()` (the reserve-sized front at `source()`, the bucket-sized one
at `build()`) finds both waiting. Residency stays inside `poolABytes` through least-recently-used
eviction across the size-keyed slots; exclusive slots (`acquire`, `holdArtwork`) are never
evicted. The pool owns the framebuffer with the texture for these slots, which is why
`TextureFactory` — the half of a `GlContext` a pool needs — widens from `Pick<GlContext,
'texture'>` to `Pick<GlContext, 'texture' | 'target'>`. Every real supplier is a `GlContext` and
unaffected; a hand-rolled factory must now provide `target` as well. Pool B's staging is keyed by
sprite but sized by the source: a different sprite of the same source size re-keys the one
resident texture instead of re-creating it, and Pool B stays one source-sized slot.

`paperSheet()` uses them: its JFA coord targets are sized once and run in a sub-viewport, its
fields are size-keyed, `source()` no longer blurs a loose field nothing reads, and the jump-flood
shaders select texels with `texelFetch`. A warm `stage.add` of a 1024² artwork allocates three
textures and two framebuffers (the front, the hull mask and one transient source copy) where it
allocated eighteen and sixteen; every field is byte-identical.
