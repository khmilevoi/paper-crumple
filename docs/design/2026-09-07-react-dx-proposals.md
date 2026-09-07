# `@paper-crumple/react` v1 — DX and API proposals

This is the answer to `2026-09-06-react-binding-findings.md`. That document listed, per spec §10,
every behaviour the playground needed that the package could not express, and deliberately
proposed nothing. This one re-reads the playground against the **current** tree (2026-09-07),
confirms which findings still hold, adds what the migration document missed, and proposes a
concrete shape for each — a signature, its semantics, and the playground code it would delete.

Three constraints shaped every proposal:

- **Nothing above the packages.** A convenience facade and an unscoped bundle package were both
  rejected on 2026-08-30. Every proposal here lives inside `@paper-crumple/react`, or is a named
  one-line amendment to `@paper-crumple/core` where the binding is genuinely blocked by core.
- **Spec §11 (Deferred) is respected, not ignored.** Where a proposal touches a deferred item it
  says so; nothing here is the deferred `crumple.swap()` action or the deferred store primitive.
- **The playground is the only consumer**, so "what it deletes" is measured there. Line numbers
  are from the current tree and will drift.

Priorities: **high** removes a trap or a block of consumer code; **medium** removes a workaround;
**low** is a documentation change or a nicety. Section 8 gives a suggested order.

---

## 0. Three places where the code and the spec disagree

These are bugs, not friction. They come first because every "document it" answer below assumes
the documented behaviour is what the code does.

### 0.1 `crumple.shown` moves at the ball, not at the end of the swap

Core `adopt` runs `attachRecord(next)` at the ball, between the descent's first two renders
(`packages/core/src/stage.ts:1379-1383`). The binding reads `shown` as `view?.sprite?.key`
(`packages/react/src/crumple-state.ts:46`) and bumps its store on every `step`
(`packages/react/src/use-crumple.ts:110-112`). So the first descent step publishes
`shown === target` while the run is still descending.

Neither spec §5.1 nor USAGE-react §6/§7 says this; USAGE §7 tells the reader to branch on `shown`
to detect a settled reduced-motion swap. The playground does exactly that
(`examples/playground/src/ui/App.tsx:190-198`), so on **every animated swap** its backstop calls
`endSwap()` at the ball — audio ended, `busy` false, status pill "swapped to …" — and `onEnd`
calls it a second time at the real end.

Answered by §2.1 (`pending` / `onSettle`); until then the spec must state when `shown` moves.

### 0.2 `parked` latches for the whole descent

