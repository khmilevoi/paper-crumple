---
'@paper-crumple/core': minor
'@paper-crumple/paper': patch
'@paper-crumple/motion': minor
---

**One `getError` per allocation batch, read after the ingest's yield** (the `/unstable` GL seam,
spec §7.3, §8.1, §10.8; the ingest lane, §8.10).

`GlContext` gains three additive members. `allocations(fn)` runs `fn` with allocation checks
deferred: `texture()` and `target()` inside it read no status of their own — no `getError` after
`texStorage2D`, no `checkFramebufferStatus` — and are recorded as unchecked. `checkAllocations()`
settles them with one read of the sticky error flag, drained until clear: a flag only an
allocation could have raised (`OUT_OF_MEMORY`, `INVALID_FRAMEBUFFER_OPERATION`, a lost context)
fails the batch, **releases every allocation of it** and is returned as the `GlError`, so an
out-of-memory is never missed and nothing without storage is ever drawn with; any other flag is
returned as a number for the caller's own purpose. On a shared (injected) context the flag is the
consumer's too: a raw `gl.getError()` of theirs between a batch and its settle consumes the
`OUT_OF_MEMORY` an allocation of the batch raised — that read is then the consumer's to act on,
and the batch is proven — so a consumer sharing the context reads the flag after the settle, not
between. `alive(t)` says whether the context still holds
a texture, which is how the scratch pools drop a resident the context released behind their back
(a dead artwork ends its residency, so `build()` expires and the core re-sources). Outside a batch
`texture()` checks itself as before, and its read settles what a batch left unchecked.

**`TextureFactory` — the `Pick` of `GlContext` that `createScratchPools` takes — now includes
`alive`.** A minimal `{ texture, target }` factory of your own no longer typechecks against it; add
an `alive(t)` that answers whether your factory still holds `t` (the real context is the usual
factory and needs nothing). `@paper-crumple/motion`'s `createSheetMesh` takes an optional third
argument, `read`, through which the library's own mesh reads the flag via `checkAllocations()`;
without it the mesh reads `gl.getError()` itself, as before.

`paperSheet().source()` and `build()` run their allocations as batches. `source()` settles in the
readback's completion read — after the fence poll, in the same round trip that decides the CPU
fallback — and the stale-error drain that preceded `readPixels` is gone; `build()` settles once at
its end, before the front leaves the slot. The implementation read format is asked once per field
format and remembered. One behaviour changes under memory exhaustion, deliberately: a fatal flag
read while the sprite's allocations are still unchecked — a refused pack-buffer `bufferData`
included — now fails the `add()` with the batch's `GlError` and releases the sprite's residents,
where it used to fall to the 120 ms CPU field; with memory gone, the conservative answer is the
right one. A warm `stage.add` reads `getError` twice where it read five times, and the
first synchronous call after a burst of thirty `swapTo` starts is no longer queued behind that
burst's GPU work: on ANGLE D3D11 the 250–310 ms `getError` stalls in `burst-url` /
`burst-bitmap` are gone (longest task 21 / 12 ms). Fields, hulls, rects and fronts are
byte-identical.
