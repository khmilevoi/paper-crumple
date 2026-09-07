# `@paper-crumple/react` v1 — what the playground migration found

The playground migration is the acceptance test the React binding's spec §10 asks for. This is its
output: every behaviour the playground needed that the package could not express. Per §10 each one
is a defect in that spec, to be answered there — this document answers nothing.

## 1. `present: 'direct'` lost its only interactive demonstration — HEADLINE

**What the playground needed.** A hero on a `pc.DirectStage`: the stage's own canvas, one rect per
view, selected by a `Segmented` control, round-tripped through the URL fragment, and mounted by
`mountHero`'s own `stage.resize(side, side)` + `stage.view({ rect })` path.

**What the package offers.** Nothing. `SceneOptions.create` returns `Promise<BlitStage | …>` and
`useCrumple` builds its view from a canvas element handed to `value.ref`; there is no `rect` option
and no `DirectStage` overload. §11 defers `DirectStage` and `HostedStage` outright.

**What was done.** The mode was deleted from the playground on an operator ruling (option C of the
P4 analysis). `BuiltStage` (`examples/playground/src/config.ts:79-89`) stopped being a discriminated
union and became a plain interface, and the URL codec (`examples/playground/src/state.ts:111-112`)
now drops a stale `present=direct` rather than rejecting it, so old links still open at the default.

**Where it belongs.** §11 — and honestly: a shipped core capability now has **no interactive
demonstration at all**, and it lost it because the React binding cannot show it. It is not untested
(`packages/core/src/stage.test-d.ts:18-23` exercises both the `'blit'` and `'direct'` arms); it is
undemoed. §10 should record that the acceptance test was made to pass by removing a demo capability,
which is a weaker pass than it reads as. Saved URLs also changed meaning.

**A correction to the analysis.** `edge-grid.ts` was described as untouched. Its behaviour is; its
text is not — it wrote `present: 'blit'` into a `DemoConfig` literal and narrowed on
`built.present`, and both had to go with the field. `examples/playground/src/edge-grid.ts` now has
no `present` reference left at all.

## 2. The front bake is no longer timeable

**What the playground needed.** `addMs` — the duration of `stage.add`, which is where the hull
polygon is built — in the diagnostics footer's `hull` tile, and `mountMs - addMs` in `pass a / b`.

**What the package offers.** Nothing. `useCrumple` owns the `add` inside `acquire` and reports no
timing; `onStart` fires on the run, after the sprite is resident. `mountMs` was recovered with two
effects and a ref (`examples/playground/src/ui/App.tsx:576-586`, `readyAtRef`): one effect notes
when the scene enters `'ready'` and clears the previous reading, the other stamps `mountMs` the
first time `crumple.shown` is non-null. `addMs` has no seam left, and the `hull` tile now prints an
em dash (`examples/playground/src/ui/App.tsx:625-636`: `'the front bake — no longer separately
timeable: the binding owns add()'`).

**Where it belongs.** §5.3 / §5.5. Either the snapshot carries a timing, or the spec records that a
consumer instrumenting acquisition must do its own `stage.add` through `scene.stage` — and lose the
shared in-flight registry by doing so.

## 3. A knob write cannot be refused synchronously

**What the playground needed.** `setKnob(key, value): Error | undefined`. The panel wrote the stage
directly and could refuse the value in the same tick.

**What the package offers.** A declarative `knobs` object. The write happens in the scene's effect
after the commit, and a refusal arrives at `SceneOptions.onError` with `observed: true`. The
playground's three `onSet` prop types (`examples/playground/src/ui/EdgeSection.tsx:72`,
`ui/LookSection.tsx:44`, `ui/LibrarySections.tsx:95`) were narrowed to `(key, value) => void`; every
call site already ignored the return, so nothing broke — but nothing *could* have used it.

**Where it belongs.** §4.3.

## 4. Omitting a key does not reset it

**What the playground needed.** "Reset every knob to its default."

**What the package offers.** `usePaperScene` writes only the keys **present** in the `knobs` object.
A key removed from it is never written back, because the binding does not know its default. The
playground therefore writes every default explicitly (`defaultKnobValues`,
`examples/playground/src/scene.ts:36-41`).

**Where it belongs.** §4.3, which says what a *changed* key does and is silent on a removed one.
Two consumers will read that silence two different ways.

## 5. Every knob write pays for a re-source join, not only a geometry one

**What the playground needed.** `useStage` joined `stage.prepare` and re-framed only for knobs whose
descriptor `movesGeometry` — a hull-tier write. A front-tier write left the handle, and so the
framing, exactly where it was.