`onRunStep` sets `parked = true` when `pose === via` and has no clearing branch
(`crumple-state.ts:70`); only `start` and `end` clear it (`:62`, `:76`). Spec §5.5 ("not *only* by
the next step") and USAGE §5 (branch a spinner on `parked`) both assume the next step clears it.
The documented spinner pattern is wrong today.

Fix in the binding, zero consumer change: `core.parked = e.pose === core.via` on every step after
the first park, or clear on any step whose pose is not `via`.

### 0.3 Declarative knob refusals are dropped by the filter §7 prescribes

A refused declarative knob write is dispatched with `observed: true`
(`use-paper-scene.ts:236-239`). §7 defines `observed` as "is, or will be, a return value someone
can narrow", and tells consumers to filter it — which the playground does (`scene.ts:90`). But the
only "someone" who could narrow the refusal is the hook, and it discards it. A refused slider
value is a silent no-op, while `ui/EdgeSection.tsx:69-71` promises the reader that refusals
"arrive through the scene's `onError`", and `edge-ceilings.ts:49-51` relies on this path as the
backstop under `'percent'`.

Answered by §3.3.

---

## 1. Status of the 2026-09-06 findings

Every finding re-checked against the current tree. All still hold; #10 is half a doc gap.

| # | Finding | Holds | Answer |
|---|---------|-------|--------|
| 1 | `present: 'direct'` undemoed | yes | §11 deferred; out of scope here |
| 2 | Front bake not timeable | yes | document (§2.10); optional `shownAt` |
| 3 | Knob write cannot be refused synchronously | yes | document (§3.7); `scene.stage.set` is the sync path |
| 4 | Omitting a key does not reset it | yes | **core-blocked** — §3.4 |
| 5 | Every knob write joins a re-source | yes | §11 deferred, core-blocked — §3.7 |
| 6 | `refresh()` is the only re-read | yes | §2.2 `draw()` / `sync()` |
| 7 | `shown` is a key, not a sprite | yes | §2.4 `sprite` |
| 8 | Reduced-motion swap settles with no event | yes | §2.1 `onSettle` |
| 9 | Declarative swap returns no handle | yes, half-answered by core `view.run` | §2.1 `pending.run` |
| 10 | Synthetic key + unrevokable blob URL | key half yes; URL half is a **doc gap** | §2.9 pass the `File` as `src` |
| 11 | Source pick no longer rebuilds | behaviour change, as designed | none |
| 12 | Artwork box not exposed | yes | §2.3 `artworkStyle` |
| 13 | No run cadence in the snapshot | yes | document (§2.10) |
| 14 | `play()` returns bare `null` | yes; USAGE contradicts the spec | document (§6.3) |
| 15 | `Scene` carries no build metadata | yes | §3.2 `Scene<M>` |
| 16 | Fresh snapshot objects per bump | yes, as designed | document (§3.7); `pending` collapses four deps |
| 17 | `onError` delivers observed errors | yes | document (§3.7); but see 0.3 |
| 18 | Status bookkeeping trips `set-state-in-effect` | yes | §3.1 lifecycle callbacks |
| 19 | No consumer-side test double | yes | §5.1 `/testing` subpath |
| 20 | Same-key swap is a silent no-op | yes | document (§6.3); plus §2.6 `retry()` |

---

## 2. The crumple — `useCrumple` and `<Crumple>`

### 2.1 `pending` and `onSettle` — the swap as a request (high; answers #8, #9, fixes 0.1)

The snapshot has no notion of "a request in flight". The reduced-motion acquire window is
invisible to `state`, `shown` moves mid-fold (0.1), and a settled swap on the reduced path emits
nothing (#8). Around that gap the playground carries `direction` (`App.tsx:133`), `swapDuration`
(`:136`), `swappingRef` (`:139, :192, :206, :488`), `endSwap` (`:145-148`), the backstop effect
(`:190-198`) and `busy` (`:523`) — about thirty lines and three `set-state-in-effect`
suppressions.

```ts
interface CrumpleSnapshot {
  /** The request for the current (view, spriteKey) until it settles; null when idle. */
  readonly pending:
    | { readonly key: string; readonly phase: 'acquiring'; readonly run: null }              // entrance, reduced swap, joined add
    | { readonly key: string; readonly phase: 'entering';  readonly run: Run<PlayResult> }   // uncrumple
    | { readonly key: string; readonly phase: 'swapping';  readonly run: Run<SwapResult> }   // swapTo / crumpleTo
    | null
}

interface CrumpleOptions<S> {
  /** Exactly once per request that reaches an outcome — animated end, degraded show, rollback.
   *  Never for a superseded or unmounted request. */
  onSettle?: (e: { key: string; error: Error | null; reduced: boolean }) => void
}
```

Semantics. `pending` is set in `syncSprite` (`use-crumple.ts:263-273`) and cleared at the three
sites that already bump at settlement (`:171-173`, `:207`, `:226-238`). `run` is the typed handle
#9 asks for, with `stop()` on it; core's untyped `view.run` (documented in core USAGE, mentioned by
neither the React spec nor the findings) is what it wraps. `onSettle` is `useEvent`-wrapped like
`onEnd`.

What it deletes. `busy` becomes `crumple.pending !== null || crumple.state === 'playing'`;
`onEnd: endSwap` becomes `onSettle: endSwap`; `swappingRef` and the backstop go; the four
individual-field dependencies at `App.tsx:198, 358, 492, 545` collapse to `pending`.
`swapDuration` state stays — only a `swap()` action would remove it, and that is deferred.

Tradeoff. One more field in a snapshot the spec says is "not everything". It is the one field that
makes `requested`, `shown` and `error` safe to read together. It is **not** the deferred
`crumple.swap()`: the trigger stays the prop, so §11's race hazard does not arise.

### 2.2 `draw(pose)` and `sync()` (high; answers #6)

`refresh()` is the only re-read and it forces a redraw (`use-crumple.ts:434-437`); the
playground's `draw` (`App.tsx:296-308`) reaches for `crumple.view`, draws, then calls `refresh()`
— "one draw more than this needs".

```ts
interface CrumpleMethods {
  draw(pose: PoseRef): void   // view.draw(pose), then bump; no-op while detached
  sync(): void                // bump only — the re-read §11 already names
}
```

Removes `App.tsx:302-307` and the `view === null` guard at `:298`; the transport and keyboard
call sites stop touching the raw view. `sync()` is the generic escape for any other raw-view call
(`view.set`, `view.once`). Every scrubbing consumer needs `draw`.

### 2.3 `artworkStyle` (medium-high; answers #12)

`frameStyle` sizes the wrapper to the paper box and offsets it (`frame-style.ts:70-84`); the
artwork's own rectangle — what a layout reserves — is not produced, so `hero.ts:42-46` and
`:112-118` re-derive it through `framing.ts`.

```ts
readonly artworkStyle: { readonly width: string; readonly height: string } | null   // same scale, same null convention as frameStyle
```

Deletes `heroSlotStyle`, `SlotStyle`, the `built === null` guard and the `framing.ts` import
from `hero.ts` (~20 LOC); `Stage.tsx` reads `hero.artworkStyle ?? undefined`. A pure
`frameArtwork(frame, frameTo)` export is the lesser alternative — it would not be in step with
`frameStyle`'s bump.

### 2.4 `sprite` in the snapshot (medium; answers #7)

`App.tsx:159` reads `crumple.view?.sprite` at render, off the raw view. Add
`readonly sprite: Sprite | null`, read in the same `readCrumple` pass as `shown`. Keep `shown` —
the string discriminant is what `=== null` and the chip want. Beyond one line saved, it closes a
real skew: after `adopt` at the ball `view.sprite` is already the target while the last snapshot's
`shown` still names the previous one.

### 2.5 A derived `status` discriminant (medium)

`App.tsx:66-98`, `:595-604` and USAGE §6 each derive the same thing by hand from three fields.

```ts
readonly status: 'detached' | 'empty' | 'acquiring' | 'shown' | 'playing' | 'swapping' | 'rolled-back'
```

Computed in `readCrumple`, no new state: `'rolled-back'` is `error !== null && requested !== shown`;
the in-flight values come from `pending`. `sampleId` becomes
`status === 'rolled-back' ? crumple.shown : crumple.requested`. Overlaps `state`; worth it because
`state` cannot express the acquire window or the rollback outcome after `end`.

### 2.6 `retry()` (medium)

`synced` is written before the swap (`use-crumple.ts:263`) and never reset on failure
(`:234-237`), so re-requesting a rolled-back key is refused at `:261` forever — `App.tsx:85-88`
says so. Declaratively the only escape is key-away-and-back, which plays a full fold to a sprite
already shown.

```ts
retry(): void   // re-run syncSprite for the current options, bypassing the synced check
```

Alternative: reset `synced` on `report` and document the away-and-back. Prefer `retry`.

### 2.7 Derive `frameStyle`, do not mirror `frameTo` (low-medium)

`core.frameTo` is mirrored in an effect (`use-crumple.ts:292-299`), so `frameStyle` lags a
`frameTo` change by one commit; `hero.ts:112-114` works around the resulting stale frame. Replace
with `useMemo(() => frameStyleFor(snapshot.frame, frameTo), [snapshot.frame, frameTo])` — one
effect and one eslint suppression fewer in the package, no consumer change.

The same lag is the mechanism behind the blurry first entrance measured in §9.1: the one blit the
entrance performs lands while `frameStyle` is still `null`. The memo alone does not fix that — the
frame is only known once a front is shown — so §9.1's "one `refresh()` after the frame commits" is
needed as well; do them together.

### 2.8 `tag` and `fit` look reactive and are not (low-medium)

`hero.ts:105` passes `tag: o.shown.id`; both are fixed at `stage.view()` (`crumple-types.ts`), so
after the first swap `view.tag` names the wrong sample. Recreating the view on change is too heavy
(it replays the entrance). Proposal: a dev-only `console.warn`, once, when `fit` or `tag` differ
from the created view's, plus one sentence in USAGE §4.

### 2.9 Pass the `File` as `src` (high, doc only; answers the URL half of #10)

`SpriteSource` accepts `Blob` (`packages/core/src/source.ts:53`) and a `Blob` is reclaimable across
eviction and rebuild (`:22`). A dropped `File` **is** a `Blob`. Passing it directly removes
`createObjectURL`, the never-revoked URL and its comment (`App.tsx:512-516`), and `droppedSample`'s
`url` parameter (`hero.ts:56-58`); `Sample.url: string` (`samples.ts:10`) widens to
`src: SpriteSource`. The `dropped-N` key stays — a key names a picture, and two `photo.png`s are
two pictures. USAGE §6 should say this in one sentence.

### 2.10 Document, do not change

- **#2, front bake timing.** The binding owns `add` only on the entrance and reduced paths; on the
  animated swap it is inside `swapTo` by design (spec §5.3, the abort gate). Any `acquired.ms`
  would be present on some paths and `null` on others. If a timing is wanted, the honest one is a
  landing stamp — `readonly shownAt: number | null`, `performance.now()` at the bump that made
  `shown` current — paired with `Scene.readyAt`; it deletes `App.tsx:625-629`. Low.
- **#13, run cadence.** A `step` field would not remove the playground's effect (the interval
  needs the previous value, so the ref stays). `view.on` is stable per view and is the right seam;
  say so in USAGE §5 next to "Imperative access".
