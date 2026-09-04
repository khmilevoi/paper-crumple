---
'@paper-crumple/core': minor
'@paper-crumple/paper': minor
---

**The first-load freeze is gone: the paper shader compiles in seconds, and its link no longer
blocks the page** (P7 of the performance programme; spec 5.2 amendment).

On ANGLE's Direct3D 11 backend — every Chromium on Windows — the HLSL compile of `PAPER_FS` took
42–48 s cold (64–72 s under load) inside `gl.getProgramParameter(LINK_STATUS)` during
`paperStage()`'s `sheet.mount`, with the main thread frozen throughout; a warm shader cache hid it
until the next shader change. Two changes, each on its own sufficient to remove the freeze:

- **`PAPER_FS` compiles out what the front build cannot reach.** Every program `@paper-crumple/paper`
  links serves `renderFront`, which fixes `uFoldCount = 0`, `uShadow = 0`, `uCrumpleFill = 0` and
  `uDebug = 0`; the fold loops, flap shadow, crumple mosaic, ball compaction, the drop shadow's fold
  cut and ball term, and the debug views are now behind `#if !PAPER_FRONT_BUILD` (the text is kept
  whole; `#define PAPER_FRONT_BUILD 0` is the whole program, which the identity test links to
  compare against). Cold link on an Intel Iris Xe: 51.9 s → 3.6 s. Every front is byte-identical
  to the whole program's, proven on SwiftShader and on D3D11 (`paper-shader-early-out.gl.test.ts`).
- **The link is deferred where the driver allows it.** With `KHR_parallel_shader_compile`,
  `GlContext.program()` issues the compile and link and returns without reading `LINK_STATUS`;
  the outcome is the new `Program.ready()` (`/unstable`), polled through `COMPLETION_STATUS_KHR`
  once per `nextTurn()` (also new on `/unstable`: the platform yield — `scheduler.postTask`, then
  `MessageChannel`, then `setTimeout(0)`). `paperSheet`'s `source()` awaits it at its start, so
  `build()` always finds a linked program. Without the extension the link is checked inside
  `program()` as before.

**Behaviour change (the ruling written into spec 5.2):** on a driver with the extension, a paper
shader that fails to compile or link is no longer a synchronous error of `paperStage()` /
`sheet.mount()`; it is the error value of the first `source()` — and so of the first `add()` /
`prepare()` promise — emitted with `observed: true` (spec 10.6). `mount()` still returns
synchronously every error it can detect without waiting for the driver. A `/unstable` consumer
driving `PaperRenderer` (`ready()` added), `Resampler` (`ready()`) or `SdfBuilder` (`ready()`)
directly should await them before the first draw, or accept that the first draw blocks on the link
exactly as `mount()` used to.
