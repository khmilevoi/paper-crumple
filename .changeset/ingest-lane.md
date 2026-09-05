---
'@paper-crumple/core': patch
---

**Every asynchronous sprite path runs through one stage-wide ingest lane (spec 8.10).**

`add()`, `replace()`, `prepare()`'s re-source and the eviction re-load row are now jobs of one
prioritised, cancellable lane that holds at most one sprite between the sheet's `source()` and
`build()` — the one artwork slot and one tight-field slot of Pool A (spec 8.1) are single-occupancy,
and two ingests interleaved at a microtask checkpoint clobbered each other's field and displaced
each other's artwork. Thirty `add(bitmap)` calls in one loop through `Promise.all` used to resolve
twenty-nine of them to a `SheetError` and hand the survivor its neighbour's hull rect; they now all
succeed, sequentially, with the rects a one-at-a-time run gives.

Timing changes a consumer can observe:

- Jobs are ordered by class — the target a live `crumpleTo` is parked on first, then a sprite a
  shown view needs (`mount()`, `replace()` and the re-source of a shown key, `prepare()`'s wait),
  then background `add()`s — FIFO within a class; a background job queued for a second is promoted
  so a stream cannot starve it.
- Between an ingest's phases the stage yields to the platform scheduler once a turn has spent 4 ms
  inside the lane (`scheduler.postTask` at `user-visible` priority, a `MessageChannel` message where
  that is absent), so a burst of adds no longer runs as one long task.
- A `swapTo` that is superseded, stopped or disposed aborts the `add()` it started; that add
  resolves `ABORTED`, its key is freed, and the superseded run still settles `ABORTED` after the
  new run's `start`, as before.
- `stage.dispose()` settles every queued add `ABORTED` and closes the bitmaps it owned exactly once.

Nothing synchronous changes: `show()`, `set()`, `draw()`, `refresh()`, `resize()` and the rebuild
drain keep their contracts. `nextTurn()` is appended to `@paper-crumple/core/unstable` for a slot
that polls a GPU fence once per turn.
