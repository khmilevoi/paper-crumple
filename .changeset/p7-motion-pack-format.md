---
'@paper-crumple/motion': minor
---

CRMP v1 on the CPU: the 32-byte header and the UV / index / frame block layout, `parsePack` with
the hand-rolled cross-field validation a schema library cannot express, `frameLayout`,
`packOffsets`, `frameBytes`, `decodeFrame`, `setKeyFrames`, the float16 and oct-normal codecs, the
three aspect buckets with `pickBucket` and `fitSheet`, and `loadPack`.

The parser trusts nothing it can derive: `indexOffset` and `frameBase` are recomputed from the
counts and a header that disagrees is a `PackError`, as is a `binBytes` that is not the real file
size, a frame offset that does not point where the header implies, and a `keyFrames` entry naming
a frame that was not stored. Unknown manifest keys are tolerated, so `sim` and anything a later
revision adds stay forward-compatible.

Two things the spike got wrong and this does not. `keyFrames` are **simulation** indices, resolved
to stored slots through `frames.findIndex((f) => f.index === k)` — indexing `frames[44]` gives
`undefined`. And `loadPack` takes an explicit `binUrl` instead of resolving `manifest.bin` against
the manifest's own URL, which 404s the moment a bundler content-hashes the JSON.