- **#20, same-key no-op.** Spec §5.3 is right that a "declined" signal is a fifth observer. The
  doc sentence: "compare against `crumple.requested`, never `crumple.shown`". See 2.6 for why the
  comparison key also makes a failed key unretryable.
- **`<Crumple>` props.** `value` is the right name for a single-instance prop; `position: relative`
  is spread before `style` (overridable — `Stage.tsx` relies on it) and `frameStyle` after (not
  overridable), which is the precedence §6 wants and USAGE §11 states. Nothing to do.
- **Core docblock.** `packages/core/src/runner.ts:50` calls `duration` "one multiplier";
  `dwell.ts:202` and `crumple-types.ts:51-56` say milliseconds. The binding is right; fix core's
  comment. `swapDurationFor` (`hero.ts:64-68`) exists only to keep `0` out.

---

## 3. The scene — `usePaperScene` and `<PaperScene>`

### 3.1 `onReady` and `onFailed` (high; answers #18)

The hook knows every transition the consumer re-derives from `status` and `generation` in
effects that each need a `set-state-in-effect` suppression.

```ts
interface SceneOptions<M> {
  onReady?: (build: SceneBuild<M>, info: { generation: number; signal: AbortSignal }) => void
  onFailed?: (error: Error, info: { lost: boolean; generation: number }) => void
}
```

Semantics. `onReady` fires once per landed build, synchronously after the `ready` bump
(`use-paper-scene.ts:189-194`) and before React re-renders; `info.signal` is the effect's own
controller (`:99`), already aborted on rebuild and unmount, so work started here is cancelled
without returning a cleanup. `onFailed` fires on a create `Error` or throw (`:131-136`,
`:164-168`) and on loss (`:175-184`). Both `useEvent`-wrapped.

What it deletes in `App.tsx`: the failed-pill effect (`215-229`), the pose re-apply effect
(`410-418`), the prefetch effect (`548-562`, its own `AbortController` → `info.signal`), the
`readyAt`/`mountMs` effect (`617-624`), and three of the four uses of `scene.generation` — about
45 lines and five suppressions (`:222`, `:414`, `:417`, `:561`, `:622`).

Tradeoff. A second channel beside the snapshot; §5.5's "the store is the source" stays true
because both fire from the same bump sites. Deliberately narrower than the deferred store
primitive.

### 3.2 `Scene<M>` — a generic slot for build metadata (high; answers #15)

`SceneOptions.create` hands the binding a `BlitStage` and nothing else, so the playground keeps
a `BuiltStage` sidecar in state with an abort guard (`scene.ts:63-83`, `config.ts:79-89`).

```ts
interface SceneBuild<M> { readonly stage: BlitStage; readonly meta: M }

interface SceneOptions<M = undefined> {
  create: (signal: AbortSignal, onError: StageErrorListener)
    => Promise<SceneBuild<M> | BlitStage | Error | Aborted>   // a bare stage ⇒ M = undefined
  deps: readonly unknown[]
  knobs?: Knobs
  onError?: StageErrorListener
}

interface SceneSnapshot<M = undefined> { /* … */ readonly meta: M | null }   // non-null exactly when ready

function usePaperScene<M = undefined>(o: SceneOptions<M>): Scene<M>
```

