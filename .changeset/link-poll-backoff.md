---
'@paper-crumple/core': patch
---

**The deferred link's readiness poll backs off instead of spinning a core** (spec §5.2's
amendment).

With `KHR_parallel_shader_compile`, `GlContext.program()` returns before the link is done and
`Program.ready()` polls `COMPLETION_STATUS_KHR` for the outcome. It polled once per undelayed
`nextTurn()`, so the whole link ran with one core asking the driver whether it had finished — and
the link is the point: a cold `PAPER_FS` on an Intel Iris Xe (ANGLE/D3D11) takes ~3 s, which is
roughly 200 000 of those turns (206 448 measured on a 1.3 s link), spent on the first load, alongside the decode and the first hull
the page actually needs. It now takes eight fast turns — enough that a link already complete, or
completing within a few turns of the issue, is answered with no added latency and no timer at all
— and every turn after them with a 1 ms delay (`nextTurn({ delay })`, which is `setTimeout`).

A driver that never reports completion is no longer an endless poll. After 60 s of wall clock —
sized above the 51.9 s pre-diet `PAPER_FS` link, the slowest link measured here that actually
completed, so nothing a driver is genuinely working on is abandoned — or an absolute million
turns, whichever comes first, `ready()` resolves to a `GlError` reading
`<label>: program did not link: the driver did not report completion within 60000 ms` and deletes
the program exactly as a failed link does. It is an error value, never a rejection, and it reaches
the caller where every other link failure does: the first `source()` / `load()`, and so the first
`add()` / `prepare()` promise. `LINK_STATUS` is not read on that path — that read is the
main-thread block the deferral exists to avoid, and on a hung driver it would never return.

Observable timing: a link that outlives eight turns is noticed one timer clamp (~1–4 ms) after it
completes rather than within a turn. Nothing changes for a driver without the extension, whose
link is checked inside `program()` as before, or for a link already complete at the first poll.
