---
'@paper-crumple/paper': minor
---

Add the GPU half of the sheet renderer: the jump-flood SDF and its looseness blur ported onto
core's `GlContext`, `PAPER_FS` and `PaperRenderer` ported whole, the 37 knob descriptors with
`edgeMode` as a factory option, the four baked grayscale tiles on the `@paper-crumple/paper/tiles`
subpath, and `paperSheet()` as a complete `SheetRenderer` — `mount`, `source` returning `ABORTED`
at three check points, `build` rendering directly into the front texture it returns,
`releaseFront`, `release` and `dispose`.