Semantics. `meta` lives in `core` beside `stage`, cleared with it on rebuild, failure and loss
(`readScene`: `meta: failed ? null : core.meta`). The abort race the sidecar guards against is
already handled at `use-paper-scene.ts:151-156`, so the guard moves in for free. §4.1's objection
— "no type this package declares" — is answered: the package still declares none; the consumer's
type flows through, one copy.

What it deletes: the `create` adapter and `built` state (`scene.ts:63-83`), the bundling
`useMemo` (`:108-111`), `hero.ts`'s `built` prop (→ `scene.meta`), and the `generation`
dependency at `App.tsx:365-370` (meta identity moves per build). Ripple: `useScene<M>()`,
`PaperSceneProps<M>`; `useCrumple` takes `Scene<unknown>` (it reads only
`stage/status/generation/knobEpoch`, `use-crumple.ts:301, 402`).

### 3.3 Make knob refusals visible (high; fixes 0.3)

Two parts, both small:

- Dispatch a refused declarative write with `observed: false` — one line at
  `use-paper-scene.ts:236-239`; the test at `use-paper-scene-knobs.test.tsx:70-88` flips with it.
- `onKnobRefused?: (key: string, value: KnobValue, error: Error) => void` on `SceneOptions`,
  because a `StageEvent` cannot carry the key.

Removes no consumer code; makes one invisible failure visible.

### 3.4 Reset through `stage.defaults` — a one-line core amendment (medium; answers #4)

The hook writes only the keys **present** in `knobs` (`use-paper-scene.ts:225-241`) because it
cannot know a default: `stage.knobs` is `readonly KnobDescriptor[]` with slot-local keys and no
path (`packages/core/src/stage.ts:113`). The registry already holds a frozen, namespaced
`defaults(): KnobValues` (`knob-registry.ts:44-48`, `:176-183`); the stage literal at
`stage.ts:2270-2274` does not pass it through.

Core amendment: `readonly defaults: Readonly<Record<string, KnobValue>>` on `Stage`.

Hook semantics: a key present in `applied.values` but absent from `knobs` is written back to
`stage.defaults[key]` (silently skipped if undeclared), counted in that batch's `knobEpoch` bump;
carry-forward semantics unchanged. Deletes `defaultKnobValues` (`scene.ts:29-41`) and
`resetKnobs`'s `built` dependency (reset becomes `setKnobs({})`); the URL filter at
`App.tsx:753-760` compares against `scene.stage.defaults` instead of walking descriptors.

### 3.5 A positional overload that `exhaustive-deps` can check (medium)

`scene.ts:66-83` wraps `create` in `useCallback([build, config])` and then writes
`deps: [config]` — the same list twice, neither checked against what `create` reads
(`config.ts:94-125` reads eight `config` fields). The trap §4.1 warns about is a missed dep.

```ts
function usePaperScene<M>(create: CreateStage<M>, deps: readonly unknown[], options?: Omit<SceneOptions<M>, 'create' | 'deps'>): Scene<M>
```

Mirrors `useMemo`, so `react-hooks/exhaustive-deps` with `additionalHooks: '(usePaperScene)'`
verifies it. Keep the options bag as canonical; the overload is the lintable form. Tradeoff: two
shapes to document.

### 3.6 `<PaperScene>` / `useScene` have no real consumer (medium, demo and doc)

`App.tsx:774` wraps the tree in the provider; `hero.ts:103` passes `scene` explicitly; `useScene`
is called nowhere under `examples/playground/src`. The context path — including the frozen
`NO_PROVIDER` failed scene (`scene-context.ts:23-37`) — has unit tests only. The documented main
path (USAGE §3, the grid) has zero real coverage while the "escape hatch" is the working path.
Either drop the explicit `scene` option in `hero.ts` or drop the provider; today's shape asserts
nothing. With 3.2, `useScene<M>()` needs the parameter or a `Scene<unknown>` default.

### 3.7 Document, do not change

- **#3, synchronous refusal.** `scene.stage.set` is the sync escape hatch §4.3 already names. An
  imperative `scene.set(key, value): Error | undefined` on the handle would give the sync answer
  and skip one render per drag frame, but it is a second writer racing the declarative diff — the
  hazard §11 gives for `swap`. Not now.
- **#5, every write joins.** Explicitly deferred in §11 and also core-blocked:
  `registry.invalidationOf(delta)` (`knob-registry.ts:49-50`) is not on the stage. If measured to
  matter: `stage.invalidationOf(patch): Invalidates | undefined`, and the hook bumps `knobEpoch`
  only when the batch's strongest tier is ≥ `'front'` (a draw-tier `set()` already redraws
  synchronously, `stage.ts:912-914`).
- **#16, identity per bump.** The lint gap is specific to *called member expressions*;
  `const { stop } = scene` at the top and `[stop]` in deps satisfies the analyzer with no
  suppression (kills `App.tsx:399-404`). A stable `scene.actions` sub-object would be a second
  API for two methods.
- **#17, `observed` filtering.** Document — and document the larger fact: `create` and `onError`
  are `useEvent`-wrapped (`use-paper-scene.ts:76-81`), so the consumer's `useCallback` around them
  (`scene.ts:66-83`, `:85-92`, `hero.ts:91-98`) is ceremony; inline arrows shrink ~14 LOC.
- **Duplicate core gate.** The hook gates (`use-paper-scene.ts:112-121`) and `main.tsx:17` gates
  again for a pre-React message. Say the hook already does it.
