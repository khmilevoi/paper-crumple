---
'@paper-crumple/core': minor
---

The scheduler, the event bus and the `Run` object. `on` / `once` returning an unsubscribe closure
with §7.1's ordering guarantees — `start` emitted synchronously before the first microtask, always
followed by `step { pose: from }`, exactly one `end` per `start`, teardown to `idle` before `end`,
supersession emitting `end` before `start`, and a single-slot re-entrancy box that makes unbounded
synchronous recursion structurally impossible. `Run<R = PlayResult>`, a thenable that is not a
promise, so refactoring `crumpleTo` to `async` is a type error rather than a silent iOS audio
break. `DWELL_MS` and the dwell arithmetic of §7.2 — N poses and N−1 gaps, the absolute-deadline
stepper with its one-dwell deficit cap, the eleven-render swap with a ball hold that is never
rescaled. And §4.4's scope rule with the `stage.play` report, and §4.5's state table with
`refresh()` and `draw(pose)` as first-class rows.