**What the package offers.** `knobEpoch` bumps once per batch that wrote anything, and every crumple
watching it joins `stage.prepare(spriteKey)` and calls `view.refresh()`. `movesGeometry` was deleted
from `knobs.ts` because there is nowhere left to consult it — confirmed absent from the file as it
now stands. `prepare` on an unexpired front is cheap, but it is one extra microtask and one extra
redraw per knob write — and a knob drag is one write per frame.

**Where it belongs.** §4.3. The invalidation tier is public on the descriptor; the binding could
read it.

## 6. `refresh()` is the only re-read, and it forces a redraw

**What the playground needed.** After `view.draw(n)` — draw-only, documented as emitting nothing —
the pose readout must update. The playground's own store had `notifyPose()`, a pure re-read.

**What the package offers.** `crumple.refresh()`, which calls `view.refresh()` *and* bumps the
store. There is no way to ask the instance to re-read its snapshot without also asking it to redraw.
The playground's `draw` callback (`examples/playground/src/ui/App.tsx:266-278`) calls `view.draw(next)`
and then `refresh()` unconditionally, "one draw more than this needs," per its own comment.

**Where it belongs.** §5.5, which is explicit that events are a supplementary source and the store
is the source — and then offers no consumer-facing way to version it.

## 7. `shown` is a key, not a sprite

**What the playground needed.** `sprite.rect` and `sprite.frontSize`, for the `texture` and
`bucket / stretch` tiles.

**What the package offers.** `CrumpleSnapshot.shown: string | null`, the key. The sprite is reachable
only as `crumple.view?.sprite ?? null` (`examples/playground/src/ui/App.tsx:131`), read at render
time off the raw `View` — outside the snapshot, so nothing guarantees it is in step with the bumped
fields beside it.

**Where it belongs.** §5.5.

## 8. A reduced-motion swap settles with no event

**What the playground needed.** To close the audio sequence and clear the fold direction when a swap
settles.

**What the package offers.** `onEnd` on the animated path, and **nothing** on the reduced-motion one
— `show()` is the whole degraded swap: one draw, no run, no start/step/end triple. USAGE §7 says to
branch on `shown` instead, and the playground now carries a `swappingRef` plus a settle-backstop
`useEffect` on `crumple.shown` purely as a backstop (`examples/playground/src/ui/App.tsx:111`,
`:157-169`). A consumer who reads only §5.3 will not write that effect, and their audio will hang.

**Where it belongs.** §5.3 and §7.1 — the audio guarantee is stated for the synchronous `swapTo`
call and never restated for the path where that call does not happen.

## 9. The declarative swap returns no handle

**What the playground needed.** The `Run<SwapResult>` — to `stop()` from the transport, and to read
its settled result.

**What the package offers.** `crumple.play` returns a `Run`; the swap, started by `startSwap`
(`examples/playground/src/ui/App.tsx:442-451`) off a `shown` change (`spriteKey` / `src` in
`useHero`), returns nothing. Supersession by the hook's internal sequence number is strictly better
than the playground's own `AbortController` and is not the complaint: the *result* is reachable only
as three snapshot fields (`shown`, `requested`, `error`) that a consumer must correlate itself, plus
an `onEnd` that finding 8 shows does not always fire.

**Where it belongs.** §5.3.

## 10. A dropped file needs a synthetic key, and its blob URL can never be revoked

**What the playground needed.** To swap to a dropped PNG and then `URL.revokeObjectURL(url)` once
the sprite held its own decoded texture.

**What the package offers.** A mandatory `spriteKey`, and a pair guard that keeps
`Map<spriteKey, src>` for the life of the component and compares by identity. Two files named
`photo.png` must get distinct synthetic keys (`droppedSample`, `examples/playground/src/hero.ts:56-58`,
keyed by a `dropSeq` counter), and the blob URL must stay alive: a scene rebuild re-acquires the key
from the same `src` (§5.2), which would read a revoked URL. The playground now leaks one blob URL
per drop, on an operator-accepted trade-off documented inline
(`examples/playground/src/ui/App.tsx:436-441`).

**Where it belongs.** §5.3's pair guard, which is right about the defect it prevents and says
nothing about the source's lifetime.

## 11. Behaviour changed: picking a source no longer rebuilds the stage

Not a gap — a consequence, recorded because a reader of the demo will notice it. `useStage` rebuilt
the whole stage for a different sample, because `mountHero` mounted it. `create` does not read the
sample, and §4.1 says to put in `deps` only what `create` reads, so the sample left `deps`
(`examples/playground/src/scene.ts:53-56`: `deps: [config]`) and a source pick became a swap. The
two states `sample` and `shown` collapsed into one `shown` (`examples/playground/src/ui/App.tsx:88`).
This is almost certainly the better behaviour; it is still a change nobody asked for, forced by the
`deps` rule.

