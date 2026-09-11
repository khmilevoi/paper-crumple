# `@paper-crumple/react` — design

Status: **implemented and reconciled.** The React package and P1–P6 amendments are implemented and
reconciled against source and tests; the P7 playground migration remains separately owned and is not
claimed here. Every claim about
the core's behaviour is cited to a file and line in `packages/core/src` or to a section of
`docs/superpowers/specs/2026-08-26-paper-crumple-packages-design.md` (cited as §n) and
`docs/USAGE.md`.

This spec covers two deliverables that must ship together:

1. **`@paper-crumple/react`**, the React binding deferred by §3.4.
2. **One additive amendment to `@paper-crumple/core`** — a new `SwapToOptions` interface carrying
   `key`, which `view.swapTo` takes in place of `SwapOptions` (§5.3 below). The binding cannot
   honour a caller-supplied sprite key without it.

A third, sequenced last: **`examples/playground` migrates onto the package.** The playground is
already React and already hand-writes this binding in `examples/playground/src/useStage.ts` (398
lines). If the package cannot replace that file, the package is wrong; the migration is the
acceptance test, not a follow-up.

## 1. Constraints inherited, not invented

§3.4 recorded three core decisions made *for* React and warned they would be refactored away by
someone who did not know why they were there. This spec is the document that consumes them, and
each is load-bearing here:

1. **The factory is async and a cancelled one cleans up after itself.** A `paperStage` whose
   `signal` aborts mid-flight disposes what it built and returns `ABORTED` (§4.0). This is what
   makes StrictMode safe: the losing double-invocation releases its own WebGL2 context, against a
   browser ceiling of roughly sixteen. `usePaperScene` therefore needs no cleanup hook **for the
   loser**.

   **This covers the in-flight build and nothing else.** A resolved stage never looks at the signal
   again — it is consulted only at the factory's own checkpoints (`stage.ts:277, 327, 345, 434`),
   and no `abort` listener outlives them — so a landed stage is released only by an explicit
   `dispose()`. Read as "cleanup is handled", this constraint leaks one WebGL2 context per rebuild
   against the ceiling it exists to protect. §4.1 states the whole rule: the cleanup **aborts the
   in-flight build and disposes the landed one**.
2. **`on()` returns its unsubscribe closure** (§7.1), so every subscription in this package is
   `useEffect(() => view.on(e, h), deps)` and nothing more.
3. **`dispose()` is idempotent, and `show(null)` / `remove()` on a disposed stage is a no-op**
   (§4.6). React runs cleanups child-first and a concurrent route change can invert that order, so
   a `Crumple` may outlive or predecease its `PaperScene` in either direction.

A fourth, discovered while writing this spec and worth recording next to them: the core's own
`ViewError` for a claimed canvas names React explicitly —

> "Dispose the first; React runs a cleanup before the second effect, so StrictMode does not trip
> this." — `packages/core/src/stage.ts:2333`

That sentence is a promise this package depends on. A `Crumple` whose canvas ref detaches must
dispose its view **in the ref's cleanup**, not in a later effect, or StrictMode does trip it.

## 2. The layering rule

**Hooks carry the logic and return instances. Components render DOM and take an instance.** The
dividing test, applied to every option in this spec:

> A parameter belongs to the hook if changing it means calling into `@paper-crumple/core`. It
> belongs to the component if changing it only changes what the browser paints around the canvas.

The seam is a stable callback `ref` on the instance, which is what makes both usages the same code:

```tsx
const hero = useCrumple({ spriteKey: 'hero', src, entrance: 'uncrumple' })

<canvas ref={hero.ref} className="tile" />   // drive it yourself
<Crumple value={hero} className="tile" />     // or hand it to the component
```

`fit` is the case that proves the rule is not about intuition: it looks like a CSS concern, but it
is fixed at `stage.view()` and cannot be changed afterwards, so it is a hook option and never a
prop. `tag` is fixed there too (`stage.ts:1471`, and `View.tag` is a read-only accessor,
`view.ts:88`), and under §2.1's stable `ref` the creating callback is not re-invoked — so a changed
`fit` or `tag` is ignored after view creation and warns once in development. The value remains fixed
until the view is rebuilt, typically by remounting under a different React `key`.

**`<Crumple value>` is the component's only form.** A second, options-taking form was designed and
rejected: it would state the configuration in two places, and it would give the grid an imperative
path (`ref.current`, null on first render) that behaves differently from the instance path (never
null). A grid is therefore a consumer-written child component:

```tsx
function Tile({ item }: { item: Item }) {
  const crumple = useCrumple({ spriteKey: item.id, src: item.url, tag: item.id })
  return (
    <Crumple value={crumple} className="tile" onClick={() => crumple.play('flat', 'ball')}>
      {crumple.shown === null ? <Skeleton /> : null}
    </Crumple>
  )
}
```

A `useCrumples(items)` list hook was also rejected. It would have to write its own list
reconciliation — a new key creates an instance, a departed one disposes a view — which is exactly
what React already does by mounting and unmounting `Tile`, only by hand and around React's own
mechanism. It buys one subscription, and it cannot create a view early anyway, because a view is
born when the canvas ref attaches.

### 2.1 Every function this package hands out is identity-stable

**`useEvent` is the package-wide convention**, applied without exception to instance methods
(`play`, `stop`, `refresh`, `draw`, `sync`, `retry`), to `ref`, and to every consumer callback the
binding invokes (`onStart`, `onEnd`, `onError`, `onSettle`, `onReady`, `onFailed`, `onKnobRefused`)
and to `SceneOptions.create`. The latest function is mirrored into a ref, and
what is handed out is a wrapper whose identity never changes:

```ts
function useEvent<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => { ref.current = fn })
  return useCallback((...a: A) => ref.current(...a), [])
}
```

The mirror is written in a layout effect and **never during render**: a render React discards —
concurrent, or StrictMode's second pass — must not publish its closure, and only a commit that
actually happened may.

**For `ref` this is correctness, not ergonomics.** React's own words: unless the same function
reference is passed every render, *"the callback will temporarily clean up and re-create during every
re-render"*. An unstable `crumple.ref` would therefore dispose the view and build a new one **on
every render** — `view.dispose()` followed by `stage.view()` on the element it just released,
cancelling every run in flight. It would not raise §1's claimed-canvas refusal, because the cleanup
runs first and `dispose` releases the element's claim (`stage.ts:1546`); the defect is silent churn,
which is worse than an error and is why §9 asserts the identities directly. The whole lifetime rule
in §5.2 rests on that identity holding still.

For the rest it is what keeps the layering honest. The instance is handed to `<Crumple value>` and
into consumers' dependency arrays; a method whose identity churned every render would make every one
of those arrays a lie, and would re-run the effects of a consumer who did nothing wrong.

`create` is read the same way, and the consequence is worth stating: an inline arrow is fine, and a
`create` that closes over a changed `sheet` **does not rebuild** — it is used by the next rebuild
`deps` asks for. That is §4.1's contract, not an accident of this pattern.

**The `Crumple` object itself is deliberately NOT stable.** It carries the reactive snapshot, so it is
a fresh object per render by construction. Depend on `crumple.shown` or on `crumple.play`, never on
`crumple`.

**The consumer pays that granularity back in every dependency array, and the tooling does not always
absorb it.** The playground migration is the measurement rather than the opinion:
`examples/playground/src/ui/App.tsx` names `scene.stop`, `crumple.pose`, `crumple.shown`,
`crumple.view`, `crumple.play` and `crumple.refresh` individually. For a called member such as
`scene.stop()`, destructure it first (`const { stop } = scene`) so dependency arrays remain
checkable by the installed analyser. The decision above stands: the alternative is re-running every
consumer effect on every render, which is §2.1's own catastrophe.

**`Scene` is the opposite, and must be.** It is the value of `<PaperScene value={scene}>` (§4.2) and
every `useCrumple` reads it through `useScene()`, so a fresh identity per render would re-render the
whole subtree and re-run every crumple effect that depends on it — view creation, the four
subscriptions, the `knobEpoch` join — which is §2.1's own catastrophe one level up. `Scene` is
therefore memoised and changes identity only when one of its fields does. Crumples still depend on
`scene.stage`, `scene.status`, `scene.generation` and `scene.knobEpoch` rather than on `scene`, so
that a warning arriving does not rebuild a view.

## 3. Package shape

`packages/react`, name `@paper-crumple/react`, built by `tsdown` like its siblings.

**Peer dependencies, with TypeScript optional, and no runtime dependencies at all:**

```json
"peerDependencies": {
  "@paper-crumple/core": "^1",
  "react": "^19",
  "typescript": ">=5.0"
},
"peerDependenciesMeta": { "typescript": { "optional": true } }
```

USAGE.md states the rule this obeys: *"if you are publishing a wrapper around this library, declare
core in `peerDependencies` and never in `dependencies`, because that is the one install shape that
produces two copies."* Two copies of core mean two `GlError` classes and an `instanceof` that
narrows an Error as a success value (§10.4).