- **Per-drag render cost.** `setKnobs` → render → effect `stage.set` → `knobEpoch` bump → render →
  crumple join/refresh → bump → render: two to three renders per drag frame, inherent to the
  declarative shape. Measure before acting.

---

## 4. Types and package shape

### 4.1 A discriminated `SceneSnapshot` (high)

The "non-null exactly when" invariants live in comments (`scene-types.ts:39-43`), not the type.
`packages/react/README.md:46` writes `scene.error.message` after `status === 'failed'` — `TS18047`
under `strict`; the playground had to write `scene.error?.message ?? 'unknown'` (`App.tsx:227`).
`index.test-d.ts:26-30` tests only `stage !== null` narrowing, never `status`.

```ts
type SceneSnapshot<M> = SceneCounters /* warnings, lost, generation, knobEpoch */ & (
  | { readonly status: 'building'; readonly stage: null;      readonly meta: null;     readonly error: null }
  | { readonly status: 'ready';    readonly stage: BlitStage; readonly meta: M;        readonly error: null }
  | { readonly status: 'failed';   readonly stage: null;      readonly meta: null;     readonly error: Error })

type Scene<M> = SceneSnapshot<M> & SceneMethods
```

Removes every `?.` and `!` at a status branch. `Scene` becomes a type alias (no declaration
merging needed); `scene-types.test-d.ts:32-38`'s `keyof` test still holds; the `readyScene` /
`buildingScene` literals already conform.

### 4.2 `KnobValue` collides with core; one type has three spellings (medium; free before 1.0)

The binding exports `KnobValue = string | number | boolean` (`scene-types.ts:12`, `index.ts:22`).
Core exports a **generic** `KnobValue<D>` of the same name (`knob-types.ts:14`, `core/index.ts:86`)
and also `Knobs = Readonly<Record<string, string | number | boolean>>` (`knobs.ts:110`,
`core/index.ts:68`) — which *is* `SceneOptions['knobs']`. The playground redeclares it a third time
as `KnobValues` (`knobs.ts:4`) while importing the binding's `KnobValue` beside `pc`
(`scene.ts:2, 4`).

Proposal: `knobs?: Knobs` from core; rename the binding's export to `KnobPrimitive` or drop it
(`Knobs[string]`). A statically typed knob map (`KnobsOf<typeof descriptors>`, `knob-types.ts:25`)
is not worth a generic `usePaperScene<K>`: the binding cannot name the slots by design
(README:113-116), and the panel is descriptor-driven at runtime with a `binds`-dependent key
spelling (`knobs.ts:11-13`) no static type captures. `Record<string, …>` is the honest type.

### 4.3 Name the binding's own callback types (low-medium)

To satisfy binding signatures the playground spells `pc.StageEvent<'error'>` five times
(`scene.ts:15, 69, 86`; `hero.ts:92`; `config.ts:98`), `pc.Aborted` five times, `pc.BlitStage`,
`pc.PoseRef` and `pc.ViewFrame`. Re-exporting core types from the binding is **not** proposed:
core is a mandatory peer, and a second import path for one type is the re-export shape the
maintainer rejected. `PoseRef`, `ViewFrame` and `ABORTED` are core vocabulary used against core
objects anyway.

Instead, name what is the binding's own:

```ts
export type CreateStage<M = undefined> = SceneOptions<M>['create']
export type StageErrorListener = (e: StageEvent<'error'>) => void   // used by SceneOptions.onError and CrumpleOptions.onError
```

`scene.ts:66-71`'s explicit annotations become contextual (`useCallback<CreateStage>(async
(signal, onError) => …)`); `pc.Aborted` and `pc.StageEvent` leave consumer code except where the
consumer builds its own unions (`config.ts:100`).

### 4.4 No narrowing helper (decision)

Against binding results the playground narrows three times, all on `crumple.play`
(`App.tsx:342, 351, 352`), plus the `?.` at `:227` that 4.1 removes. Core already exports
`isAborted`; USAGE calls the raw `Run` "the honest price of a real handle". The union is the
point. No action.

### 4.5 Package manifest (low)

`exports` / `files` / ESM-only / types-first are fine; `react-dom` is correctly absent from peers
(only `src/testing/render.ts` needs it). `README.md:104`'s peer block omits the optional
`typescript` peer that `package.json:36-45` declares; USAGE `:60-70` shows the true manifest —
align the README.

---

## 5. Testing

### 5.1 Ship `@paper-crumple/react/testing` (high; answers #19)

`index.ts:12-15` withholds `src/testing/`; `index.test.ts:8-14` pins that the *root* entry never
exports it (a subpath keeps that green). Spec §11 already names `src/testing/` as the first
internal to publish. The cost of not shipping it, in the playground: a production DI seam
(`scene.ts:11-17, 58-61`), a hand-written cast five-method `BlitStage` (`scene.test.tsx:12-29`,
whose own comment calls it "a second, worse copy of the package's own"), zero tests for `useHero`
(`hero.ts:89-119`), and the 13-field detached-`Crumple` literal duplicated verbatim in
`crumple.test.tsx:11-27` and `Stage.test.tsx:11-27`.

Package shape: `exports["./testing"]: { types: ./dist/testing.d.ts, default: ./dist/testing.js }`
and a tsdown entry `testing: 'src/testing/index.ts'` — the same pattern as core's `./unstable`
(`packages/core/package.json:35-38`, `tsdown.config.ts:6`).

```ts
export function createFakeStage(o?: FakeStageOptions): FakeStageHandle
export type { FakeStageHandle, FakeViewHandle, FakeStageOptions, FakeCall }
export function readyScene(stage: BlitStage, o?: { generation?: number; knobEpoch?: number }): Scene
export function buildingScene(): Scene
export function failedScene(error: Error, o?: { lost?: boolean }): Scene          // new
export function detachedCrumple(over?: Partial<Crumple>): Crumple                  // new; replaces both literals
export function deferred<T>(): Deferred<T>
```

Keep `render` / `renderHook` / `renderCrumple` internal: `render.ts:2` imports `react-dom/client`,
which is not a peer, and `render.ts:9` sets a global at module load under `sideEffects: false`.
Consumers have Testing Library:

```tsx
// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react'
import { createFakeStage, readyScene } from '@paper-crumple/react/testing'