A second-order consequence surfaced during the rewire: `SourceSection`'s "sample" `<select>` is bound
to `librarySample.id`, a *second*, reintroduced state (`examples/playground/src/ui/App.tsx:91`,
`nextLibrarySample`, `:62`), because binding the picker to the collapsed `shown`/`crumple.shown` value
desyncs it the moment `shown` becomes a dropped file's or the broken sample's id — the picker has no
`<option>` for either. The collapse in `deps` bought a swap instead of a rebuild; it also cost back a
second piece of state to keep the picker showing only library entries.

## 12. `frameArtwork(...).image` is not exposed — the layout slot is reimplemented

**What the playground needed.** The artwork's own rectangle, to size the `.stage-frame` layout slot
that the paper hangs off out of flow, so no edge knob can move the picture on screen.

**What the package offers.** `Crumple.frameStyle` is exactly `frameArtwork(frame, frameTo).canvas`
plus `.offset` — the paper box, not the artwork box. `frameArtwork(...).image` never reaches the
binding's surface. The playground reimplements the same scale arithmetic as `heroSlotStyle`
(`examples/playground/src/hero.ts:42-46`), duplicating the `frameTo / max(artwork.w, artwork.h)`
multiplication `frameStyleFor` already does internally, and separately replicates the package's own
"no build yet → no override" convention (`packages/react/src/frame-style.ts:16`) by returning `null`
from the hero's own `slotStyle` when `built === null`, to avoid a real 0px × 0px box reaching the DOM
during a rebuild.

**Where it belongs.** §5.1 / §6, next to the existing note that `frameStyleFor` produces the canvas
box and not the image box.

## 13. No run telemetry beyond the reactive snapshot — a step interval has to be read off the raw view

**What the playground needed.** The `draw / step` diagnostics tile's step interval: the wall-clock
gap between two scheduled `step` events of the current run.

**What the package offers.** `Crumple` surfaces no interval, and no `step` count. The playground
subscribes directly to the raw `view.on('start', …)` / `view.on('step', …)`
(`examples/playground/src/ui/App.tsx:253-256`), exposed for exactly this kind of unforeseen read
per its own comment — which is also the seam the spec explicitly leaves open (`view: pc.View | null`
in `CrumpleSnapshot`) rather than closing.

**Where it belongs.** §5.5, alongside finding 2 and finding 7: three separate tiles all fall back to
the raw `view` because the snapshot does not carry timing, sprite geometry, or run cadence.

## 14. `crumple.play` returns a bare `null` with no reason

**What the playground needed.** To distinguish "no view yet" (nothing to do) from "the run was
refused" before committing to audio that has already started.

**What the package offers.** `play(from, to, o?): pc.Run<pc.PlayResult> | null`, `null` in both
cases alike. The playground's `runFold` (`examples/playground/src/ui/App.tsx:293-330`) has to guard
on `view === null` *before* calling `audio.beginSequence(...)`, reproducing the pre-migration guard's
placement, precisely because a `null` from `play(...)` itself arrives too late — after audio already
started — to distinguish "not ready" from "refused," and the fallback branch on a `null` result has
to unwind the already-begun audio through the shared `endSwap()` rather than a bare `setDirection(null)`.

**Where it belongs.** §5.1, next to the existing note that `play` "must stay a plain function" —
the same synchronicity constraint that makes the `null` sentinel hard to use safely.

## 15. `Scene` carries no build metadata — the playground keeps a `BuiltStage` sidecar

**What the playground needed.** The slot objects (`sheet.knobs`, `motion.packs()`,
`motion.setPoses`), the build timing, and `artworkCssPx` — everything the knob panel and the
diagnostics footer read about *how* the stage was built.

**What the package offers.** `SceneOptions.create` hands the binding a `pc.BlitStage` and nothing
else; `Scene` carries only `stage`, `status`, `error`, `warnings`, `lost`, `generation` and
`knobEpoch`. The playground's own `BuiltStage` interface
(`examples/playground/src/config.ts:79-89`: `stage`, `sheet`, `motion`, `buildMs`, `artworkCssPx`)
is kept in state on the way past `create`, inside `examples/playground/src/scene.ts`'s `useDemoScene`,
guarded by a `signal.aborted` check so a superseded build cannot clobber the winner's sidecar.

**Where it belongs.** §4.1. `create` is the consumer's own closure, so this may be working as
designed rather than a gap — but every non-trivial consumer of a scene ends up writing the same
sidecar, which is worth recording even if the answer is "that is intentional."

