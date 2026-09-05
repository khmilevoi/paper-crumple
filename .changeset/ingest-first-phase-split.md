---
'@paper-crumple/paper': patch
---

**The ingest's first phase is two tasks, not one** (spec §8.10's "upload and field", §10.5, §8.1).

`source()` now takes one platform turn (`nextTurn()`) between the artwork upload/resample and the
field passes it used to issue behind them in the same task. On the reference GPU (ANGLE D3D11,
Iris Xe) that task measured ~10 ms per sprite during a thirty-view swap storm — the 4 MB upload
plus the resample draw plus the JFA passes — and it was the last thing holding the burst rows'
main-thread task p95 at 9.6–10.4 ms against the 10 ms budget the smoothness bench enforces. The
GL calls, their arguments and their order per sprite are unchanged, so every field, hull, rect and
front is byte-identical; only where the task boundary falls has changed.

The turn brings a new abort check point with it (§10.5): a signal that fires between the two
phases returns `ABORTED` before a single field pass is issued, keeping the artwork already paid
for — and a `dispose()` there answers the same `SheetError` the call's other yields answer. The
turn is unconditional, so an ingest's turn count is a property of the code rather than of the
artwork cache.

Because a yield now falls between the artwork slot and the passes that read it, the far side of
the split re-derives the scratch pools and re-takes the artwork slot when another **direct**
`source()` on the same sheet took it in the gap (§8.1 gives Pool A one artwork slot). Through the
stage this cannot arise — §8.10's ingest lane holds one sprite between `source()` and `build()` —
so on the library's own path the check is two comparisons and nothing is retaken.

Cost: one additional platform turn per ingest (`scheduler.postTask`, sub-millisecond on the bench
and CI machines), paid once per `add()`/`swapTo()`.