test('useHero swaps when the sample changes', async () => {
  const fake = createFakeStage({ sprites: ['a'] })
  const scene = readyScene(fake.stage)
  const { rerender } = renderHook(({ shown }) => useHero({ scene, shown, /* … */ }), { initialProps: { shown: A } })
  rerender({ shown: B })
  await act(async () => { fake.views[0]?.settleRun(undefined) })
  expect(fake.calls.filter((c) => c.method === 'view.swapTo')).toHaveLength(1)
})
```

Fit to ship now: `fake-stage.ts` (a full `BlitStage` against the real types, with its own suite,
throws nothing), `deferred.ts`, the two scene literals (`crumple-probe.tsx:11-36`). Needs
hardening first: `createFakeStage` calls `document.createElement('canvas')` (`fake-stage.ts:397`)
so it requires a DOM environment — document it; `EMPTY_USAGE` is a `{}` cast (`:110`) — return a
zeroed real shape; `view.run` is always `null` (`:169`) and `settleRun` settles only the latest run
(`:147-155`) — document both.

Tradeoff: §11 says publishing freezes the shape. Mitigate by documenting the subpath as "adds
fields within a major, never removes".

### 5.2 What the playground cannot test today (medium)

`App.tsx` exports `nextLibrarySample` (`:62`) and `isNoOpSwap` (`:90`) from a component module
purely so `App.test.ts` can reach them; `useDemoScene`'s third `build` parameter exists only for
tests. Hook-driven logic with no test reach: the swap arm/disarm and reduced-motion backstop
(`App.tsx:183-199`), the rollback and failed-scene pills (`:202-229`), the raw `view.on` interval
(`:272-292`), pose re-apply on `generation` (`:410-418`), mount timing (`:616-629`), reset
(`:763-767`), and all of `useHero`. With 5.1, `useHero` is testable as above and the transport
logic can move into a `useTransport` hook tested the same way.

The playground also has no `test` script and no vitest dependency
(`examples/playground/package.json:7-12`); its tests run only because the root `unit` project
sweeps `**/*.test.tsx` (`vitest.config.ts:24`) with the `@vitest-environment jsdom` docblock.

### 5.3 A Testing section in USAGE (medium; high once 5.1 lands)

USAGE-react §14 admits the gap. Add "§15 Testing": the jsdom docblock; `IS_REACT_ACT_ENVIRONMENT`
(Testing Library sets it; bare-`act` users must, `render.ts:5-9`); `matchMedia` is guarded
(`use-crumple.ts:39`) so no stub is needed unless testing `reduce`
(`use-crumple-swap.test.tsx:16-21`); call-log assertions as in `use-crumple-swap.test.tsx:29-33`.

---

## 6. Documentation

### 6.1 The README's only example is broken (high)

`packages/react/README.md`: the install line (`:18`) omits `@paper-crumple/paper` and `/motion`,
which lines 22-25 import; line 46 does not compile (`scene.error.message` — 4.1); lines 44-70
never touch `useCrumple` or `<Crumple>` — they drive a raw view through `scene.stage!.add`
(`:59`), the exact code the package exists to replace. The README is checked by nothing, unlike
USAGE (compiled against the types, USAGE `:9-13`). Replace the example with USAGE §3's grid
(`:389-447`) or §6's hero (`:665-684`).

### 6.2 Patterns the playground needed that USAGE does not show (medium)

- **Reset knobs.** §9 (`:947-950`) says "write the defaults out explicitly" with no code; the
  playground wrote `defaultKnobValues` over `stage.knobs` descriptors (`scene.ts:36-41`) and
  needed the undocumented `binds` keying rule — bare key for a shared knob, `ns.key` otherwise
  (`knobs.ts:7-13`). Add a six-line snippet and the rule to §9 (moot after 3.4).
- **Keeping `sheet` / `motion` handles from inside `create`** — the sidecar with the
  `signal.aborted` guard before the write (`scene.ts:43-52, 66-82`). Add to §2 (moot after 3.2).
- **When a swap is over, for a transport UI.** `onEnd` for the animated path plus an effect on
  `crumple.shown` for the reduced path (`App.tsx:183-199`), gated by the same-key check §6
  states in prose only. Add a recipe to §6/§7 (replaced by `onSettle` after 2.1).
- **Ready → first-sprite timing** (`App.tsx:610-629`): one sentence in §5 that the binding
  reports no timing.
- **Testing** — 5.3.

### 6.3 Statements that are wrong or contradict the spec (high)

- **`play()` and `null`.** Spec §5.1 gives the rule (check `view` *before* the call); USAGE §5
  (`:637-643`) branches on `run !== null` *after* the call — the too-late pattern the spec warns
  about. Fix the example.
- **When `shown` moves.** Nowhere; see 0.1. Until 2.1, §5.5 and USAGE §7 must say that on an
  animated swap `shown` becomes the target at the ball.
- **`parked`.** USAGE §5's spinner pattern assumes the code does what 0.2 says it does not.
- **The same-key rule.** "Compare against `crumple.requested`, never `crumple.shown`" — the trap
  `App.tsx:66-98` spends twenty-five lines of comment on.
- **`tag` / `fit` are fixed at view creation** — one sentence in §4.

### 6.4 Documented but exercised by no consumer (low)

Not dead weight, but unverified — say so in USAGE's status paragraph: `useScene()` (never called;
the provider wraps but `scene` is passed explicitly), `scene.play` broadcast (§3; the playground
uses only `scene.stop`), `entrance: 'uncrumple'` (§8), `onStart` (the playground subscribes to
`view.on('start' | 'step')` raw instead), `reducedMotion: 'off'`, `canvasProps` and the `children`
placeholder, `pin` / `ImageBitmap`, SSR (§13).

### 6.5 Playground README (low)

No testing section, and the package has no `test` script. Two lines: tests run from the root
`pnpm test`; `scene.test.tsx` injects the build seam.

---

## 7. Playground-side follow-ups

Not the binding's to fix, but the playground is the reference consumer and should not model
workarounds the binding no longer needs:

- Pass the dropped `File` as `src` (2.9) — a live leak today.
- Decide whether `<PaperScene>` or the explicit `scene` option is the demonstrated path (3.6).
- `initialKnobs` with a lazy `useState` in `useDemoScene` removes the boot-seed effect and its
  suppression (`App.tsx:161-168`; `scene.ts:64` starts knobs at `{}`).
- Add a `test` script and a vitest dev dependency, or document that the root project sweeps it.
- Once 5.1 lands: delete the `build` DI seam from `scene.ts`, test `useHero`, move the transport
  logic into a `useTransport` hook.

---

## 8. Suggested order

1. **Fix what the browser found (§9)**: the blurry, stretched first entrance (binding, §9.1) and
   the permanently-`null` pack that leaves the status pill on "booting…" and the pose editor dead
   (playground, §9.2). Both are regressions against `075dc4e`, both are small.
2. **Fix the three disagreements (§0)**: `parked` clear (one line), knob refusals `observed: false`
   (one line), and state in the spec when `shown` moves — before any documentation work builds on
   the current text.
2. **`pending` + `onSettle` (2.1)** and **`onReady` / `onFailed` (3.1)** — the two changes that
   remove the most consumer code and the most `set-state-in-effect` suppressions.
3. **`Scene<M>` (3.2)** with the **discriminated snapshot (4.1)** — one type change, done together.
4. **`draw()` / `sync()` (2.2)**, **`artworkStyle` (2.3)**, **`sprite` (2.4)**.
5. **`/testing` subpath (5.1)**, then the playground follow-ups that depend on it (§7).
6. **Core amendment for `stage.defaults` (3.4)** and the hook's write-back semantics.
7. **`status` (2.5)**, **`retry()` (2.6)**, **`frameStyle` memo (2.7)**, **`KnobValue` rename and
   `Knobs` (4.2)**, **named callback types (4.3)**, **positional overload (3.5)**.
8. **Docs**: README example (6.1), the wrong statements (6.3), the missing recipes (6.2), USAGE
   §15 Testing (5.3), the unexercised list (6.4).
9. Deferred and measure-first: #5 / `invalidationOf`, per-drag render cost, `shownAt`.

---

## 9. What the browser found — the migrated playground, tested live (2026-09-07)

A QA pass of the running playground (`http://localhost:5180/`, Chrome, `devicePixelRatio = 1.5`)
through the Claude in Chrome extension. The console was clean on every scenario — no errors, no
React warnings, no WebGL messages — so none of the three problems below announces itself.
Screenshots are in the session scratchpad (`01-first-load-blurry.jpg` …
`05-reload-fragment-roundtrip-blurry.jpg`) and are not committed.

### 9.1 CRITICAL — the first entrance is blurry and vertically stretched, and never corrects itself

**Repro.** Load `/` with an empty fragment and wait. The artwork stays soft and taller than it
should be until *something else* forces a redraw — a knob write, a swap. A stage rebuild (edge
shape/finish) replays the entrance and reproduces the defect; so does a hard reload with a URL
fragment.

**Measured.**

| moment | `canvas.width × height` (attrs) | `getBoundingClientRect()` | backing / CSS per axis | expected |
|---|---|---|---|---|
| first load | **300 × 150** (the HTML default) | 361.3 × 341.3 | **0.830 / 0.440** | 1.5 / 1.5 |
| after `edgeShape=torn` rebuild | **300 × 150** | 404.0 × 379.3 | 0.743 / 0.395 | 1.5 / 1.5 |
| hard reload with fragment | **300 × 150** | 438.7 × 410.7 | 0.684 / 0.365 | 1.5 / 1.5 |
| after any redraw (a knob write) | 542 × 512 | 361.3 × 341.3 | **1.500 / 1.500** | 1.5 / 1.5 |

The two axes' ratios differ by 1.89× — that is the stretch; the 0.68–0.83 horizontal factor is the
blur. After one redraw the same element is sharp and noticeably wider.

**Mechanism, instrumented.** With `canvas.width`/`height` setters and `getBoundingClientRect`
wrapped on the live element, a forced rebuild logged `{ w: [], h: [], rects: [[0, 0]] }`: the
entrance performs **exactly one** blit, and at that instant the canvas measures **0 × 0**.
`managedBackingStore` (`packages/core/src/blit.ts:102`) deliberately returns `null` for a zero
CSS box — a zero-sized store is a destroyed store — so `packages/core/src/stage.ts:1069-1070`
never writes the attributes. Nothing draws again, so the browser stretches the default 300 × 150
store into the CSS box that arrives on the next commit.

It measures 0 × 0 because `frameStyle` is `null` on that render: `core.frameTo` is mirrored in an
effect (`packages/react/src/use-crumple.ts:292-299`), `frameStyleFor` returns `null` without a
frame (`frame-style.ts:15`), the `<Crumple>` wrapper is `position: absolute` with no width or
height — shrink-to-fit zero — and the canvas is `width/height: 100%` of it.

**Regression, and the deleted code names it.** The end of `mountHero` in
`075dc4e:examples/playground/src/stage.ts:191`:

```ts
// `show()` drew into the element at whatever box it had — the frame only exists once a front
// is shown — so the box is set from that frame now, and one event-free redraw lets the managed
// backing store, which is written from `getBoundingClientRect()` during a draw, catch up.
if (frameHero({ view, slot, canvas, cssPx: built.artworkCssPx })) view.refresh()
```

The migration reproduced the CSS-sizing half (`frameStyleFor` + `heroSlotStyle`) and dropped the
`view.refresh()` half.

**Fix — in the binding.** Any consumer passing `frameTo` hits this; `hero.ts` should not carry a
workaround. After the commit that carries a newly non-null `frameStyle` — a `useLayoutEffect` keyed
on the frame and `frameTo`, not the current effect, which runs *before* React has committed the
style it just derived and would still read 0 × 0 — call `core.view?.refresh()` once. That is the
"apply the frame, then one event-free redraw" pairing `mountHero` had. Do it together with §2.7.

A second, independent layer is defensible in core: `stage.ts:1058-1073` could re-attempt the
managed sizing on the next draw when it previously skipped a zero box. But the binding is where
the contract broke.

### 9.2 HIGH — `pack` is permanently `null`: pose editor dead, step buttons disabled, status pill stuck on "booting…"

**Repro.** Load `/`. The status pill reads **"booting…" forever**, including after a completed
swap. The diagnostics footer shows `key frames —`; both pose step buttons are `disabled`. The
header chip says "6 poses" only because `poseCount` falls back to `dwells.length`
(`App.tsx:456`). **The pose count cannot be changed** (reported by the maintainer): the whole
"03 Poses" section is rendered `disabled={pack === null}` (`App.tsx:890`), and every editor path
returns before doing anything — `onCountChange` at `:435`, `commitKeyFrames` (behind
`onKeyFrameChange`, "manifest" and "even") at `:422`.

**Root cause.** `examples/playground/src/ui/App.tsx:366-370`:

```ts
const pack = useMemo(() => built?.motion.packs()[0] ?? null, [built, generation])
```

`packs()` lists **resident** packs, and the motion package pins it: "lists the resident packs in
the order they were supplied, and none before the first load" —
`packages/motion/src/source-poses.test.ts:38-40`. `built` lands when `buildStage()` resolves,
before any sprite has been added, so `packs()` is `[]`; `generation` ticks per scene rebuild,
never when a sprite lands, so the memo never re-runs.

**Regression.** Pre-migration (`075dc4e:examples/playground/src/ui/App.tsx:140-144`) it read
`live?.built.motion.packs()[0]`, where `live` was the resolved `mountHero` — strictly after
`await built.stage.add(...)`, when a pack is resident.

**Fix — playground.** Re-key on something that moves when a sprite lands; `crumple.shown` is the
signal: `[built, generation, crumple.shown]`, and the same for the `applyPoses` effect at
`App.tsx:410-418`. With §3.1 the natural home is `onReady` plus the first settle; with §2.1 it is
`onSettle`. This is also a concrete case for §3.2: the sidecar's `motion` handle is only
meaningful after residency, which `Scene<M>` cannot express either — the pack is a per-sprite
fact, not a per-build one.

### 9.3 MEDIUM — a completed swap never reports "swapped to …"

**Repro.** Load, click Swap. The swap runs and the picture changes; the pill still says
"booting…".

`App.tsx:191-198` writes `swapped to …` only `if (crumple.shown === shown.id)`. The effect fires
while `crumple.shown` still names the *previous* sprite — §0.1: `adopt` at the ball flips `shown`
mid-fold, the effect's single pass sees the stale value, consumes `swappingRef` and calls
`endSwap()` early, and skips the status write. §9.2 then guarantees the fallback text is
"booting…", so the miss is invisible.

**Fix.** Playground, cheap and correct: gate on the swap being over rather than on
`crumple.shown !== null` — `crumple.requested === crumple.shown`, the pair `isNoOpSwap` already
uses — so `endSwap()` and the status write land at the true end. Binding, the real one: §2.1's
`onSettle`.

### 9.4 Not a bug — recorded so it is not re-filed

The first synthetic mouse click after a fresh page load is swallowed, reproducibly. It is the
Chrome extension's `computer` tool (window activation), not the app: `elementFromPoint` at the
button centre returns the button, and a scripted `button.click()` on a freshly loaded page runs
the swap on the first try.

### 9.5 What worked

Fold and Unfold (readout `folding · stored frame 0 · 70 ms / step`, lands on `pose 5 / 5`); swap
via the Swap button (sprite, sample chip and both selects advance, bucket chip `1x1` → `2x3`,
result pixel-sharp); edge rebuilds Smooth ↔ Torn and Clean ↔ Paper (entrance replays, artwork
stays put); Look & debug knob writes applied live; URL fragment round-trip
(`edgeShape=torn&edgeFinish=paper&k.n.motion.aoGamma=1.25` restored exactly on hard reload).

**Not covered:** the rollback demo (broken URL target), pose count and key-frame editing (dead
under §9.2 anyway), Reset, the three stage backgrounds, keyboard transport, audio-end timing, file
drop.