## 16. Fresh snapshot objects per render force every dependency array to name individual fields

**What the playground needed.** Ordinary `useCallback` / `useMemo` / `useEffect` dependency arrays
over the scene and the crumple.

**What the package offers.** §2.1 states this is deliberate: `Scene` and `Crumple` are fresh objects
per render by construction, so depending on the object itself re-runs on every render. The cost of
that design decision lands directly on every call site: `App.tsx`'s dependency arrays name
`scene.stop`, `crumple.pose`, `crumple.shown`, `crumple.view`, `crumple.play` and `crumple.refresh`
individually rather than `scene` or `crumple` (for example `examples/playground/src/ui/App.tsx:377`),
and one of those individual members (`scene.stop`, a called member expression) still trips
`react-hooks/exhaustive-deps` because the installed analyzer does not narrow it the way it narrows a
plain property read, requiring a targeted suppression (`App.tsx:371-377`).

**Where it belongs.** §2.1, which already states the rule and its reason. Worth recording next to it
that a real consumer pays the granularity back out in every dependency array it writes, and that the
cost is not always absorbed cleanly by the tooling meant to check it.

## 17. `onError` delivers already-observed errors; every consumer filters locally

**What the playground needed.** A single error channel that does not double-report a failure already
reachable as a return value.

**What the package offers.** `SceneOptions.onError` / `CrumpleOptions.onError` fire for every error,
including ones carrying `observed: true` — an error that is or will be surfaced through a different
return value. §7's orphan-channel rule explains what `observed` means but the binding does not filter
on it before calling the consumer's handler, so both playground call sites
(`examples/playground/src/scene.ts:85-92`, `examples/playground/src/hero.ts:91-98`) independently
guard with `if (!e.observed)` — the same one-line filter, written twice, because there is no shared
place to write it once.

**Where it belongs.** §7, next to the existing statement that "telemetry filters on `!observed`" —
that filtering is left to the consumer rather than done once by the binding.

## 18. Ordinary status-pill bookkeeping over the hooks' snapshots trips `react-hooks/set-state-in-effect`

**A correction carried into this finding.** `eslint-plugin-react-hooks@7.1.1`'s `recommended` config
sets `exhaustive-deps` to `warn`, not `error` — confirmed by inspecting the installed package's
`configs.recommended.rules`. What is at error level is `react-hooks/set-state-in-effect` (and
`react-hooks/refs`), and it is `set-state-in-effect` that actually bit this migration, not
`exhaustive-deps`.

**What the playground needed.** Ordinary UI state (a status pill, a `mountMs` reading, a swap-settle
flag) synchronized off the scene's and the crumple's changing snapshots — the exact "synchronize with
an external system" shape `useEffect` exists for.

**What the package offers.** `usePaperScene` and `useCrumple` correctly avoid this pattern internally
by using `useSyncExternalStore` over a versioned store, but expose no equivalent primitive to a
*consumer* who wants the same kind of derived, externally-triggered state. `App.tsx` is the first
file in this migration to do that kind of bookkeeping, and six of its effects call a setState setter
synchronously in an effect body — the boot effect's `onObserved` call, the two swap-settle/error
effects, the scene-status-failed effect, the pose-schedule effect's `applyPoses(...)` call, and the
`mountMs` reset effect (`examples/playground/src/ui/App.tsx:137,168,181,194,386,582`) — each with a
targeted `// eslint-disable-next-line react-hooks/set-state-in-effect` and a one-line justification,
because there is no pure-render alternative for any of them.

**Where it belongs.** §5.5. Either the binding offers a small `useSyncExternalStore`-backed
status-store primitive a consumer can build on instead of raw effects, or the spec records the six
suppressions as the accepted cost of the current shape.

## What the package expressed with no friction at all

Recorded so the findings above are read in proportion. `stage.stop({ all: true })` →
`scene.stop({ all: true })`. `stage.warnings` → `scene.warnings`. Context loss → `scene.lost`, which
also fails the scene. The knob-geometry re-source join that was `settleFrame` — the single hardest
thing in `useStage` — is `knobEpoch` plus the crumple's own `prepare`, and the playground writes
none of it. The knob carry-forward across a rebuild is the declarative `knobs` diff. `frameStyleFor`
is `frameArtwork(...).canvas` and `.offset` to the digit. And the idle prefetch through
`scene.stage.add`, which §12's defect 11 predicted would collide with a mounting `Crumple`, does not:
`acquire` retries a live-key refusal through `prepare` and joins the winner.