**`@paper-crumple/paper` and `@paper-crumple/motion` are not imported at all**, not even as types.
The consumer writes the `paperStage(...)` call themselves inside `create` (§4.1), so `sheet` and
`motion` reach the stage without ever passing through a type this package declares. This keeps
`tools/packaging/zero-dependencies.mjs` green and keeps the binding usable with a custom sheet or
motion slot.

**React 19 only.** The range `^18.3 || ^19` was considered and rejected: the ref-callback cleanup
function is what gives a view a life exactly as long as its canvas element, and on 18 that becomes
a `useEffect` over a manually mirrored ref, plus `forwardRef`, plus a hand-rolled `useEffectEvent`
at every subscription. The cost is paid in the exact places where the lifetime bugs live.

**Version group.** `@paper-crumple/react` joins the Changesets `fixed` array alongside the other
three (`.changeset/config.json`). USAGE calls the shared version number "the only visible signal
that they are a family", and the `^1` peer on core already implies the lockstep.

**Exports:** root `.` plus the pure `./testing` subpath. The testing entry is browser-free and
contains no ReactDOM-backed helpers; those helpers remain internal. The package's ReactDOM-backed
runtime stays out of the pure testing entry.

**`assertSingleCore()` in development.** `usePaperScene` calls it once per scene under
`process.env.NODE_ENV !== 'production'`, **before `create`**, and a returned `CoreDuplicateError`
fails the scene outright: `status: 'failed'`, `error` set, `create` never called. USAGE is explicit
that this is *"a startup failure, not a once-per-session console warning"*, and failing the build is
also what keeps §4.1's invariant intact — `error` is non-null exactly when `status === 'failed'`,
with no exception carved out for this one case.

**It catches the duplicate only when the copy this package resolves lost the registration race.**
`checkSingleCore` returns `undefined` when the marker is the caller's own
(`single-core.ts:41`), and registration is a module-load side effect (`single-core.ts:53`), so if
`@paper-crumple/react`'s copy of core registered first its `assertSingleCore()` is clean with two
copies live — the *other* copy is the one that knows, and it says so through the load-time
`console.warn` (`single-core.ts:56`). So the assertion here is worth making and is not a guarantee.
The wrapper is still the right place for it, because a wrapper is precisely the install shape that
produces the duplicate; the claim to avoid is that placing it here makes the duplicate impossible to
miss.

## 4. The scene

### 4.1 `usePaperScene`

```ts
interface SceneBuild<M> {
  readonly stage: pc.BlitStage
  readonly meta: M
}

interface SceneOptions<M = undefined> {
  /** `onError` is handed DOWN so the consumer can spread it into `paperStage`'s own `onError`.
   *  See "the second parameter" below — without it the pre-mount channel does not exist. */
  create: (signal: AbortSignal, onError: StageErrorListener) =>
    Promise<SceneBuild<M> | pc.BlitStage | Error | pc.Aborted>
  deps: readonly unknown[]
  knobs?: pc.Knobs
  onError?: StageErrorListener
  onReady?: (build: SceneBuild<M>, info: { generation: number; signal: AbortSignal }) => void
  onFailed?: (error: Error, info: { lost: boolean; generation: number }) => void
  onKnobRefused?: (key: string, value: pc.Knobs[string], error: Error) => void
}

interface SceneCounters {
  readonly warnings: readonly Error[]
  readonly lost: boolean
  readonly generation: number
  readonly knobEpoch: number
}

type SceneSnapshot<M = undefined> = SceneCounters & (
  | { readonly status: 'building'; readonly stage: null; readonly meta: null; readonly error: null }
  | { readonly status: 'ready'; readonly stage: pc.BlitStage; readonly meta: M; readonly error: null }
  | { readonly status: 'failed'; readonly stage: null; readonly meta: null; readonly error: Error }
)

type Scene<M = undefined> = SceneSnapshot<M> & SceneMethods
type CreateStage<M = undefined> = SceneOptions<M>['create']
type StageErrorListener = (e: pc.StageEvent<'error'>) => void

function usePaperScene<M = undefined>(o: SceneOptions<M>): Scene<M>
function usePaperScene<M = undefined>(
  create: CreateStage<M>, deps: readonly unknown[],
  options?: Omit<SceneOptions<M>, 'create' | 'deps'>,
): Scene<M>

/* SceneMethods */
interface SceneMethods {
  play(
    from: pc.PoseRef,
    to: pc.PoseRef,
    o?: pc.StagePlayOptions,
  ): Promise<pc.StagePlayReport<pc.View>>
  stop(o?: { all?: boolean }): void
}
```

**A rebuild is decided by `deps` and by nothing else.** Structural comparison of the options bag was
rejected: `sheet` and `motion` are objects returned by factory calls, so a consumer who forgets a
`useMemo` would recreate the WebGL2 context on every render, and the failure mode is a browser
running out of contexts rather than a visible error. An explicit key is the only form where the
expensive thing happens exactly when the consumer said it should.

**`create`'s second parameter is not a convenience.** `StageOptions.onError` exists because *"a
listener attached after the factory resolves cannot observe an error raised inside it"*
(`stage.ts:281`), and it is wired before the surface exists (`stage.ts:283`). But the consumer writes
the `paperStage(...)` call, so the binding has no way to reach that option — it could only call
`stage.on('error')` after `create` resolves, which is exactly the window `onError` exists to cover.
An earlier draft claimed `SceneOptions.onError` *was* the pre-mount form; it was a behaviour with no
mechanism. Handing the listener down closes it, and it is what the reference implementation already
does (`examples/playground/src/useStage.ts` passes its handler into `buildStage`):

```tsx
create: (signal, onError) => pc.paperStage({ sheet, motion, cssPx: 192, present: 'blit', onError, signal })
```

A consumer who drops the parameter loses only the pre-mount window; everything after the factory
resolves still reaches `SceneOptions.onError`, because the binding attaches `stage.on('error')` too.
**The handed-down listener stops forwarding the moment `create` resolves** — core registers it on the
bus permanently (`stage.ts:283`), so without that gate every post-resolve error would arrive twice
(§7).

**Cleanup disposes as well as aborts.** The effect's cleanup aborts the in-flight build *and* calls
`dispose()` on a stage that has already landed. §1's constraint covers only the loser of a
double-invocation; a stage that resolved and was then superseded by a `deps` change is nobody else's
to release.

`play` and `stop` on a scene that is not `ready` are not errors and do not queue: `stop` is a no-op
and `play` resolves to an empty report — no views, nothing skipped, nothing failed, and
**`completed: false`**, which is what a broadcast over zero eligible views reports (`collisions.ts:133`,
`stage.ts:2178`). `stage.play` never returns an Error and never rejects (§4.4), and the binding does
not become the first place in the family where a wave can fail.

**A rebuild is not a reset.** The knobs a consumer has moved are re-applied to the new stage once it
is up, and a key the new slot set no longer declares is skipped rather than reported.
`examples/playground/src/useStage.ts` establishes this behaviour and this spec keeps it.

**`Scene` carries build metadata through `SceneBuild<M>`.** A successful `create` may return
`{ stage, meta }`; the ready snapshot exposes that same `meta`, while building, failure, and context
loss clear it alongside `stage`. A bare `pc.BlitStage` remains legal and means `M = undefined`.
`onReady` receives the build and its generation/signal, so consumers can retain build artifacts
without a sidecar race. The metadata is consumer-defined and does not make the package import sheet,
motion, or other slot types.

`onReady` fires once per landed build, after the ready store bump and before React re-renders. Its
signal is the build effect controller signal and aborts on rebuild or unmount. `onFailed` covers
returned or thrown `create` errors, duplicate-core failure, and context loss; `lost` distinguishes
context loss from other failures. For `lost: true`, `generation` identifies the lost build; for
other failures it is the last successful generation, or zero before any successful build.

### 4.2 `PaperScene` and `useScene`

```tsx
<PaperScene value={scene}>{children}</PaperScene>
```

A context provider and nothing else — it renders no DOM. `useScene()` reads it; `useCrumple` calls
`useScene()` unless given an explicit `scene` option, which is the escape hatch for two scenes on
one page.

`useScene()` outside a provider returns a permanently-`failed` scene carrying an Error rather than
throwing. Nothing in this package throws (§7).

### 4.3 Knobs

`knobs` is a plain object of flat or namespaced keys (§6.2). On every change the hook diffs it
against the last applied map and writes **only the changed keys** — **one `stage.set` call per
changed key**, never one call carrying the whole diff.

That is not a stylistic preference. `normalise` returns on the first invalid key and writes nothing
(`knob-registry.ts:155`), and `applyPatch` only reaches `Object.assign` for a wholly valid patch
(`stage.ts:846`), so `stage.set({ a: ok, b: bad, c: ok })` applies **none** of the three. An earlier
draft promised "one bad key does not abandon the batch" while prescribing the one call shape that
cannot deliver it. One call per key makes the promise true, and it is what the reference
implementation already does (`useStage.ts`: `stage.set({ [key]: value })`). A refused key is reported
and the rest are still attempted.

