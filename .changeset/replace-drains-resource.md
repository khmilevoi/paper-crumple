---
'@paper-crumple/core': patch
---

**`stage.replace()` drains the re-source of its key before it releases anything.**

A re-source in flight (spec 8.5's "artwork slot taken by another sprite" row, reached by
`prepare()` or a front-class `set()` after the key's front was evicted) owns `record.handle`, and
its liveness test is the record's identity — which `replace()` never changes. So `replace()`
released the old handle, awaited its own ingest, and overwrote whatever the re-source had
installed in the meantime: the re-source's handle and its front texture were never released. The
key's live-handle count never reached zero, the sheet never busted the hull entry that release
exists to bust, and a later `add(key, aDifferentImage)` was served the previous image's hull.

`replace()` now waits for the stored, never-rejecting `resourcing` promise first — the same one
`prepare()` already waits on (spec 8.5.1) — re-checking disposal, the caller's signal and the
record's liveness after each wait. It costs close to nothing: the ingest lane (spec 8.10) runs one
job at a time, so `replace()`'s own `source()` would have queued behind that re-source anyway.
