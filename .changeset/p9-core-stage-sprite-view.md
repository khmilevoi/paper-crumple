---
'@paper-crumple/core': minor
---

Add the stage, the sprite registry and the views (§4).

`paperStage()` is async and yields a stage whose invariants hold, an Error, or `ABORTED`; there is
no `ready()` and no observable un-mounted stage. The surface mode is three named interfaces and
three overloads — `BlitStage`, `DirectStage`, `HostedStage` — rather than one generic `Stage<P>`,
because methods in TypeScript are bivariant and inference from an options bag collapses. `present`
therefore has no default and must be written, and `resize()` is absent from `HostedStage` rather
than present and always failing.

Sprites take a `SpriteSource` and a live key is refused rather than silently rebuilt; `replace()`
is the supported re-point and invalidates the hull entry through the sheet slot. Views expose
`pose`, `state`, `sprite`, `run`, `tag` and `idealSize`, redraw through `refresh()` and
`draw(pose)`, and return a `Run` from `play`, `crumpleTo` and `swapTo` so that `start` stays
synchronous. `stage.mount` and `view.swapTo` compose the common path; a batch `mountAll` was
designed and rejected because its return type cannot be honest.

The blit destination gains a managed backing store and is cleared before every `drawImage`, which
fixes a visible bug: without it a swap from a wide sprite to a narrow one under `fit: 'contain'`
left the previous sprite's edges on the tile. Every error the library returns or raises is emitted
on `error` carrying `observed`, so telemetry can filter `!observed` and stop double-reporting
handled errors, and context loss gets its own `lost` channel plus a synchronous `stage.lost`.