**Reported, but not synchronously and not to whoever moved the control.** `knobs` is a declarative
prop, so the write happens in the scene's effect *after* the commit that changed it, and a refusal
cannot come back as the return value of anything the consumer called — there is no call to return
from. It arrives at `SceneOptions.onError`, one dispatch per refused key, carrying `observed: true`
(§7), on the render after the one that asked. A panel that wants to refuse a value in the same tick
as the gesture — the shape a control written directly against `stage.set` has, and the shape the
playground's own panel had before the migration — cannot be built on `knobs` and should not try:
it writes `scene.stage.set` itself and keeps its synchronous answer. This section previously said
only that a refusal "is reported", which reads as a promise about *when*.

**A key removed from `knobs` resets when it was previously applied.** The hook writes the removed key
back to `stage.defaults[key]`; undeclared keys are skipped. The complete diff is one batch and bumps
`knobEpoch` once, after all writes. A refusal still reaches `onError` and the key-carrying
`onKnobRefused(key, value, error)` callback, while `scene.stage.set(...)` remains the synchronous
escape hatch. The per-drag render-cost caveat remains a measurement item, not a promised optimization.

A key whose descriptor moves geometry makes the next demand on the front answer
`SourceExpiredError`, which the stage turns into a re-source. That work is still in flight when
`stage.set` returns, so someone must join it with `await stage.prepare(spriteKey)` before re-framing:
reading `View.frame` any earlier reads the frame the sprite is about to leave. This is `settleFrame`
in `examples/playground/src/useStage.ts` and it is a requirement, not an optimisation.

**The scene cannot be that someone**, and an earlier draft that made it so declared a behaviour with
no mechanism behind it. `prepare` takes a *sprite* key, framing state lives on the crumple instance,
and the scene has no register of crumples to walk. So the work is split at the only seam that exists:

- The scene **writes** the knobs and then bumps `knobEpoch`, a second counter alongside `generation`
  (`generation` counts landed builds; a knob write is not a build and must not masquerade as one).
- Each crumple **watches `knobEpoch`**, and on a change joins `stage.prepare(spriteKey)` for its own
  sprite, then recomputes `frame` and `frameStyle` and calls `view.refresh()`.
- **A crumple with no sprite yet skips the join entirely** — `view.sprite === null`, or its own
  acquisition still in flight. `prepare` on a key with no record returns a `SheetError`
  (`stage.ts:1881`), and a key that is merely *reserved* has no record until `addBody` finishes
  (`stage.ts:1825`), so joining here would report a library error for the perfectly ordinary
  sequence of moving a knob while a tile is still mounting. Nothing is lost by skipping: that
  acquisition is already building at the live knob values.

This lands §4.3's "one join per batch, not per knob" — the scene bumps once per batch — and it lands
"the re-source is per sprite" — each crumple joins its own key and no other. A crumple whose sprite is
shared with a second crumple joins the same in-flight re-source twice, which `prepare` already
handles: it is the one demand that waits rather than returning around it.

**Every batch joins, not only a geometry-moving one.** Neither half of that split consults the
descriptor tier: the scene bumps `knobEpoch` once per batch that wrote anything at all, and every
crumple watching it joins `stage.prepare(spriteKey)` and calls `view.refresh()`. A `draw`-tier write
therefore pays the same join as a `hull`-tier one. The join on an unexpired front has no re-source to
wait for and settles immediately, so this is not a correctness defect — but it is one extra microtask
and one extra redraw per knob write, and a knob drag is one write per frame. The reference
implementation was narrower: `useStage.ts` re-framed only for a write whose descriptor moved
geometry, and its `movesGeometry` field has no consumer left in the migrated playground. §11 records
what reading the tier here would take. What this section must not say is that the join is
conditional.

`Scene` therefore carries `readonly knobEpoch: number`.

## 5. The crumple

### 5.1 `useCrumple`

```ts
type CrumpleOptions<S extends pc.SpriteSource> = {
  spriteKey: string
  src: S
  scene?: Scene                     // defaults to useScene()
  fit?: pc.Fit                      // fixed at stage.view(); not a prop
  tag?: string
  entrance?: 'flat' | 'uncrumple'   // default 'flat'
  /** Wall time in MILLISECONDS for the whole traversal — not a multiplier. Applies to every run
   *  this hook starts, the entrance and the swap alike. The ball hold is scaled with it; only the
   *  excess a slow fetch adds on top of the hold is not (`dwell.ts:213`, `runner.ts:502`). */
  duration?: number
  /** The CSS long side the ARTWORK should hold on screen. Absent — the default — means the hook
   *  reports `frame` and applies nothing; §6 is what consumes it. */
  frameTo?: number
  reducedMotion?: 'auto' | 'off'    // default 'auto'
  onStart?: (e: pc.Events['start']) => void
  onEnd?: (e: pc.Events['end']) => void
  onSettle?: (e: CrumpleSettleEvent) => void
  /** A `pc.StageEvent`, not a `pc.Events` member — errors never reach a view's own bus. */
  onError?: (e: pc.StageEvent<'error'>) => void
} & pc.PinFor<S>

interface CrumpleSettleEvent {
  readonly key: string
  readonly error: Error | null
  readonly reduced: boolean
}

type CrumpleStatus =
  | 'detached'
  | 'empty'
  | 'acquiring'
  | 'shown'
  | 'playing'
  | 'swapping'
  | 'rolled-back'

interface Crumple {
  /** Identity-stable per §2.1, and that is load-bearing: React re-attaches a callback ref whose
   *  identity changed, which here means disposing and rebuilding the view every render. */
  readonly ref: (el: HTMLCanvasElement | null) => void
  readonly state: pc.ViewState | 'detached'
  readonly status: CrumpleStatus
  readonly sprite: pc.Sprite | null
  readonly pending:
    | { readonly key: string; readonly phase: 'acquiring'; readonly run: null }
    | { readonly key: string; readonly phase: 'entering'; readonly run: pc.Run<pc.PlayResult> }
    | { readonly key: string; readonly phase: 'swapping'; readonly run: pc.Run<pc.SwapResult> }
    | null
  /** The swap is parked at the ball, waiting on its target. Maintained by the binding, because
   *  `crumpling.ball` is set between two emissions and is never observable (§5.5). */
  readonly parked: boolean
  readonly pose: number              // 0 while detached — 'flat', the pose a view is born at
  readonly shown: string | null      // view.sprite?.key ?? null
  readonly requested: string | null  // the spriteKey last asked for
  readonly error: Error | null
  readonly frame: pc.ViewFrame | null
  /** `frame` already scaled by `frameTo` into the four CSS numbers §6 writes on the wrapper.
   *  `null` when `frameTo` was absent or no front is resident. The arithmetic lives here and not
   *  in the component because §2 puts logic in the hook. */
  readonly frameStyle: { width: string; height: string; left: string; top: string } | null
  readonly artworkStyle: { readonly width: string; readonly height: string } | null
  readonly view: pc.View | null      // raw, so an unforeseen scenario stays reachable
  /** `null` while detached. The `Run` is returned rather than swallowed: it is the only handle
   *  that carries `stop()` and the settled result, and a caller who wanted `void` can ignore it. */
  play(from: pc.PoseRef, to: pc.PoseRef, o?: pc.PlayOptions): pc.Run<pc.PlayResult> | null
  stop(): void
  draw(pose: pc.PoseRef): void
  sync(): void
  retry(): void
  refresh(): void
}

function useCrumple<S extends pc.SpriteSource>(o: CrumpleOptions<S>): Crumple
```

The public `CrumpleStatus` type is this derived discriminant, distinct from core view `state`.
Its `rolled-back` member means `error !== null && requested !== shown`; the other members describe
the current request and view snapshot without changing core's state machine.

**`size` is not an option and v1 is always `'managed'`.** Offering `'manual'` would have been a
promise with nothing behind it: under `'manual'` the core never writes `canvas.width/height`
(`stage.ts:1057` guards on `'managed'`), and §6 excludes those attributes from `canvasProps`, so the
destination would sit at its stock 300×150 with no one able to size it. Rather than reopen the
attribute and make the two settings mean opposite things about who owns the element, `'manual'` is
deferred (§11) and the escape hatch is the raw `scene.stage.view()`.

**`pin` is intersected through `pc.PinFor<S>`**, exactly as `AddOptions` does (`stage.ts:96`), so a
bare `ImageBitmap` **written at the call site** fails to typecheck without `pin: true` instead of
typechecking and then failing at runtime with the `AssetError` core raises for a source no
re-supplier can be derived from (`stage.ts:1796`). Losing that at the binding's seam would have made
the React path the one place in the family where the budget silently stops bounding anything.

The qualifier is the core's own: a source widened to the whole `SpriteSource` union — read out of a
data model — passes the tuple test and reaches the runtime check instead (`source.ts:61-65`). The
binding inherits that hole exactly, neither widening nor claiming to close it.

`play` must stay a plain function, never `async` and never wrapped in one: `start` is emitted
synchronously inside `view.play`, and the wrapper is exactly where that guarantee is lost (§5.3).

Gate side effects on `crumple.view !== null` (or `state !== 'detached'`) before calling `play`; a
`null` return is too late to undo a side effect. The return is a raw `Run`, not a settlement signal.

`fit` and `tag` are fixed when the view is created. A later change is ignored and warns once in
development; the values remain fixed until the view is rebuilt, typically by remounting under a
different React `key`.

**`null` from `play` means detached, and means nothing else.** There was no view to call — the scene
is not `ready`, or no canvas is attached. A run that is *refused* or cut short is not a `null`: it is
a `Run` that settles `PoseError` or `ABORTED` (§7), because `view.play` always hands back a handle.
The distinction matters to a caller that commits to a side effect around the call, which is the case
the migration found: audio begun before `play` cannot be un-begun by a `null` arriving after it. Such
a caller branches on `crumple.view === null` — or equivalently `state === 'detached'` — *before* it
commits, and treats a `null` return as the assertion that it should have. The same synchronicity that
forbids wrapping `play` in a promise is what makes its return value too late to gate anything.

`requested` and `shown` are separate because they genuinely diverge: a swap whose target fails rolls
back to the previous sprite (`state === 'crumpling.recover'`, and the `Run<SwapResult>` returns the
target's Error), so the prop says B while the canvas shows A. The instance reports both and the
Error. The binding does not retry automatically; `retry()` explicitly retries the current rolled-back
key without requiring a key-away-and-back cycle.

**`error` reports the last settled run and is cleared when the next one starts** — on `start`, not on
`end`, so a consumer rendering a rollback notice from `error !== null` sees it removed the moment the
user's next interaction begins rather than a fold later. It does not latch until unmount: a latching
field would make `error !== null` mean "something once went wrong", which no consumer can render.

`onSettle` fires exactly once for a request that reaches animated completion, degraded `show()`, or
rollback, and never for a superseded or unmounted request. Its `reduced` flag records whether
reduced-motion accommodation applied to that request. `pending` remains non-null until this request
settles.

### 5.2 Lifetime

The view exists exactly when **both** conditions hold: the scene is `ready`, and a canvas element is
attached. It is created by whichever of the two completes the pair, and disposed in the ref cleanup
or when the scene leaves `ready`. `state` reads `'detached'` while no view exists.

`view.dispose()` "leaves the element's last blitted pixels in place; the element itself is the
consumer's" (`packages/core/src/view.ts:105`), which is the behaviour a React unmount wants.

**Across a scene rebuild** the sprite is re-acquired and the entrance replays. There is no cheaper
option to choose between: a rebuilt stage is a new GL context with no sprites in it, so there is
nothing to re-`show` and the acquisition has to happen again anyway. `requested` survives the
rebuild — it is the consumer's prop, not library state — while `shown` returns to `null` until the
new sprite lands, which is exactly the window in which `children` renders again.

### 5.3 The swap, and the core amendment

The swap is where two core contracts force the design, and both are counter-intuitive enough to
restate.

**`view.swapTo` mints its own key.** `packages/core/src/stage.ts:1413`:

```ts
const key = `swap:${presetForImageId(String(src))}:${String(swapCounter++)}`
```

and its docblock says outright that *"a consumer who wants a stable key calls `add()` and
`crumpleTo()` themselves."* Because the fold preset is `presetForImageId(key)` at fit time
(`stage.ts:1647`), the monotonic counter means **`swapTo` folds the same picture differently on
every swap**.

**`add()` on a live key is refused** (`stage.ts:1782`) with a `SheetError`: the hull cache is keyed
on `(sprite key, sdfRes, hull knobs)` and the bitmap is not in that key, so a re-pointed key would
inherit the old hull.

Together these make a stable, caller-supplied key impossible through today's `swapTo`.
Re-implementing `swapTo` inside the React package was the alternative, and it would mean copying its
abort gate (`stage.ts:1414-1433`), under which a superseded, stopped or unmounted swap aborts the
`add()` it started so that a second swap does not pay for an ingest nobody will show.

**Amendment (core, additive):**

```ts
/** `swapTo`'s options ALONE. `SwapOptions` stays as it is — it is shared with `crumpleTo`
 *  (`view.ts:17`), which takes a `Sprite` rather than a source and for which a key is meaningless.
 *  Widening the shared type would have added a member one of its two users silently ignores. */
export interface SwapToOptions extends SwapOptions {
  /**
   * The key the incoming sprite is added under. Defaults to the minted `swap:…` key, which is
   * unstable by design. Supplying one makes the fold preset stable per picture, lets two views
   * share one front, and lets the byte budget bound the result.
   *
   * A key that is already resident is a CACHE HIT, not a failure: the swap adopts the resident
   * sprite and `src` is not read. Re-pointing a live key remains `replace()`.
   */
  key?: string
}
```

**The resident branch is smaller than it looks.** It is one early return placed before the abort gate
is built:

```ts
const resident = o?.key !== undefined ? p.sprites.get(o.key) : undefined
if (resident !== undefined) return view.crumpleTo(resident.sprite, o)
```

Nothing else moves. The gate exists only to abort an `add` (`stage.ts:1414-1433`) and there is no
`add` to abort; `o.signal` still reaches the runner through `PlayOptions` inside `crumpleTo`;
`holdTarget` takes its hold synchronously for a `Sprite` and skips `pendingAdds` and `lane.promote`,
which are the promise branches (`stage.ts:1310-1319`); the release accounting is unchanged and
idempotent (`stage.ts:1322`); and `start` is still synchronous because `crumpleTo` emits it
synchronously. A resident-but-evicted front is handled where it already is — `adopt` at the ball sees
`next.front === null` and drains the rebuild queue (`stage.ts:1385`).

**One claimed benefit is narrower than stated.** "Lets two views share one front" holds only once the
first `add` has settled: a concurrent second `swapTo` on the same key is still refused by `reserved`.
That is what the in-flight map in `acquire` above is for, and the same map must gate `swapTo` — the
binding does not call `swapTo` for a key whose acquisition is in flight; it joins the existing one and
`crumpleTo`s the result.

The resident-key clause is the half that matters. Without it the commonest sequence in the library —
A → B → A — fails on its third step, because key `a` is still resident and `add` refuses it. With
it, a swap back to a picture already seen costs no fetch and no byte budget, and parks for exactly
the authored ball hold rather than for the fetch.

**Not "instant".** A resident swap is still `crumpleTo` on a non-empty view, which takes the full
rise → hold → descent path (`stage.ts:1369-1398`) and always tickets `scaledHold` through the park
timer (`runner.ts:502`, `dwell.ts:213`). The degenerate-to-`show()` shortcut is for an **empty** view
(`stage.ts:1331`), which a swap by definition is not. What the cache hit removes is the wait, not the
animation — and removing the animation would be the wrong trade anyway.

Nothing is removed and nothing changes meaning: `SwapOptions` is untouched, `SwapToOptions` extends
it with one optional member, and `view.swapTo`'s parameter widens — a `SwapOptions` an existing
caller already passes still satisfies it. A minor under §10.2's "minors are additive".

**`SwapToOptions` must be exported from `packages/core/src/index.ts`**, next to the existing
`export type { SwapOptions, ViewFrame } from './view.js'`. A parameter type a consumer cannot name is
a parameter type a consumer cannot build a variable of, and this package's own signatures would be
the first to need it.

**What `useCrumple` then does.** The swap fires when `spriteKey` changes. Under
`reducedMotion: 'auto'` the hook checks `matchMedia('(prefers-reduced-motion: reduce)')` **at the
swap, not at mount** — so a consumer who changes the OS setting mid-session gets the new behaviour
on their next interaction — and takes the degraded path, which needs no API of its own:

```ts
// reduced: show() IS the degraded swap (USAGE, "Reduced motion")
const sprite = await acquire(stage, spriteKey, src, signal)
if (sprite === pc.ABORTED) return
if (sprite instanceof Error) { report(sprite); return }
view.show(sprite)

// otherwise
const run = view.swapTo(src, { key: spriteKey, duration, signal })
```

**A `spriteKey` that does not change is silence, and the silence is not reported.** The sync refuses
a request whose `(view, key)` pair it has already synced, and it refuses it early: before `requested`
is touched, before the internal sequence number advances, before `enter` or `swap` — never mind
`view.swapTo`. No `add`, no run, no `start`/`step`/`end`, no `onSettle`, and no store bump. As a
refusal that is right — re-selecting the picture already shown should cost nothing — and as a signal
it is a trap for any caller that arms state *around* the swap it believes it just started. A transport
that sets a fold direction and waits for `onEnd` waits forever; **a caller that arms anything must
make the same-key check itself, before it arms**. The alternative, a snapshot field or an event
meaning "considered and declined", is not in v1.

**Compare against `crumple.requested`, never `crumple.shown`.** A rollback can leave the requested key
different from the shown key while `error` is non-null, so `shown` is not the driver's record of the
key it already considered.

**The declarative swap hands back no handle.** `crumple.play` returns its `Run`; the swap cannot,
because nothing calls it — the hook starts it off a `spriteKey` change. Supersession by the hook's own
sequence number is strictly better than a consumer-held `AbortController` and is not the loss; the
loss is `stop()` and the settled `Run<SwapResult>`. What a consumer gets instead is `shown`,
`requested`, `pending`, `error` and `onSettle` to correlate the request; `onEnd` remains the view-run
event and the degraded path below does not fire it. §11 names the imperative form and the hazard that
comes with it.

### `acquire` — the one shape that turns a pair into a sprite

**Every place this package needs a sprite goes through it**, the first mount (§5.4) and the degraded
swap alike. It is three lines and each one answers a defect:

```ts
const inFlight = perStage.get(spriteKey)                          // 1
if (inFlight === undefined) {
  const p = stage.get(spriteKey) !== undefined
    ? stage.prepare(spriteKey, { signal: sceneSignal })           // 2
    : stage.add(src, { key: spriteKey, signal: sceneSignal })     // 3
  perStage.set(spriteKey, p); void p.finally(() => perStage.delete(spriteKey))
}
let got = await perStage.get(spriteKey)!                          // 4
if (got instanceof SheetError && liveKey(got)) {                  // 5
  got = await stage.prepare(spriteKey, { signal: sceneSignal })
}
if (mySignal.aborted) return pc.ABORTED                           // 4
return got
```

1. **A per-stage map of in-flight acquisitions, keyed by sprite key.** `add` refuses a key that is
   merely *reserved* — in flight and unfinished (`stage.ts:1782`, and `stage.ts:371`: "A live key is
   refused whether or not it has finished"). Two `Crumple`s sharing a `spriteKey` and mounting in one
   commit both see `stage.get() === undefined`, both call `add`, and the second gets a `SheetError`.
   The map is what makes §5.4's "a second `Crumple` on a picture already on screen appears without a
   fetch" true rather than aspirational. It lives on the scene, beside the stage, and dies with it.
2. **`prepare`, not the resident sprite.** `stage.get` returns the record's sprite, and eviction
   *"drops a front and leaves the sprite rebuildable"* (`stage.ts:376`) — so a resident key can hand
   back a sprite with no front. `show`ing it sets `view.sprite`, which lifts §6's placeholder over an
   empty canvas, while the re-source runs asynchronously and lands without an event (§5.5). `prepare`
   is the one demand that *waits* for a re-source instead of returning around it
   (`stage.ts:1888-1915`), which is exactly the guarantee this call site needs.
3. `add` only when the key is genuinely absent.
4. **The shared acquisition runs under the scene's own signal, and each joiner checks its own after
   the await.** Passing the first caller's signal would hand every joiner the first component's
   lifetime: the first unmounts, the shared promise settles `ABORTED`, and the second `Crumple` takes
   the abort branch and **stays blank forever**, with no error and no retry. The scene's controller
   dies with the stage, which is the right lifetime for work several components share; a joiner that
   has itself unmounted converts the settled value to `ABORTED` locally.
5. **A live-key `SheetError` is retryable exactly once, via `prepare`.** The in-flight map only knows
   about acquisitions *this binding* started, and `reserved` — the set of keys whose `add` is in
   flight — is private (`stage.ts:371`): neither `stage.get` nor `prepare` can see it
   (`stage.ts:2322`, `stage.ts:1880`). So a consumer prefetching `scene.stage.add(src, { key:
   'hero' })` while a `Crumple` on `spriteKey: 'hero'` mounts makes both callers see an absent key,
   both call `add`, and one gets the live-key refusal. Falling back to `prepare` joins the winner
   instead of failing a correct sequence. §11's prefetch note says to prefetch **before** mounting
   for the same reason.

An earlier draft wrote this as `stage.get(k) ?? await stage.add(…)`. It typechecks, and it is wrong
twice: it shows evicted sprites blank, and it races itself across two components.

`entrance` is irrelevant under the degraded path: `show()` is one draw, with no run and no
`start`/`step`/`end` triple, which is also why nothing downstream of it needs a reduced-motion
branch of its own. An `entrance: 'uncrumple'` under `reduce` is therefore `'flat'`.

**A reduced-motion swap emits no view-run event, but it does settle through `onSettle`.** `onStart` and
`onEnd` are dispatched from the view's own bus (§5.5) and the degraded path never touches it: there is
no run to start and none to end, only a `show()`. A consumer who closes something on `onEnd` — an audio
sequence, a transport flag, a cursor — must use `onSettle` for request completion; `shown` alone is
not a settlement signal. `CrumpleSettleEvent.reduced` records that this accommodation applied.

**No `await` may sit between a user gesture and `swapTo`.** `start` is emitted synchronously inside
the call, and an `AudioContext.resume()` in a start handler only runs inside the gesture because of
it (§7.1). The swap driver is therefore not an `async` function; settlement is handled in a `.then`
on the returned `Run`.

**`src` changed while `spriteKey` did not** is a consumer error, and the hook detects it without help
from the core: it keeps a `Map<spriteKey, src>` of every pair it has requested, and refuses a request
whose key it has seen bound to a different source.

**A map, not the last pair.** The obvious cheaper form — remember only the pair last requested —
misses the case that matters, and misses it silently. Requesting `(a, url1)`, then `(b, urlB)`, then
`(a, url2)` changes the key at every step, so a last-pair check passes all three; the third then takes
the §5.3 cache hit on the resident `a` and **shows `url1` while the prop says `url2`**. The map costs
one entry per picture this component has shown and turns a silent wrong picture into a reported
Error.

It reports an Error naming the hull-cache reason and does nothing. The key names a *picture*, not a slot; `stage.replace(key, src)` is the
sanctioned re-point and is one line away through `scene.stage`. Automatic `replace` was rejected
because `replace` releases the source-derived halves before rebuilding (`stage.ts:1996-1998`), so the
front the rise would animate on is gone — the animation would silently vanish.

**`File` is a direct source.** It is a `Blob` and is passed directly as `src`; the binding does not
require an object URL. The identity guard still compares sources and never forgets a key, so a
consumer keeps a unique key for each dropped picture — two files with the same filename can differ —
and does not re-point a key to a different source.

### 5.4 The entrance

The first sprite comes from `acquire` (§5.3), which is what lets a second `Crumple` mounted on a
picture already on screen elsewhere appear without a fetch. `stage.mount` is deliberately **not**
used: it composes `add` + `view` + `show('flat')` in one call, and this package needs the three
separately, because the view is born with the canvas ref and the sprite is acquired against a key
that may already be live, in flight, or resident with an evicted front.

`entrance: 'flat'` (the default) then shows that sprite with no animation, which is the state
`stage.mount` would have left.

`entrance: 'uncrumple'` shows it, draws the ball, and plays out of it: `view.show(sprite)`,
`view.draw('ball')`, `view.play('ball', 'flat')`.

**The order is load-bearing and not merely tidy.** `draw` resolves a `PoseRef` against the shown
sprite's clip (`stage.ts:1508-1516`), so a `draw('ball')` issued *before* `show` resolves against a
pose count of 1 and draws pose 0 — the flat sheet, silently, instead of the ball.

**It is an entrance, not a loading indicator, and this spec must not be read as promising
otherwise.** `crumpleTo`, and therefore `swapTo`, *on an empty view degenerates to `show()`*
(USAGE §2), so there is no ball to park at before the first sprite exists. The loading indicator for
the first sprite is `children` (§6); the ball is the loading indicator only for swaps, where a
sprite is already on screen to rise from.

### 5.5 Reactive state

`state`, `status`, `parked`, `pose`, `shown`, `sprite`, `requested`, `pending`, `error`, `frame`,
`frameStyle`, `artworkStyle` and `view` are served through
`useSyncExternalStore`, over a store the **binding** versions.

**Events are a supplementary source, not the source.** An earlier draft subscribed `start`, `step`,
`end` and `error` and called the snapshot fresh. It is not, and the gap is not an edge case — it is
the default path:

- **`view.show()` emits nothing on an idle view.** `transition(…, 'show')` carries `emits: live`
  (`view-state.ts:125`) and `live` is false when idle; `paint` emits nothing. So `entrance: 'flat'` —
  the default — and every reduced-motion swap move `view.sprite` from `null` to a sprite **with no
  event at all**. `shown` would stay `null` forever and §6's placeholder would never lift.
- **`view.draw()` emits nothing** (`emits: false`, `view-state.ts:117`) while moving `view.pose`, so
  the `draw('ball')` of `entrance: 'uncrumple'` is invisible.
- **A landed re-source emits nothing.** `invalidateSpriteAt` ends in `v.refresh()`
  (`stage.ts:899-921`), and `refresh` is event-free by amendment 15 — so §4.3's "re-frame after the
  re-source has landed" has no event to hang on.
- **`crumpling.ball` is never observable.** `host.setState('crumpling.ball')` runs in the rise
  stepper's `onDone` (`runner.ts:496`) — after the rise's last `step`, before the descent's first —
  so for the entire park, which is the whole point of the ball, a listener reads
  `crumpling.rise`.
- **`error` never reaches a view's bus at all.** A view's bus carries exactly `start`, `step` and
  `end`; an error takes §10.6's route straight onto the **stage's** bus (`stage.ts:1105`). A
  `view.on('error', …)` compiles and is silently dead.

So the store is versioned by the binding on every call it makes into the core — `view.show`,
`view.draw`, `view.refresh`, `view.play`, `view.swapTo`, view creation and disposal, and the
settlement of a `stage.prepare` — **and** by the three real view events, **and** by
`stage.on('error')` filtered to `e.view === view`. Each bump re-reads the getters into a cached
snapshot object.

`parked` is maintained the same way, from what the events do carry: a swap's `start` reports `via`,
the resolved ball index, and the run is parked from the `step` whose `pose === via`. This needs no
`poseCount` accessor and no core change. The target `shown` and `sprite` are adopted at the ball,
while descent is still running; `pending` remains non-null through that descent and is cleared only
when the request settles. Neither `shown` nor `sprite` is therefore a settlement signal.

**It is cleared by `end` and by `start`, not only by the next `step`.** A park cut short by
`view.stop()`, by supersession or by `dispose()` goes through `cancel` → `finish` → `end`
(`runner.ts:184-195`), and the descent stepper is only ever created inside `leaveBall`
(`runner.ts:466`) — which the cancel path leaves before reaching. So "until the next `step`" latches
`parked` at `true` for the rest of the component's life on every stopped, superseded or unmounted
swap. `start` clears it too, and clears the remembered `via` with it, or a later ordinary `play`
whose first `step` happens to land on the previous run's ball index latches it again.

`onStart`, `onEnd` and `onError` are dispatched from these subscriptions. `onSettle` is dispatched
exactly once when the current request reaches animated completion, degraded `show()`, or rollback,
and never when superseded or unmounted. All callbacks use the identity-stable `useEvent` wrappers;
they do not create their own subscriptions.

The snapshot **must be that cached object, rebuilt at each bump** — never assembled fresh inside
`getSnapshot`. `view.state` and `view.pose` are getters, so an object literal built per call has a new
identity every time and `useSyncExternalStore` would loop forever. `getServerSnapshot` returns the
detached snapshot (§8).

`Scene.warnings` and `Scene.lost` are re-read on the scene's own bumps for the same reason:
`stage.warnings` grows at runtime (`stage.ts:942`, `stage.ts:1865`) and `stage.lost` is *"the
synchronous form of the `lost` event"* for a listener that missed it (`stage.ts:114`), and neither a
mirror captured at build time nor a subscription that started late would ever show it.

**A lost context moves the scene to `status: 'failed'`, carrying the `GlError`.** After a loss
`dead()` makes every stage method return that error — `view()`, `add`, `prepare`, `set`, `replace`,
`remove`, `mount` (`stage.ts:951`) — so a `Scene` reporting `ready` with a non-null `stage` would be
handing consumers a stage on which nothing works. Failing it keeps §4.1's invariant and needs no new
state. `lost` stays as a separate boolean because `failed` alone does not say *why*, and a consumer
offering a "reload" affordance needs to tell a lost context from a build that never came up.

**Each `Crumple` learns about it from the scene, not from the event.** The loss `GlError` is orphaned
with `view: null` (`stage.ts:427`), so §5.5's `e.view === view` filter drops it and no crumple would
otherwise notice. A scene that leaves `ready` disposes the views (§5.2), which is exactly the
`'detached'` state and the `children` placeholder again.

**`onStart`, `onEnd` and `onError` are dispatched from those same subscriptions**, through §2.1's
`useEvent` — never their own `view.on` calls. Subscribing per callback would put the consumer's
function identity in the effect's dependencies, so an inline arrow tears down and re-attaches every
render; omitting it from the dependencies is the stale-closure bug that replaces it. §2.1 has
neither, which is the whole reason it is a package-wide convention rather than a local trick.

**The snapshot is the source of truth and it does not carry everything a consumer reads.** Both
halves of that sentence are true and the second is easy to leave unsaid. The migration's diagnostics
footer is the evidence: four separate readings fall back to the raw `crumple.view` that §5.1 exposes
for unforeseen scenarios, and between them they map this surface's edge.

- **No timing.** The binding owns the `stage.add` inside `acquire`, and `onStart` fires on the run,
  after the sprite is already resident — so the front bake, which is the expensive half of a mount,
  has no seam a consumer can time. A consumer who must time acquisition does its own `add` through
  `scene.stage` and gives up the shared in-flight registry (§5.3) by doing so, which is a real cost
  and not a formality: it is the thing that makes two crumples on one key cost one fetch.
- **`sprite` is shipped.** `sprite` is read in the same snapshot pass as `shown`, so a consumer can
  inspect the resident `pc.Sprite` without reaching through `crumple.view` during render. `shown`
  remains its key-shaped companion for lightweight comparisons.
- **No run cadence.** Neither a step count nor a step interval; a consumer wanting either subscribes
  `view.on('start')` and `view.on('step')` itself, in parallel with the binding's own subscriptions.
- **`draw` and `sync` are shipped.** `draw(pose)` performs one draw and one snapshot bump, while
  `sync()` re-reads after an otherwise-raw view call without drawing. `refresh()` retains its
  draw-and-refresh meaning for callers that need both.

**Some consumer-specific snapshot bookkeeping still needs effects.** `usePaperScene` and
`useCrumple` avoid setState-in-an-effect internally by owning a versioned
store and reading it through `useSyncExternalStore`; that store is not exported (§3). The shipped
`onReady`, `onFailed`, and `onSettle` callbacks, together with the stable methods and callbacks, cover
the corresponding scene and request events without consumer bookkeeping effects. Where a consumer
needs to synchronise its own state from a snapshot and no shipped callback covers that case, the
store-primitive deferral remains: `useEffect` plus `useState` is the only current option, and
`eslint-plugin-react-hooks@7.1.1` reports the pattern at **error** level under
`react-hooks/set-state-in-effect`.
The current playground migration and its remaining App suppressions are separately owned by P7;
this design record does not claim that cleanup has landed. §11 names the store primitive as the
alternative for cases the shipped callbacks do not cover.

## 6. What `<Crumple>` renders

```tsx
<Crumple value={crumple} className="tile" style={…} canvasProps={…}>{placeholder}</Crumple>
```

A positioned wrapper element, a `<canvas ref={value.ref}>` inside it, and `children` layered over the
canvas while `value.shown === null`. DOM props land on the wrapper; `canvasProps` is the escape hatch
for the canvas itself.

The wrapper is a `<div>` with a fixed default of `position: relative`. Consumer `style` may override
that default; an `as` prop is a separate guess at a requirement nobody has stated yet, and adding
one later breaks nothing.

The wrapper is not decoration. The paper overflows the picture by however far the edge knobs reach,
and pinning the *picture* rather than the *paper* means sizing and offsetting an element from
`View.frame`'s two boxes with one scale, `frameTo / max(artwork.w, artwork.h)` (USAGE, "pin the
picture"). `frameHero` in `examples/playground/src/stage.ts` is the reference implementation.

**That arithmetic runs in the hook, not in the component**, and `<Crumple>` merely spreads
`value.frameStyle` onto the wrapper when it is non-null. An earlier draft had the component apply the
scale itself, which was wrong twice over: the component receives only `value: Crumple` and so could
never see `frameTo` at all, and §2's own rule puts logic in the hook. This is the second time this
document declared framing behaviour with nothing to implement it from — the first was keying it on an
`artworkCssPx` the package never sees (below) — so the rule is worth stating in general: **anything
`<Crumple>` needs must be a field on the instance, because the instance is the only thing it is
handed.**

`value.frameStyle` is recomputed after every swap and after a hull-tier re-source has landed (§4.3).

**`frameStyle` is the paper box and `artworkStyle` is the picture box.** Both are derived in the hook
from `frameArtwork(frame, frameTo)`, at the same scale and with the same `null` convention: absent
`frameTo` or absent `frame` means the hook applies nothing. `frameStyle` goes on `<Crumple>`'s
wrapper; `artworkStyle` gives a consumer the artwork's own width and height for an out-of-flow slot.

The wrapper's fixed default is `position: relative`. Consumer `style` may override it, and may set
other properties, but **`frameStyle` is spread last**, so its `width`, `height`, `left`, and `top` win.
A consumer overriding one of those four on a framed wrapper is asking for a broken frame rather than
a customisation.

**Why `frameTo` is an option and not something the binding works out.** An earlier draft said
`<Crumple>` frames "when the scene was built with `artworkCssPx`", which cannot be implemented: the
consumer writes the `paperStage(...)` call inside `create` (§4.1), so that number never passes
through this package, and it is not readable back off a `BlitStage`. Threading it through
`SceneOptions` would have meant stating it twice and trusting the two copies to agree. Naming the
number where it is used instead makes framing an explicit request rather than a behaviour keyed on
how a stage the binding never saw was built. Pass the same number the stage was built with and the
result is 1:1 at `devicePixelRatio`; pass a different one and it merely scales, which is a consumer's
prerogative and not an error.

`canvasProps` is typed
`Omit<React.CanvasHTMLAttributes<HTMLCanvasElement>, 'ref' | 'width' | 'height'>`. All three
exclusions are deliberate and are compile errors rather than silent losses: `ref` belongs to
`value.ref`, and `width` / `height` belong to the stage.

**Nobody but the stage writes `width` or `height` on the canvas.** The binding is always `'managed'`
(§5.1), under which `blitOut` reads `getBoundingClientRect()` and writes the backing store during the
draw (`stage.ts:1057-1071`). A React-set attribute would fight it every blit — and the exclusion is
safe to state absolutely only because `'manual'` is not offered; an earlier draft excluded the
attributes *and* offered `'manual'`, leaving that mode with no one able to size the destination at
all.

## 7. Errors

Nothing in this package throws, and nothing reaches an error boundary. This is not a stylistic
choice: the whole family returns `Error | T`, a promise that fails resolves to an Error rather than
rejecting, and cancellation is a sentinel rather than an Error at all (USAGE, "The convention,
first"). A React layer that converted those values back into thrown exceptions would discard the one
property the design spent itself on.

Consequently: no Suspense, no `use()` on the stage promise, no error-boundary integration. `error` is
a field on the instance and `status` is a value to branch on.

`ABORTED` never reaches a consumer **through the instance's own fields** — `error`, `status`, `shown`
and the rest are never the sentinel, because "React changed its mind" is not a condition a component
renders.

It does reach one place, and the earlier absolute claim was wrong: `crumple.play` hands back the raw
`pc.Run<pc.PlayResult>`, and `PlayResult` is `undefined | PoseError | Aborted` (`results.ts:64`) — a
stopped run, or one on a disposed view, settles `ABORTED` (`stage.ts:1345`). A consumer who awaits a
`Run` this package handed them is holding a core value and narrows it with the core's own two early
returns. That is the price of exposing the real handle instead of a laundered one, and it is the right
price: the alternative is a wrapper that swallows `stop()`.

**`SceneOptions.onError` is not the pre-mount channel** — `create`'s second parameter is (§4.1). This
paragraph said otherwise for two drafts after §4.1 had been corrected, which is worth recording as
its own lesson: a claim fixed in one section survives in another until something reads the whole
document for that claim rather than for that section.

`SceneOptions.onError` is one dispatcher fed from two places, and the binding keeps it single. The
listener handed down to `paperStage` is registered on the stage's bus permanently by the core
(`stage.ts:283`) — it is not a `once` and it is never detached — so the binding's own
`stage.on('error')` would double every post-resolve error, including on the `!observed` path.
**The handed-down listener therefore forwards only while the scene is still building**, and
`stage.on('error')` takes over the moment `create` resolves. A consumer who drops the parameter still
loses only the pre-mount window, and nobody sees an error twice.

Telemetry filters on `!observed`, because an error also on its way to a return value would otherwise
be counted twice for a different reason.

**That filter is the consumer's, and the binding does not apply it first.** `SceneOptions.onError`
and `CrumpleOptions.onError` are handed every error the scene or the instance sees, `observed: true`
ones included — a refused knob, a swap that rolled back — and the flag is data for the handler rather
than a gate in front of it. The reason is that `observed` says the value is reachable *somewhere
else*, not that it is unwanted: a consumer rendering a rollback notice off `crumple.error` wants the
observed ones and a consumer counting failures does not, and a binding that filtered would be
deciding which of the two the consumer meant. The price is real and small: `if (!e.observed) return`
at the top of every telemetry handler, which the playground writes twice because it has two handlers
(`scene.ts`, `hero.ts`) and this package exports no helper for either of them to share (§3).

## 8. Server rendering

`<PaperScene>` renders no DOM. `<Crumple>` renders its wrapper and `children`; the canvas is empty and
no effect runs. `getServerSnapshot` returns the detached snapshot, so `state` is `'detached'` and
`shown` is `null` — which is exactly the branch that renders the placeholder, so the server and the
first client paint agree and there is no hydration mismatch.

## 9. Testing

Level 1, jsdom, no browser and no GPU — §3.4 states that all three React-shaped constraints are
level-1 testable, and this package is the proof. The pure fake stage and snapshot fixtures ship from
the public `@paper-crumple/react/testing` subpath.

Tests use jsdom because `createFakeStage` creates a canvas. Testing Library configures React's act
environment; a bare `act` caller sets `IS_REACT_ACT_ENVIRONMENT = true`. `matchMedia` is guarded and
needs no stub unless a test exercises `reducedMotion: 'auto'` with reduction enabled. The fake's
`view.run` always reads `null`, and `FakeViewHandle.settleRun` controls only the latest run, so tests
settle the latest handle explicitly and assert supersession through the call log.

- A **fake stage** implementing `BlitStage` against the real types, so the tests exercise the
  binding's own state machine rather than WebGL.
- StrictMode double-invocation: exactly one surviving stage, exactly one surviving view, no
  `ViewError` from a claimed canvas.
- Cleanup ordering: a `Crumple` unmounted after its `PaperScene` and before it, in both orders —
  §4.6's idempotence is what makes this pass.
- Swap: a `spriteKey` change fires one swap; a second change supersedes it and aborts the first add;
  a rollback leaves `requested !== shown` with a non-null `error`.
- `src` changed without `spriteKey`: an Error is reported and no library call is made.
- Reduced motion: the media query is consulted at the swap, not at mount.
- Knob diffing: only changed keys reach `stage.set`; a geometry-moving key joins `prepare` before
  `frame` is re-read.
- A resident key swaps without an `add` — the §5.3 cache hit, asserted on the fake stage.
- **`entrance: 'flat'` lifts the placeholder.** The default path emits no event at all (§5.5), so
  this is the test that fails if the store ever goes back to being event-driven. Same for a
  reduced-motion swap.
- **A resident key with an evicted front goes through `prepare`, not `show`** — the fake stage
  reports a sprite whose front is gone and the binding must wait rather than lift the placeholder.
- **Two `Crumple`s sharing a `spriteKey` in one commit produce exactly one `add`** — the in-flight
  map of §5.3, and the assertion is on the fake stage's call log.
- **A `deps` change disposes the outgoing stage**, not only the aborted one — one live stage after
  three rebuilds.
- **A knob batch with one invalid key still writes the valid ones** — one `stage.set` per key (§4.3).
- **A `lost` context moves the scene to `status: 'failed'` with the `GlError`, `lost === true`, and
  detaches every crumple** — the placeholder comes back rather than a dead canvas staying on screen.
- **Identity stability (§2.1).** `ref`, `play`, `stop` and `refresh` keep the same identity across a
  re-render that changes every option, and a re-render alone creates no view and disposes none. This
  is the test that catches the whole-view-churn failure before it reaches a profiler.
- **A stale callback is never invoked.** `onEnd` replaced between two renders is called in its newest
  form by a run started before the replacement.
- `.test-d.ts` type tests in the existing `types` vitest project, including that a bare
  `ImageBitmap` without `pin: true` does not typecheck as `CrumpleOptions.src`.

The GL project stays untouched; this package adds no `*.gl.test.ts`. Assertions should use the fake
stage's call log for exact core interactions — for example, one `add` for shared acquisition and no
`add` for a resident-key cache hit — rather than depending on implementation details of the harness.

The ReactDOM-backed render/probe helpers remain internal; the public subpath contains the pure fake
stage and snapshot fixtures only. Consumers testing hook-driven components built on
`usePaperScene` / `useCrumple` can therefore exercise the real binding contract without WebGL2, while
the test harness retains freedom to evolve. The compatibility promise is additive within a major:
helpers may add fields within a major version, but never remove fields within that major. Consumers
should assert relevant calls and fields rather than exact equality over every helper field.

## 10. The playground migration

`examples/playground/src/useStage.ts` is deleted and its callers rewired onto `usePaperScene` and
`useCrumple`. The migration is the acceptance test for the package: any behaviour the playground
needs that the package cannot express is a defect in this spec, to be fixed here rather than worked
around there.

Two things in the playground are *not* the package's job and stay in the playground: the knob
descriptor collection and labelling (`knobs.ts`, `labels.ts`) — a control panel generated from
runtime descriptors is an application, not a binding — and the audio.

**The acceptance test passed, and one part of it passed by deleting what it could not express.**
`present: 'direct'` was a live, URL-addressable capability of the playground: a `Segmented` control, a
`pc.DirectStage`, the stage's own canvas adopted rather than created, and a hero mounted through
`stage.resize(side, side)` and `stage.view({ rect })`. The package admits no `DirectStage` anywhere —
`create` returns a `BlitStage`, `useCrumple` builds its view from the canvas element handed to
`value.ref`, and `<Crumple>` renders that canvas itself — so the collision is at the return type of
the first line the migration writes, not at its edge. §11 had already examined this exact gap and
declined it, which puts the rule above and that deferral in direct contradiction, and the ruling was
to change the playground: the mode is deleted from the demo, `BuiltStage` stops being a discriminated
union, and the URL codec now *drops* a stale `present=direct` rather than rejecting it, so an old link
still opens at the default. **§11's first bullet stands unchanged and this records the ruling rather
than reopening it.**

The cost belongs in this section rather than in a report nobody re-reads. **A shipped core capability
now has no interactive demonstration at all, and it lost it because the React binding cannot show
it.** It is undemoed, not untested: `packages/core`'s own suite still exercises `present: 'direct'`
through the type overloads (`stage.test-d.ts`), the owned surface (`stage-surface.test.ts`,
`stage-surface.gl.test.ts`), the live-GL stage (`stage.gl.test.ts`) and the view itself
(`view.test.ts`). Saved `#…&present=direct` links also changed meaning. An acceptance test made to
pass by removing a demo capability is a weaker pass than "the migration is green" reads as, and the
rule at the top of this section is what makes saying so obligatory.

One migration outcome is not a gap and is recorded here so a reader of the demo does not mistake it
for one: **picking a different source no longer rebuilds the stage.** `useStage.ts` rebuilt because
the sample was an input to the build; `create` does not read the sample, and §4.1 says to put in
`deps` only what `create` reads, so a source pick became a swap and the demo's two states collapsed
into one. That is almost certainly the better behaviour, nobody asked for it, and it is simply what
§4.1's rule does when a consumer follows it honestly.

## 11. Deferred

- `DirectStage` and `HostedStage`. v1 binds `present: 'blit'` only, because one canvas per component
  is the shape React already has. A `HostedStage` binding is the interesting one — it is how this
  would live inside react-three-fiber — and it needs its own design.
- `size: 'manual'`. Deferred rather than half-offered (§5.1): supporting it means reopening
  `width`/`height` on `canvasProps` and making the two settings mean opposite things about who owns
  the element. `scene.stage.view()` is the escape hatch until someone needs it for real.
- A prefetch hook. `stage.prepare` and the prefetch discipline in USAGE are reachable through
  `scene.stage`; a declarative form needs evidence from real use first.
- `@paper-crumple/audio`, still deferred by §3.4.

The rest were found by the migration and are named here so the backlog is in one place rather than
in a findings report:

- **Acquisition timing and run cadence.** The binding still does not expose when its
  `stage.add`/`prepare` work begins or ends, or a snapshot step count/interval. Consumers needing
  those diagnostics can use `scene.stage` and the raw `crumple.view` seams meanwhile; a stable
  public shape needs evidence from real use.
- **A swap that hands back its `Run`.** `crumple.swap(spriteKey, src, o?)` beside `play`, returning
  the handle the declarative path cannot (§5.3). The hazard is the reason it is not in v1: two ways
  to change the sprite, one declarative and one not, racing through the same sequence number, and a
  `spriteKey` prop that then disagrees with what is on screen for reasons other than a failure.
- **The versioned store primitive `index.ts` withholds.** A consumer cannot synchronise derived state
  through the binding's store without effects that trip `react-hooks/set-state-in-effect` (§5.5).
  Publishing a small primitive would make that seam available, but would also freeze its shape; it
  remains deliberately internal today.

The React DX execution schedule records four further deferrals (proposal §8 item 9 and §9.1):

- **#5 — tier-aware knob invalidation / `stage.invalidationOf`.** Every batch that wrote anything
  still bumps `knobEpoch`, and every crumple joins `prepare` off it (§4.3), even for a draw-only
  write. This optimization is core-blocked: `registry.invalidationOf(delta)` is internal and the
  stage exposes no equivalent. Public knob descriptors alone do not provide the registry's
  normalized mapping from written keys to their strongest invalidation tier, including shared
  keys. Measure first; if the cost matters, expose `stage.invalidationOf(patch)` from core and
  bump `knobEpoch` only for batches whose strongest tier is `front` or higher. A draw-tier write
  already redraws synchronously; skipping a necessary join would leave `View.frame` stale.
- **Two-to-three renders per drag frame.** The declarative path runs through `setKnobs`, a render,
  the effect's `stage.set` and `knobEpoch` bump, then the crumple's join/refresh and store bump.
  This remains a measure-first performance follow-up; the schedule adds no second imperative
  writer or store redesign to avoid those renders.
- **`shownAt`.** A landing timestamp paired with the proposed `Scene.readyAt` remains low value
  until a consumer asks. It would timestamp the bump that makes `shown` current, not measure
  acquisition or full swap completion: `shown` changes at the ball, while `pending`/`onSettle` now
  express settlement.
  The playground already times scene readiness to first successful settlement with `onReady` and
  `onSettle`; that consumer timing is distinct from a sprite-landing timestamp.
- **Second sizing layer in `packages/core/src/stage.ts`.** Additional recovery after managed sizing
  encounters a zero CSS box remains a separate core follow-up. P2 fixed the binding contract with
  a layout-effect refresh after React commits a non-null frame size. Core's `blitOut` already
  checks managed sizing on each subsequent blit, but does not arrange an extra draw after a
  skipped zero box; any explicit retry mechanism is deferred. The schedule chose the binding fix
  because that is where the frame-commit/redraw pairing was missing.

## 12. Open questions, and the failure this document keeps making

No open questions. The amendment in §5.3 is the only core contract amendment; the additive React
surface and `@paper-crumple/react/testing` subpath are shipped package additions covered by the
major-version compatibility promise.

What is worth recording instead is the defect this document produced eleven times across four review
passes, because a fifth is likelier than not and the reader who finds it should recognise it
immediately:

> **A behaviour declared with nothing to implement it from.**

Caught so far, in order:

1. `<Crumple>` frames "when the scene was built with `artworkCssPx`" — a number written inside the
   consumer's own `create`, never passing through the package, unreadable off a `BlitStage`.
2. `<Crumple>` applies the `frameTo` scale — an option of the *hook*, on an instance that never
   carried it, handed to a component whose only argument is that instance.
3. The **scene** joins `prepare` and re-frames after a knob write — with no register of crumples to
   walk and no framing state of its own to update.
4. `SceneOptions.onError` is "the pre-mount form of `stage.on('error')`" — with no way to reach
   `StageOptions.onError`, since the consumer writes the `paperStage` call.
5. `view.on('error')` keeps `error` fresh — on a bus that carries only `start`, `step` and `end`.
6. `useSyncExternalStore` over four view events keeps the snapshot fresh — while the default
   entrance, every reduced-motion swap, every `draw`, every landed re-source and the whole ball park
   emit nothing at all.
7. "One bad key does not abandon the batch" — prescribed with the one `stage.set` shape that applies
   nothing when any key is invalid.
8. `size: 'manual'` is offered — with `width`/`height` excluded from `canvasProps` and never written
   by the core, so nobody can size the destination.
9. §7 restates defect 4 **after §4.1 had been corrected** — the same sentence, in the section nobody
   re-read, surviving the fix by two drafts.
10. `parked` is cleared "by the next `step`" — on a park that a `stop`, a supersession or an unmount
    ends, where the descent stepper is never created and no next `step` exists.
11. The in-flight map makes a shared acquisition safe — while `reserved` is private to the core, so
    the map cannot see an `add` the consumer started through `scene.stage`, which §11 invites.

They share one shape: a sentence naming an actor and a behaviour, written without asking what that
actor is holding at that moment. Three things the list shows that no single finding does:

- **1–3 are one behaviour, restated twice after being fixed.** A fix that moves a responsibility
  moves the defect with it unless the new holder is checked too.
- **4–8 were invisible to two passes that read only this document.** Each turns on a fact living in
  the core's source, and each reads as obviously true on the page.
- **9 is the nastiest, and is a review-process defect rather than a design one.** A claim corrected
  in §4.1 stayed wrong in §7 because both passes reviewed section by section. Grep the whole document
  for the *claim*, not for the section.

Three checks catch them, and all three are mechanical:

- **Name the actor, then list what it holds.** If the behaviour needs something absent from that
  list, the sentence is fiction. For this package the lists are short: a component holds its `value`
  and its DOM props; a hook holds its own options plus the scene; the scene holds the stage and
  nothing about the crumples attached to it.
- **For every claim about the core, open the core.** Findings 5, 6 and 7 each read as obviously true
  and each is contradicted by a docblock in `packages/core/src` that says the opposite in plain
  words. A design that wraps another package cannot be reviewed against itself alone.
- **After fixing a claim, grep for it.** Finding 9 cost nothing to prevent and survived two passes.
