# Usage: `@paper-crumple/react`

Status: **written from the design, reconciled against the shipped package.** `@paper-crumple/react`
is built, merged, and consumed by `examples/playground` — the first real consumer. Every hook,
component, option and return type below was taken from
`docs/superpowers/specs/2026-09-06-paper-crumple-react-design.md` and has since been checked against
`packages/react/src/**`.

What that check covered, so you know what the claims are worth. **Every consumer-facing code sample
in this document has been compiled against the published types** — the imports resolve, the option
names and types are the real ones, and the shape each sample destructures is the shape the package
returns; the `SceneOptions` / `Scene` / `CrumpleOptions` / `Crumple` listings were checked for
assignability in both directions against the exported types, so they are neither narrower nor wider
than what ships. The behavioural claims were read against the source and against the suite in
`packages/react/src/**/*.test.tsx`, which pins most of them by name. **What was not done is running
any of it in a browser**: the GL behaviour these samples describe rests on the package's own tests,
not on this document. The four *internal* listings — `useEvent`, `acquire`, the reduced-motion
branch, and the entrance's three calls — mirror `packages/react/src/use-event.ts`, `acquire.ts` and
`use-crumple.ts` but are trimmed for reading and are not compiled; treat them as an account of the
behaviour, not as the code.

The current consumer supplies no exercise for these documented behaviors: `useScene()` without an
explicit scene, `scene.play`, `entrance: 'uncrumple'`, `onStart`, `reducedMotion: 'off'`,
`canvasProps`, the `children` placeholder, `pin`/`ImageBitmap`, and SSR. This is consumer-coverage
status, not a claim that the package tests are absent; the playground coverage work is separately
owned by P7.

The additive core amendment this document was written to anticipate — a `SwapToOptions` interface
carrying `key`, which `view.swapTo` takes in place of `SwapOptions` — **has shipped**, with the
binding, in the form described here. It is exported from the core's barrel
(`packages/core/src/index.ts:133`) and declared at `packages/core/src/view.ts:28`. Everywhere it is
load-bearing it is still called out by name rather than quietly assumed — see
[The swap](#6-the-swap-the-headline).

Where the binding was found *wanting* by that first consumer, the gaps are recorded in
[`docs/design/2026-09-06-react-binding-findings.md`](./design/2026-09-06-react-binding-findings.md)
and are not restated here: this document describes what the package does, and that one describes
what a real application then had to write for itself.

Two citation styles appear below and they point at different documents. **`§n`** is a section of the
React design spec above. **`packages §n`** is a section of
`docs/superpowers/specs/2026-08-26-paper-crumple-packages-design.md`, which is the spec
[`docs/USAGE.md`](./USAGE.md) is written from. File-and-line citations point at the core source in
this repository and were re-anchored against it when this document was reconciled.

**Read [`docs/USAGE.md`](./USAGE.md) first.** This document does not restate the convention, the
dwell arithmetic, the knob reference or the error taxonomy; it says what React changes about them,
and it assumes you already know that every call returns `Error | T` and that cancellation is a
sentinel.

## Install and peer dependencies

```sh
npm i @paper-crumple/react @paper-crumple/core @paper-crumple/paper @paper-crumple/motion react
```

```tsx
import * as pc from '@paper-crumple/core'
import { paperSheet } from '@paper-crumple/paper'
import { tiles } from '@paper-crumple/paper/tiles'
import { bakedMotion } from '@paper-crumple/motion'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import { usePaperScene, PaperScene, useScene, useCrumple, Crumple } from '@paper-crumple/react'
```

**`@paper-crumple/core` and `react` are peer dependencies of this package, both of them, and it has
no runtime dependencies at all** (§3):

```json
"dependencies": {},
"peerDependencies": {
  "@paper-crumple/core": "workspace:^",
  "react": "^19",
  "typescript": ">=5.0"
},
"peerDependenciesMeta": { "typescript": { "optional": true } }
```

That is the manifest as it stands in the repository: `workspace:^` is rewritten to the published
version range on release, so an installed copy reads `^1`. The third peer is an *optional* one and
carries no runtime weight — the package ships types, and declaring the compiler as a peer is what
lets a consumer's TypeScript version be checked rather than assumed.

USAGE.md states the rule this obeys: *"if you are publishing a wrapper around this library, declare
core in `peerDependencies` and never in `dependencies`, because that is the one install shape that
produces two copies."* This package is exactly that wrapper. Two copies of core mean two `GlError`
classes, and `err instanceof GlError` then returns `false` on an Error from the other copy —
narrowing a failure as a success value, on the most routine event in a scrolling grid (packages
§10.4). `react` is a peer for the ordinary reason: two Reacts are two dispatchers and no hook works
across the seam.

**The package calls `assertSingleCore()` for you, and it is not a guarantee.** `usePaperScene` calls
it once per build — so on every rebuild, not only the first — under
`globalThis.process?.env?.NODE_ENV !== 'production'`, **before `create`**, and a returned
`CoreDuplicateError` **fails the scene outright**: `status: 'failed'`, `error` set, and `create` is
never called (§3). USAGE is explicit that this is *"a startup failure, not a once-per-session console
warning"*, and refusing to build is what keeps §4.1's invariant intact — `error` is non-null exactly
when `status === 'failed'`, with no exception carved out for this case. The environment is read
through `globalThis` rather than as a bare `process` identifier, so the package needs no
`@types/node`; the cost is that a bundler's `process.env.NODE_ENV` define does not statically strip
the call, and an environment with no `process` at all is treated as development.

**But it catches the duplicate only when this package's copy of core lost the registration race.**
`checkSingleCore` returns `undefined` when the marker is the caller's own
(`packages/core/src/single-core.ts:43`) and registration is a module-load side effect
(`single-core.ts:53`), so if the copy `@paper-crumple/react` resolves registered first, its
`assertSingleCore()` is clean with two copies live — the *other* copy is the one that knows, and it
says so through the load-time `console.warn` (`single-core.ts:57`). The assertion is still worth
making here, because a wrapper is precisely the install shape that produces the duplicate. **What you
should not conclude is that a green scene proves you have one core.** If `instanceof` is behaving
strangely, check your lockfile before you check this package.

**`@paper-crumple/paper` and `@paper-crumple/motion` are not imported by this package at all**, not
even as types (§3). You write the `paperStage(...)` call yourself inside `create`, so `sheet` and
`motion` reach the stage without passing through any type this package declares. That is what keeps
the binding usable with a custom sheet or a custom motion slot, and it is why the install line above
still names four packages.

### Local development via `pnpm link`

Consuming this package from a checkout of this monorepo, before anything is published, works the
same way any pnpm workspace package can be linked out — with one thing to get right. `dist/` is
gitignored and not built by default, so build the family first:

```sh
pnpm install && pnpm build   # from the repo root; builds core, paper, motion, react (turbo)
```

Then, from each package directory you want to consume, register it with the target project by
path — `pnpm link <absolute-or-relative-path-to-the-package>`, run from the consuming project:

```sh
# from your other project:
pnpm link ../paper-crumple/packages/react
pnpm link ../paper-crumple/packages/core     # required — see below
```

**Link `@paper-crumple/core` alongside `@paper-crumple/react`, not just `react` by itself.** Inside
this workspace, pnpm resolves `"@paper-crumple/core": "workspace:^"` to the sibling package
automatically; that rewrite only happens at `pnpm publish` time. A `pnpm link` from *outside* the
workspace does not perform it, so an external consumer who links only `packages/react` gets a real,
working `@paper-crumple/react` whose own `import … from "@paper-crumple/core"` has nothing to
resolve against — confirmed by linking react alone into a scratch project: it imports fine, but
`@paper-crumple/core` is `MODULE_NOT_FOUND` until it is linked too. Link `packages/paper` and
`packages/motion` the same way if your app imports them directly (as most apps will, since `react`
does not import either — see above). All symlinks a consuming project creates this way land flat in
its own `node_modules/@paper-crumple/*`, so `core`, `motion`, `paper` and `react` all resolve back
to the *same* checkout and therefore the same `@paper-crumple/core` module instance —
`assertSingleCore()` stays happy, the same way pnpm's own workspace symlinking keeps it happy inside
this repo.

pnpm additionally warns on each `link` that "the linked in dependency will not resolve the peer
dependencies from the target node_modules" — that is the warning describing exactly the situation
above, and linking `core` (and `paper`/`motion` as needed) is how you resolve it. `pnpm link --global`
(the two-step global-store form) is not required for this and was flaky in testing on Windows; the
direct path form (`pnpm link <path>`) worked reliably and is what is shown here.

Re-run `pnpm build` in this repo after a source change; a linked package is a symlink to `dist/`, not
to `src/`, so a consumer sees the rebuilt output on its next reload with no re-link needed.

**React 19 only.** The range `^18.3 || ^19` was considered and rejected (§3). The ref-callback
cleanup function is what gives a view a life exactly as long as its canvas element; on 18 that
becomes a `useEffect` over a manually mirrored ref, plus `forwardRef`, plus a hand-rolled
`useEffectEvent` at every subscription — the cost paid in the exact places where the lifetime bugs
live.

`@paper-crumple/react` joins the Changesets `fixed` array with the other three, so all four ship one
version number. It exports `.` and `./testing`. There is no other subpath split — packages §3.2's
argument for one is about asset weight in packs and tiles, and none of it applies to a binding.

## The shape of the API, in one paragraph

**Hooks carry the logic and return instances; components render DOM and take an instance** (§2). The
dividing test, applied to every option in this document: *a parameter belongs to the hook if changing
it means calling into `@paper-crumple/core`; it belongs to the component if changing it only changes
what the browser paints around the canvas.* The seam between the two is a stable callback `ref` on
the instance, which is what makes both usages the same code:

```tsx
const hero = useCrumple({ spriteKey: 'hero', src, entrance: 'uncrumple' })

<canvas ref={hero.ref} className="tile" />   // drive it yourself
<Crumple value={hero} className="tile" />    // or hand it to the component
```

`fit` is the case that proves the rule is not about intuition (§2): it looks like a CSS concern, but
it is fixed at `stage.view()` and cannot be changed afterwards, so it is a hook option and never a
prop.

**`fit` and `tag` are fixed when the view is created, and changing them later does nothing** — `tag`
is written at `stage.view()` (`packages/core/src/stage.ts:1471`) and `View.tag` is a read-only
accessor (`view.ts:86`). Because the `ref` that creates the view is identity-stable (next section),
the creating callback is not re-invoked, so **a changed `fit` or `tag` is ignored and warns once in
development until the view is rebuilt.** If these must vary, remount the owner under a different
React `key` to create a view with the new fixed values.

## 1. Every function this package hands you is identity-stable

This is the section a consumer writing their own `Tile` most needs, so it comes before the API.

**`useEvent` is a package-wide convention, applied without exception** (§2.1): to the instance methods
(`play`, `stop`, `refresh`), to `ref`, to every callback you hand the binding (`onStart`, `onEnd`,
`onError`) and to `SceneOptions.create`. The latest function is mirrored into a ref inside a
`useLayoutEffect`, and what you are handed is a wrapper whose identity never changes:

```ts
function useEvent<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...a: A) => ref.current(...a), [])
}
```

The mirror is written in a layout effect and **never during render**: a render React discards — a
concurrent one, or StrictMode's second pass — must not publish its closure, and only a commit that
actually happened may.

**For `ref` this is correctness, not ergonomics.** React's own rule is that unless the same function
reference is passed every render, *"the callback will temporarily clean up and re-create during every
re-render"*. An unstable `crumple.ref` would therefore **dispose the view and build a new one on every
render** — `view.dispose()` followed by `stage.view()` on the element it just released, cancelling
every run in flight. It would not even raise the claimed-canvas refusal, because the cleanup runs
first and `dispose` releases the element's claim (`stage.ts:1562`). The defect is silent churn, which
is worse than an error, and the whole lifetime rule in §5.2 rests on that identity holding still.

What this buys you in practice:

- **Put `crumple.play` in a dependency array and it will not churn.** So can `crumple.ref`, `stop`,
  `refresh`, and any callback you passed in.
- **An inline arrow is fine everywhere.** `onEnd={(e) => …}` written fresh each render is mirrored,
  not re-subscribed, and a run started before you replaced it calls the newest form.
- **`create` is read the same way, and the consequence is worth stating**: a `create` that closes
  over a changed `sheet` **does not rebuild**. It is used by the next rebuild `deps` asks for. That
  is §4.1's contract, not an accident of the pattern.

The crumple methods `draw`, `sync`, and `retry`, the crumple option callback `onSettle`, and the
scene option callbacks `onReady`, `onFailed`, and `onKnobRefused` are identity-stable. `create` and
`onError` are already `useEvent`-wrapped, so consumer
`useCallback` wrappers around them are unnecessary. If the installed `react-hooks/exhaustive-deps`
analyser does not recognise a member expression, destructure the called member first, for example
`const { stop } = scene`, and use that variable in the dependency array.

**`Scene` is memoised and changes identity only when one of its fields does** (§2.1) — it has to be,
because it is the value of `<PaperScene value={scene}>` and every `useCrumple` reads it through
`useScene()`. A fresh identity per render would re-render the whole subtree and re-run every crumple
effect. Internally the crumples depend on `scene.stage`, `scene.status`, `scene.generation` and
`scene.knobEpoch` rather than on `scene`, so a warning arriving does not rebuild a view — and **you
should do the same**.

**The `Crumple` object itself is deliberately not stable.** It carries the reactive snapshot, so it is
a fresh object per render by construction. **Depend on `crumple.shown` or on `crumple.play`, never on
`crumple`.**

## 2. The scene

### `usePaperScene`

```ts
interface SceneBuild<M> {
  readonly stage: pc.BlitStage
  readonly meta: M
}

interface SceneCounters {
  readonly warnings: readonly Error[]
  readonly lost: boolean
  readonly generation: number
  readonly knobEpoch: number
}

interface SceneOptions<M = undefined> {
  create: (
    signal: AbortSignal,
    onError: StageErrorListener,
  ) => Promise<SceneBuild<M> | pc.BlitStage | Error | pc.Aborted>
  deps: readonly unknown[]
  knobs?: pc.Knobs
  onError?: StageErrorListener
  onReady?: (
    build: SceneBuild<M>,
    info: { generation: number; signal: AbortSignal },
  ) => void
  onFailed?: (error: Error, info: { lost: boolean; generation: number }) => void
  onKnobRefused?: (key: string, value: pc.Knobs[string], error: Error) => void
}

type SceneSnapshot<M = undefined> = SceneCounters &
  (
    | { readonly status: 'building'; readonly stage: null; readonly meta: null; readonly error: null }
    | { readonly status: 'ready'; readonly stage: pc.BlitStage; readonly meta: M; readonly error: null }
    | { readonly status: 'failed'; readonly stage: null; readonly meta: null; readonly error: Error }
  )

interface SceneMethods {
  play(from: pc.PoseRef, to: pc.PoseRef, o?: pc.StagePlayOptions): Promise<pc.StagePlayReport<pc.View>>
  stop(o?: { all?: boolean }): void
}

type Scene<M = undefined> = SceneSnapshot<M> & SceneMethods
type CreateStage<M = undefined> = SceneOptions<M>['create']
type StageErrorListener = (e: pc.StageEvent<'error'>) => void

function usePaperScene<M = undefined>(options: SceneOptions<M>): Scene<M>
function usePaperScene<M = undefined>(
  create: CreateStage<M>,
  deps: readonly unknown[],
  options?: Omit<SceneOptions<M>, 'create' | 'deps'>,
): Scene<M>
```

`meta` is non-null exactly in the `ready` branch and is cleared beside `stage` on rebuild, failure,
and context loss. Use it to retain the artifacts that produced the current stage:

```tsx
type BuildMeta = {
  sheet: ReturnType<typeof paperSheet>
  motion: ReturnType<typeof bakedMotion>
}

const create: CreateStage<BuildMeta> = async (signal, onError) => {
  const sheet = paperSheet({ tiles })
  const motion = bakedMotion({ packs: [pack2x3] })
  const stage = await pc.paperStage({ present: 'blit', cssPx: 512, sheet, motion, signal, onError })
  if (stage instanceof Error || pc.isAborted(stage)) return stage
  return { stage, meta: { sheet, motion } }
}

const scene = usePaperScene(create, [], {
  onReady: ({ meta }, { signal }) => {
    if (!signal.aborted) console.info('scene ready', meta.sheet)
  },
  onFailed: (error, { lost }) => console.error(lost ? 'context lost' : 'build failed', error),
})
```

`onReady` fires synchronously after the ready bump and before React re-renders. Its signal aborts on
rebuild or unmount; no cleanup return is used. `onFailed` covers returned or thrown `create` errors,
duplicate-core failure, and context loss. Its generation is the lost build when `lost: true`, and
otherwise the last successful generation.

`onKnobRefused(key, value, error)` is the key-carrying callback for a refused declarative write;
`onError` still receives the stage event. For a synchronous escape hatch, use `scene.stage.set(...)`.
The positional overload is the `react-hooks/exhaustive-deps`-checkable form:

```tsx
const scene = usePaperScene(create, [edgeShape, quality], {
  knobs,
  onKnobRefused: (key, value, error) => console.warn('knob refused', key, value, error),
})
```

You write the factory call yourself, and **both** parameters you are handed go into it:

```tsx
function Gallery({ edgeShape }: { edgeShape: 'torn' | 'smooth' }) {
  const scene = usePaperScene({
    create: (signal, onError) =>
      pc.paperStage({
        sheet: paperSheet({ edgeShape, edgeFinish: 'paper', tiles }),
        motion: bakedMotion({ packs: [pack2x3] }),
        cssPx: 192,
        budget: 64 * 1024 * 1024,
        present: 'blit', // this literal selects the BlitStage overload
        onError, // the PRE-MOUNT error channel — see below
        signal, // an aborted factory disposes what it built and returns ABORTED
      }),
    deps: [edgeShape],
    onError: ({ error, view, observed }) => {
      // packages §10.6 — the orphan channel. `observed: true` means the error is, or will be, a
      // return value someone can narrow, so reporting it here as well double-counts it.
      if (!observed) report(error, view)
    },
  })

  if (scene.status === 'failed') return <Broken error={scene.error} lost={scene.lost} />
  return <PaperScene value={scene}>{/* … */}</PaperScene>
}
```

**`create`'s second parameter is not a convenience** (§4.1). `StageOptions.onError` exists because *"a
listener attached after the factory resolves cannot observe an error raised inside it"*
(`stage.ts:281`), and the core wires it before the surface exists (`stage.ts:283`). But **you** write
the `paperStage(...)` call, so the binding has no way to reach that option — it could only call
`stage.on('error')` after `create` resolves, which is exactly the window the option exists to cover.
Spreading `onError` into your factory call is what closes it.

Dropping the parameter is legal and costs you only the pre-mount window; everything raised after the
factory resolves still reaches `SceneOptions.onError`, because the binding attaches
`stage.on('error')` as well. **Nothing is ever delivered twice**: the handed-down listener is
registered on the stage's bus permanently by the core (`stage.ts:283`) and cannot be detached, so the
binding stops forwarding through it the moment `create` resolves, and `stage.on('error')` takes over
from there.

**The effect's cleanup aborts the in-flight build *and* disposes a landed one** (§4.1), and the
distinction is one you inherit rather than write. The core's own guarantee covers only the loser of a
StrictMode double-invocation: a resolved stage never looks at the signal again — it is consulted only
at the factory's own checkpoints (`stage.ts:277, 327, 345, 434`) and no `abort` listener outlives
them — so **a stage that resolved and was then superseded by a `deps` change is released only by an
explicit `dispose()`.** Read the core's constraint as "cleanup is handled" and you leak one WebGL2
context per rebuild, against the ceiling of roughly sixteen that the constraint exists to protect.
The binding does both. You write neither.

**A rebuild is decided by `deps` and by nothing else** (§4.1). Structural comparison of the options
bag was designed and rejected, and the reason is worth stating as a trap rather than a preference:
`sheet` and `motion` are objects returned by factory calls, so a consumer who forgot a `useMemo` would
build a fresh WebGL2 context on **every render**, and the failure mode is not a visible error — it is
a browser quietly running out of contexts several seconds later. An explicit key is the only form in
which the expensive thing happens exactly when you said it should. Put in `deps` the values your
`create` closure actually reads, and nothing else.

**A rebuild is not a reset** (§4.1). The knobs you have moved are re-applied to the new stage once it
is up, and a key the new slot set no longer declares — a `torn`-only knob after a switch to `smooth` —
is skipped rather than reported. `generation` is bumped on every landed build, and it is the
dependency to hang any imperative re-read on.

**`play` and `stop` on a scene that is not `ready` are not errors and do not queue** (§4.1): `stop`
is a no-op and `play` resolves to an empty report — no views, nothing skipped, nothing failed, and
**`completed: false`**, which is what a broadcast over zero eligible views reports
(`packages/core/src/collisions.ts:133`, `stage.ts:2195`) — *"reporting `true` for a wave that never
happened is the one answer a consumer cannot act on"*. `stage.play` never returns an Error and never
rejects (packages §4.4), and the binding does not become the first place in the family where a wave
can fail.

### `lost`, and why it fails the scene

**A lost context moves the scene to `status: 'failed'`, carrying the `GlError`** (§5.5). This is not
severity theatre. After a loss the core's `dead()` guard makes every stage method return that error —
`view()`, `add`, `prepare`, `set`, `replace`, `remove`, `mount` (`stage.ts:951`) — so a `Scene`
reporting `ready` with a non-null `stage` would be handing you a stage on which nothing works.

`lost` stays a separate boolean because `failed` alone does not say *why*, and a consumer offering a
"reload" affordance needs to tell a lost context from a build that never came up:

```tsx
if (scene.status === 'failed') {
  return scene.lost ? <ReloadPrompt /> : <Broken error={scene.error} />
}
```

Each `Crumple` learns about it **from the scene, not from the event** (§5.5): the loss `GlError` is
orphaned with `view: null` (`stage.ts:427`), so no per-view filter would ever see it. A scene that
leaves `ready` detaches its views, which is the `'detached'` state and the `children` placeholder
again — the tiles come back as placeholders rather than staying on screen as dead canvases.

`warnings` mirrors `stage.warnings` and is re-read on every store bump, not captured once: it **grows
at runtime** (`stage.ts:942`, `stage.ts:1881`). Degradation is a value, not a rejection (packages §4)
— a paper tile that failed to fetch leaves a usable stage that renders without grain.

### `PaperScene` and `useScene`

```tsx
<PaperScene value={scene}>{children}</PaperScene>
```

A context provider and nothing else — **it renders no DOM** (§4.2). `useScene()` reads it, and
`useCrumple` uses what it finds unless you pass an explicit `scene` option, which is the escape hatch
for two scenes on one page. (The hook is called either way — it is the value that is ignored, not the
call.)

`useScene()` outside a provider **returns a permanently-`failed` scene carrying an Error rather than
throwing** (§4.2). Nothing in this package throws; see [Errors](#12-errors).

## 3. The grid — the main scenario

N tiles, N `<canvas>` elements, one WebGL2 context — the same headline as USAGE §1, with React owning
the elements. **The grid is a consumer-written child component**, and that is the shape, not a
suggestion:

```tsx
function Tile({ item }: { item: Item }) {
  const crumple = useCrumple({ spriteKey: item.id, src: item.url, tag: item.id })
  return (
    <Crumple value={crumple} className="tile" onClick={() => crumple.play('flat', 'ball')}>
      {crumple.shown === null ? <Skeleton /> : null}
    </Crumple>
  )
}

function Grid({ items, scene }: { items: Item[]; scene: Scene }) {
  return (
    <PaperScene value={scene}>
      <div className="grid">
        {items.map((item) => (
          <Tile key={item.id} item={item} />
        ))}
      </div>
    </PaperScene>
  )
}
```

`tag` is what makes a `scene.play()` report entry correlatable without a reverse `Map<View, id>`
(packages §7.1), and it is the one place the item's identity has to be repeated.

A wave across the whole grid is one call on the scene:

```tsx
const report = await scene.play('flat', 'ball', { duration: 900, stagger: 40 })
// wall time = duration + (n − 1) × stagger; `duration` is PER VIEW.
for (const { view, reason } of report.skipped) console.info('skipped', view.tag, reason)
for (const { view, error } of report.failed) console.error(view.tag, error)
```

**There is no options-taking form of `<Crumple>`, and there is no `useCrumples(items)` list hook.**
Both were designed and rejected (§2), and the reasons are the ones that would otherwise be
rediscovered by writing them:

- An options-taking `<Crumple spriteKey=… src=… />` would state the configuration in two places, and
  it would give the grid an imperative path (`ref.current`, **null on the first render**) that
  behaves differently from the instance path, which is never null.
- A list hook would have to write its own list reconciliation — a new key creates an instance, a
  departed one disposes a view — which is precisely what React already does by mounting and
  unmounting `Tile`, only by hand and *around* React's own mechanism. It buys one subscription, and
  it cannot create a view early anyway, because **a view is born when the canvas ref attaches**, not
  when the hook runs.

**Two `Tile`s may share a `spriteKey` and it costs one fetch, not two.** That is the in-flight map in
[the acquisition shape](#the-acquisition-shape-behind-every-sprite), and it is the reason a detail
panel opened over a grid tile costs no fetch at all.

### Lifetime

The view exists exactly when **both** conditions hold: the scene is `ready`, and a canvas element is
attached (§5.2). It is created by whichever of the two completes the pair, and disposed in the ref
cleanup or when the scene leaves `ready`. `state` reads `'detached'` while no view exists — the one
value this binding adds to the core's seven.

Disposal in the **ref's cleanup** rather than in a later effect is load-bearing, and the core says so
itself. The `ViewError` for a claimed canvas names React out loud:

> "that element already has a live view. […] Dispose the first; React runs a cleanup before the
> second effect, so StrictMode does not trip this." — `packages/core/src/stage.ts:2349`

On the other end, `view.dispose()` *"leaves the element's last blitted pixels in place; the element
itself is the consumer's"* (`packages/core/src/view.ts:131`) — which is exactly the behaviour a React
unmount wants, and why an unmounting tile does not flash white.

Cleanup order does not matter in either direction. `dispose()` is idempotent and `show(null)` /
`remove()` on a disposed stage are no-ops (packages §4.6), which is what lets a `Crumple` outlive or
predecease its `PaperScene` under a concurrent route change.

**Across a scene rebuild the sprite is re-acquired and the entrance replays** (§5.2), and there is no
cheaper option to choose between: a rebuilt stage is a new GL context with **no sprites in it**, so
there is nothing to re-`show` and the acquisition has to happen again anyway. What that means for your
render: `requested` survives the rebuild — it is your prop, not library state — while `shown` returns
to `null` until the new sprite lands, which is exactly the window in which `children` renders again. A
placeholder written as `shown === null ? <Skeleton /> : null` therefore reappears for a rebuild
without your doing anything.

## 4. `useCrumple`

```ts
type CrumpleOptions<S extends pc.SpriteSource> = {
  spriteKey: string
  src: S
  scene?: Scene // defaults to useScene()
  fit?: pc.Fit // fixed at stage.view(); not a prop
  tag?: string
  entrance?: 'flat' | 'uncrumple' // default 'flat'
  /** Wall time in MILLISECONDS for the whole traversal — not a multiplier. Applies to every run
   *  this hook starts, the entrance and the swap alike. */
  duration?: number
  /** The CSS long side the ARTWORK should hold on screen. Absent — the default — means the hook
   *  reports `frame` and applies nothing. */
  frameTo?: number
  reducedMotion?: 'auto' | 'off' // default 'auto'
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

interface Crumple {
  readonly ref: (el: HTMLCanvasElement | null) => void
  readonly state: pc.ViewState | 'detached'
  readonly status:
    | 'detached'
    | 'empty'
    | 'acquiring'
    | 'shown'
    | 'playing'
    | 'swapping'
    | 'rolled-back'
  readonly sprite: pc.Sprite | null
  readonly pending:
    | { readonly key: string; readonly phase: 'acquiring'; readonly run: null }
    | { readonly key: string; readonly phase: 'entering'; readonly run: pc.Run<pc.PlayResult> }
    | { readonly key: string; readonly phase: 'swapping'; readonly run: pc.Run<pc.SwapResult> }
    | null
  /** The swap is parked at the ball, waiting on its target. */
  readonly parked: boolean
  readonly pose: number // 0 while detached — 'flat', the pose a view is born at
  readonly shown: string | null // view.sprite?.key ?? null
  readonly requested: string | null // the spriteKey last asked for
  readonly error: Error | null
  readonly frame: pc.ViewFrame | null
  /** `frame` already scaled by `frameTo` into the four CSS numbers <Crumple> writes on the
   *  wrapper. `null` when `frameTo` was absent or no front is resident. */
  readonly frameStyle: { width: string; height: string; left: string; top: string } | null
  readonly artworkStyle: { readonly width: string; readonly height: string } | null
  readonly view: pc.View | null // raw, so an unforeseen scenario stays reachable
  play(from: pc.PoseRef, to: pc.PoseRef, o?: pc.PlayOptions): pc.Run<pc.PlayResult> | null
  stop(): void
  draw(pose: pc.PoseRef): void
  sync(): void
  retry(): void
  refresh(): void
}

function useCrumple<S extends pc.SpriteSource>(o: CrumpleOptions<S>): Crumple
```

**The hook is generic in the source, and `pin` is intersected through `pc.PinFor<S>`** (§5.1) exactly
as the core's own `AddOptions` does (`stage.ts:96`). So a bare `ImageBitmap` **written at the call
site** fails to typecheck without `pin: true`, instead of typechecking and then failing at runtime
with the `AssetError` the core raises for a source no re-supplier can be derived from
(`stage.ts:1816`):

```tsx
const bitmap = useCrumple({ spriteKey: 'hero', src: myImageBitmap, pin: true })
//                                                                 ^ required, and the compiler says so
```

`File` is a `Blob`, so it may be passed directly as `src`; do not create an object URL:

```tsx
function useDroppedPaper(file: File, dropId: number): Crumple {
  return useCrumple({ spriteKey: `dropped-${dropId}`, src: file })
}
```

Keep a unique key because two files with the same filename can still be different pictures.

The qualifier is the core's own: a source widened to the whole `SpriteSource` union — read out of a
data model rather than written at the call site — passes the tuple test and reaches the runtime check
instead (`source.ts:61-65`). The binding inherits that hole exactly, neither widening it nor claiming
to close it. **Losing `pin` at this seam would have made the React path the one place in the family
where the byte budget silently stops bounding anything.**

**`size` is not an option, and v1 is always `'managed'`** (§5.1). Offering `'manual'` would have been
a promise with nothing behind it: under `'manual'` the core never writes `canvas.width/height`
(`stage.ts:1059` guards on `'managed'`), and `canvasProps` excludes those attributes (below),
so the destination would sit at its stock 300×150 with nobody able to size it. Rather than reopen the
attribute and make the two settings mean opposite things about who owns the element, `'manual'` is
deferred and the escape hatch is the raw `scene.stage.view()`.

**`duration` is wall time in milliseconds for the whole traversal — not a multiplier** (§5.1), and it
applies to every run the hook starts: the entrance, the swap, **and `crumple.play` itself**, which
passes the hook's value unless that call carries its own. The ball hold is scaled with it; the only
thing not scaled is the excess a slow fetch adds on top of that hold
(`dwell.ts:213`, `runner.ts:502`). Pass a per-run value through
`crumple.play(from, to, { duration })` when one run needs to differ — that one is the core's own
`PlayOptions.duration`, and USAGE's dwell arithmetic applies to it unchanged.

**`onError` takes a `pc.StageEvent<'error'>`, not a `pc.Events['error']`** (§5.1), and the reason is a
fact about the core rather than a preference: **a view's bus carries exactly `start`, `step` and
`end`.** An error takes packages §10.6's route straight onto the *stage's* bus (`stage.ts:1109`), so
`view.on('error', …)` compiles and is silently dead. The binding subscribes on the stage and filters
to this view.

`play` returns the `Run`, `null` while detached, and **is a plain function — never `async`, and never
wrapped in one** (§5.1). `start` is emitted synchronously inside `view.play`, and an `async` wrapper
is exactly where that guarantee is lost; an `AudioContext.resume()` in a start handler only runs
inside the user gesture because of it (packages §7.1).

`pending` is the request for the current `(view, spriteKey)` until it settles, and is `null` when idle.
`onSettle` fires exactly once for a request that reaches animated completion, degraded show, or rollback,
and never for a superseded or unmounted request. `CrumpleSettleEvent.reduced` says whether reduced-motion
accommodation applied to that request, not merely whether an animation happened.

During an animated swap, core adopts the target at the ball. Therefore `shown` and `sprite` become the
target while descent is still running; neither means “settled”. Read `pending` or handle `onSettle` for
that decision. `parked` is true for the wait at the ball and is cleared on end, stop/supersession, and
disposal. It is safe for the swap spinner now; reduced motion never parks because it degrades to `show()`.

**Compare against `crumple.requested`, never `crumple.shown`.** `shown` can be the target from the ball
onward and can differ after rollback; `requested` records the key the driver already considered.

Use `onSettle` for transport completion:

```tsx
const crumple = useCrumple({
  spriteKey: selected.id,
  src: selected.src,
  onSettle: ({ key, error, reduced }) => {
    console.info('request settled', { key, failed: error !== null, reduced })
  },
})
```

Keep `onEnd` for consumers that genuinely need the view-run event; do not combine animated `onEnd`
with an effect over `shown` to infer request settlement.

`requested` and `shown` are separate because they genuinely diverge (§5.1). A swap whose target fails
**rolls back to the previous sprite** — `state === 'crumpling.recover'`, and the `Run<SwapResult>`
returns the target's Error — so the prop says B while the canvas shows A. The instance reports both
and the Error, which also reaches your `onError` with `observed: true`, since it is on
`crumple.error` as well. **The binding does not retry automatically; for an explicit retry, call
`crumple.retry()`.**

**`error` reports the last settled run, and is cleared when the next one starts** — on `start`, not
on `end` (§5.1). That is the difference between a field you can render and one you cannot: a rollback
notice built on `error !== null` disappears the moment the reader's next interaction begins, rather
than a fold later. **It does not latch until unmount.** A latching field would make `error !== null`
mean "something once went wrong", which is not a state any UI has a rendering for.

## 5. Reactive state, and why it is not event-driven

`state`, `status`, `parked`, `pose`, `shown`, `sprite`, `requested`, `pending`, `error`, `frame`,
`frameStyle`, `artworkStyle` and `view` are served
through `useSyncExternalStore`, over a store **the binding versions on every call it makes into the
core** (§5.5) — `view.show`, `view.draw`, `view.refresh`, `view.play`, `view.stop`, `view.swapTo`,
`view.crumpleTo`, view creation and disposal, and the settlement of a `stage.prepare` — **and** on
every Error it reports, **and** by the three real view events, **and** by `stage.on('error')`
filtered to this view.

**Events are a supplementary source, not the source**, and this is worth understanding rather than
taking on trust, because the gap is not an edge case — it is the default path:

- **`view.show()` emits nothing on an idle view.** `transition(…, 'show')` carries `emits: live`
  (`packages/core/src/view-state.ts:120`) and `live` is false when the view is idle. So
  `entrance: 'flat'` — the default — and every reduced-motion swap move `view.sprite` from `null` to
  a sprite **with no event at all**. On an event-driven store `shown` would stay `null` forever and
  your placeholder would never lift.
- **`view.draw()` emits nothing** (`emits: false`, `view-state.ts:107`) while moving `view.pose`, so
  the `draw('ball')` of `entrance: 'uncrumple'` is invisible.
- **A landed re-source emits nothing.** `invalidateSpriteAt` ends in `v.refresh()`
  (`stage.ts:899-921`), and `refresh` is event-free by design — so "re-frame once the re-source has
  landed" has no event to hang on.
- **`crumpling.ball` is never observable.** The core sets it in the rise stepper's `onDone`
  (`runner.ts:498`) — after the rise's last `step`, before the descent's first — so for the entire
  park, which is the whole point of the ball, a listener reads `crumpling.rise`.
- **`error` never reaches a view's bus at all**, as above.

That last one is why `parked` exists as its own field rather than as `state === 'crumpling.ball'`.
**Branch a spinner on `crumple.parked`, not on the state name:**

```tsx
{crumple.parked ? <Spinner /> : null}                              // waiting on the swap's target
{crumple.state === 'crumpling.recover' ? <Toast>rolled back</Toast> : null}
{crumple.shown === null ? <Skeleton /> : null}                     // no sprite yet, or detached
```

`parked` is maintained from what the events do carry: a swap's `start` reports `via`, the resolved
ball index, and the run is parked from the `step` whose `pose === via`. **It is cleared by `end` and
by `start`, not merely by the next `step`** — a park cut short by `view.stop()`, by supersession or by
`dispose()` never reaches a descent step at all (`runner.ts:184-195`, `runner.ts:467`), so a
"until the next step" rule would latch `parked` at `true` for the rest of the component's life on
every stopped or unmounted swap.

`pose` is a **resolved numeric index**, never a name, and it reads `0` while detached — `'flat'`, the
pose a view is born at. `PoseRef` is an input type only (packages §10.1), so `crumple.pose === 'ball'`
is rejected by TypeScript — the good case — and silently never true in JavaScript. Compare against a
resolved index, or pass a reported one straight back into `play`, which is what it is for.

`status` is derived, with `rolled-back` meaning `error !== null && requested !== shown`; it complements
rather than replaces core `state`. `sprite` is read in the same snapshot pass as `shown`, removing the
need to read `crumple.view?.sprite` during render.

**`onStart`, `onEnd` and `onError` are dispatched from those subscriptions; `onSettle` is emitted by
request settlement** (§5.5). All callbacks use §2.1's `useEvent` — never their own `view.on` calls.
Subscribing per callback would put your function's
identity in the effect's dependencies, so an inline arrow would tear down and re-attach every render;
omitting it from the dependencies is the stale-closure bug that replaces it. The convention has
neither.

### Imperative access

`play` / `stop` / `draw` / `sync` / `retry` cover the common imperative paths and `scene.stage` covers
everything else. `crumple.view` is the raw `pc.View`, deliberately exposed so an unforeseen scenario
stays reachable (§5.1) — `view.once`, `view.set`, and other unforeseen calls. `view.on('step', handler)`
is the correct run-cadence seam; no snapshot `step` field is promised.

```tsx
if (crumple.view === null) return
const audio = new Audio('/fold.mp3')
void audio.play()
const run = crumple.play('flat', 'ball', { duration: 900 })
if (run === null) return // assertion guard: the render snapshot said a view existed
const result = await run
if (result === pc.ABORTED) return
if (result instanceof Error) console.error(result)

crumple.stop() // freezes at the current pose and issues NO draw — a cancel path must not render
crumple.draw(pose) // one draw and one snapshot bump; no-op while detached
crumple.sync() // re-read after an otherwise-raw view call, without drawing
crumple.retry() // retry the current rolled-back key without key-away-and-back
```

Gate side effects before calling `play`: a `null` return is too late to undo audio or another side
effect. It means the view was detached and nothing else.

The binding reports no acquisition or ready-to-first-sprite timing. `onReady` is scene-ready timing,
`onStart` occurs after the sprite is resident, and neither measures the front bake; there is no
`shownAt` field.

`crumple.play` supersedes whatever the view was doing, including a `scene.play` wave — collisions are
decided by scope, not by method, and the narrower scope wins (packages §4.4).

## 6. The swap, the headline

**`spriteKey` is the trigger.** The swap fires when it changes; `src` is read as the source for the
new key, and nothing else about the render causes a swap.

**A request for the key already considered by the driver is refused before anything observable happens**,
and that is worth knowing before you build a transport on top of it: the hook returns before
`requested` moves,
before its sequence number advances, and before any library call — so no `add`, no run, no
`start` / `end`, and **no change to the snapshot at all**. From the outside "the request produced
silence" and "the request was never considered" are the same thing. The check is against
`crumple.requested`, not `crumple.shown`: after a rollback, the requested key can still be the failed
target while the shown key is the previous sprite. If you arm state when you ask for a swap — a
spinner, a fold direction, an audio sequence — make the same-key check yourself, before you arm it.

```tsx
function Hero({ selected }: { selected: Item }) {
  const crumple = useCrumple({
    spriteKey: selected.id,
    src: selected.url,
    entrance: 'uncrumple',
    duration: 900,
  })

  const rolledBack = crumple.error !== null && crumple.requested !== crumple.shown

  return (
    <Crumple value={crumple} className="hero">
      {crumple.shown === null ? <Skeleton /> : null}
      {crumple.parked ? <Spinner /> : null}
      {rolledBack ? (
        <Note>
          showing {crumple.shown} — {crumple.requested} failed
        </Note>
      ) : null}
    </Crumple>
  )
}
```

### The two core contracts that force this, and the amendment

Both are counter-intuitive enough to restate, because the design of this hook is unreadable without
them.

**`view.swapTo` mints its own key.** `packages/core/src/stage.ts:1429`:

```ts
const key = `swap:${presetForImageId(String(src))}:${String(swapCounter++)}`
```

The key is derived from the source so a caller swapping a URL in does not have to mint one — but
because the fold preset is `presetForImageId(key)` at fit time (`stage.ts:1663`), that monotonic
counter means **the minted path folds the same picture differently on every swap.** The docblock
above the mint says so, and says what to do instead: *"A consumer who wants a stable key passes
`o.key` (§5.3): the `add()` below runs under it, and a key already resident is adopted above without
an `add()` at all."*

**`add()` on a live key is refused** (`stage.ts:1798`) with a `SheetError`, because *"the hull cache
is keyed on (sprite key, sdfRes, hull knobs) and the bitmap is not in that key, so the new sprite
would inherit the old hull."*

Together those made a stable, caller-supplied key impossible through the `swapTo` that existed when
this package was designed. Hence the **additive core amendment** that shipped alongside it (§5.3) —
a new interface, not a widened one, at `packages/core/src/view.ts:28`:

```ts
/**
 * `swapTo`'s options ALONE (§5.3). `SwapOptions` above stays as it is — it is shared with
 * `crumpleTo`, which takes a `Sprite` rather than a source and for which a key is meaningless.
 * Widening the shared type would have added a member one of its two users silently ignores.
 */
export interface SwapToOptions extends SwapOptions {
  /**
   * The key the incoming sprite is added under. Defaults to the minted `swap:…` key, which is
   * unstable by design. Supplying one makes the fold preset stable per picture, lets two views
   * share one front, and lets the byte budget bound the result.
   *
   * A key that is already resident is a CACHE HIT, not a failure: the swap adopts the resident
   * sprite and `src` is not read. Re-pointing a live key remains `replace()`, and a key whose
   * `add()` is still in flight is still refused — sharing a front holds only once the first
   * `add()` has settled.
   */
  key?: string
}
```

`SwapOptions` (`view.ts:17`) is untouched and `view.swapTo`'s parameter merely widened, so a
`SwapOptions` an existing caller already passes still satisfies it — a minor under packages §10.2's
*"minors are additive"*. `SwapToOptions` **is** exported from the core's barrel, on the same line as
the type it extends (`packages/core/src/index.ts:133`): a parameter type a consumer cannot name is
one they cannot build a variable of, and this package's own signatures were the first to need it.

**The resident-key clause is the half that matters.** Without it the commonest sequence in the whole
library — A → B → A — fails on its third step, because key `a` is still resident and `add` refuses
it. With it, a swap back to a picture already seen costs no fetch and no byte budget, and parks for
exactly the authored ball hold rather than for a network round trip.

**It is not "instant", and do not design a UI expecting it to be.** A resident swap is still
`crumpleTo` on a non-empty view, which takes the full rise → hold → descent path
(`stage.ts:1371-1394`) and always tickets the scaled hold through the park timer (`runner.ts:502`,
`dwell.ts:213`). The degenerate-to-`show()` shortcut is for an **empty** view (`stage.ts:1364`), which
a swap by definition is not. **What the cache hit removes is the wait, not the animation** — and
removing the animation would be the wrong trade anyway.

One claimed benefit is narrower than it sounds, and the shipped docblock now says so itself:
*"lets two views share one front"* holds only once the
first `add` has settled, because a concurrent second `swapTo` on the same key is still refused while
that key is merely reserved. The in-flight map below is what covers the window, and it gates `swapTo`
too — the binding does not call `swapTo` for a key whose acquisition is in flight; it joins the
existing one and `crumpleTo`s the result.

### The acquisition shape behind every sprite

**Every place this package needs a sprite goes through one internal `acquire`** (§5.3) — the first
mount, the degraded reduced-motion swap, and the re-acquisition after a scene rebuild alike. You never
call it, but four of its five lines are visible in behaviour you will otherwise find surprising:

```ts
const { inFlight, controller } = acquisitionsFor(stage) // 1
let shared = inFlight.get(spriteKey)
if (shared === undefined) {
  shared =
    stage.get(spriteKey) !== undefined
      ? stage.prepare(spriteKey, { signal: controller.signal }) // 2
      : stage.add(src, { key: spriteKey, signal: controller.signal, ...(pin && { pin }) }) // 3
  inFlight.set(spriteKey, shared)
  void shared.finally(() => inFlight.delete(spriteKey))
}
let got = await shared // 4
if (isLiveKeyRefusal(got, spriteKey)) {
  // 5
  const prepared = await stage.prepare(spriteKey, { signal: controller.signal })
  if (!isPrepareNoSpriteError(prepared, spriteKey)) got = prepared
}
if (mySignal.aborted) return pc.ABORTED // 4
return got
```

1. **A per-stage map of in-flight acquisitions, keyed by sprite key.** `add` refuses a key that is
   merely *reserved* — in flight and unfinished (`stage.ts:1798`, and `stage.ts:371`: *"a live key is
   refused whether or not it has finished"*). Two `Crumple`s sharing a `spriteKey` and mounting in
   one commit would both see `stage.get() === undefined`, both call `add`, and the second would get a
   `SheetError`. The map is what makes "a second `Crumple` on a picture already on screen appears
   without a fetch" true rather than aspirational. It lives beside the stage and dies with it.
2. **`prepare`, not the resident sprite.** `stage.get` returns the record's sprite, and eviction
   *"drops a front and leaves the sprite rebuildable"* (`stage.ts:379`) — so a resident key can hand
   back **a sprite with no front**. `show`ing that would set `view.sprite`, lifting your placeholder
   over an empty canvas while the re-source ran on silently. `prepare` is the one demand that *waits*
   for a re-source rather than returning around it (`stage.ts:1912-1919`).
3. `add` only when the key is genuinely absent.
4. **The shared acquisition runs under a signal of the stage's own — not the caller's — and each
   joiner checks its own after the await.** Passing the first caller's signal would hand every joiner
   the first component's lifetime: the first unmounts, the shared promise settles `ABORTED`, and the
   second `Crumple` **stays blank forever**, with no error and no retry. The controller the binding
   passes instead is held in the same per-stage registry as the map, so it lives and dies with the
   stage — which is the right lifetime for work several components share, and the reason an unmount
   mid-acquisition cancels nothing but that component's own interest in the result.
5. **A live-key refusal is retried exactly once, through `prepare`.** The map only knows about
   acquisitions this binding started, and the core's `reserved` set is private (`stage.ts:371`) —
   neither `stage.get` nor `prepare` can see it (`stage.ts:2338`, `stage.ts:1895`). So if **you**
   prefetch `scene.stage.add(src, { key: 'hero' })` while a `Crumple` on `spriteKey: 'hero'` is
   mounting, both callers see an absent key, both call `add`, and one takes the refusal. The fallback
   joins the winner instead of failing a correct sequence. It is careful about *which* error it
   keeps: if that `prepare` answers *"has no sprite under that key"* the winner's `add` is still in
   flight and there is nothing to join, so the original live-key refusal — the cause — is reported
   rather than the symptom.

**The consumer-facing rule that falls out of 5: prefetch *before* mounting**, not alongside. The
fallback makes the racing case correct rather than fast, and the core cannot expose `reserved` to
close the window properly.

### `src` changed but `spriteKey` did not

This is a consumer error, and **the hook detects it without help from the core**: it keeps a
`Map<spriteKey, src>` of every pair it has requested, and refuses a request whose key it has seen
bound to a different source (§5.3). It reports an Error naming the hull-cache reason through
`crumple.error`, and **does nothing else** — no swap, no library call at all.

**A map, not the last pair, and the difference is a wrong picture rather than a wrong error.**
Requesting `(a, url1)`, then `(b, urlB)`, then `(a, url2)` changes the key at every step, so a
last-pair check passes all three; the third then takes the resident-key cache hit on `a` and **shows
`url1` while your prop says `url2`**, silently. The map costs one entry per picture the component has
shown and turns that into a reported Error.

The key names a *picture*, not a slot. The sanctioned re-point is `stage.replace(key, src)`, one line
away through `scene.stage`:

```tsx
const stage = scene.stage
if (stage !== null) {
  const sprite = await stage.replace(item.id, item.url, { signal })
  if (sprite === pc.ABORTED) return
  if (sprite instanceof Error) return report(sprite)
  // `replace` rebuilds onto the SAME sprite record — it releases and re-installs that record's
  // handle and front (`packages/core/src/stage.ts:2087-2090`) — so the view is already showing the
  // new bytes and only needs a redraw.
  crumple.refresh()
}
```

Doing this *automatically* on a changed `src` was designed and rejected (§5.3), and the reason is a
trap rather than a preference: `replace` releases the source-derived halves **before** rebuilding, so
the front the rise would animate on is gone, and the animation would silently vanish. A swap that
quietly turns into a no-animation reload is worse than an error.

## 7. Reduced motion

Under the default `reducedMotion: 'auto'` the hook checks
`matchMedia('(prefers-reduced-motion: reduce)')` **at the swap, not at mount** (§5.3), so a reader who
changes the OS setting mid-session gets the new behaviour on their next interaction without a stage
rebuild. `reducedMotion: 'off'` opts out of the check entirely and always animates.

The degraded path needs no API of its own, because `show()` **is** the degraded swap (USAGE, "Reduced
motion"). What the hook runs is:

```ts
// reduced: show() IS the degraded swap
const sprite = await acquire(stage, spriteKey, src, pin, signal)
if (sprite === pc.ABORTED) return
if (sprite instanceof Error) {
  report(sprite)
  return
}
view.show(sprite)

// otherwise — and the in-flight map gates this path too (see The swap)
const pending = pendingAcquisition(stage, spriteKey)
const run =
  pending === undefined
    ? view.swapTo(src, { key: spriteKey, duration, signal })
    : view.crumpleTo(pending, { duration, signal })
```

It goes through the same `acquire` as everything else, which is what keeps it correct in the two
cases a hand-written `stage.get(k) ?? add(k)` gets wrong: **a resident-but-evicted sprite would show
blank**, and **two components on one key would race each other**.

The degraded swap is one draw: no run, no `start` / `step` / `end` triple, nothing to stop — **which
is also why nothing downstream of it needs a reduced-motion branch of its own.** In particular
`entrance` is irrelevant under `reduce`: an `entrance: 'uncrumple'` under `reduce` is `'flat'` (§5.3).

Two consequences for your own UI. A view parked at `'ball'` and pulsing is motion, so under `reduce`
the honest indicator is a static one somewhere else — and `crumple.parked` will never become true because
reduced motion degrades to `show()`. Use `shown === null` for the loading placeholder. And because `show()` emits nothing at all
(§5.5), the only reason your placeholder lifts on this path is that the binding versions its own
store; there is no event behind it.

## 8. The entrance

```ts
entrance?: 'flat' | 'uncrumple'   // default 'flat'
```

The first sprite comes from `acquire` (§5.4), which is what lets a second `Crumple` mounted on a
picture already on screen elsewhere appear **without a fetch**.

**`stage.mount` is deliberately never used**, and the omission is not an oversight (§5.4): `mount`
composes `add` + `view` + `show('flat')` in one call, and this package needs the three separately,
because the view is born with the canvas ref while the sprite is acquired against a key that may
already be live, in flight, or resident with an evicted front.

- `'flat'` (the default) shows that sprite with no animation — the state `stage.mount` would have
  left.
- `'uncrumple'` shows it, draws the ball, and plays out of it: `view.show(sprite)`,
  `view.draw('ball')`, `view.play('ball', 'flat')`.

**That order is load-bearing rather than merely tidy** (§5.4). `draw` resolves a `PoseRef` against the
*shown* sprite's clip (`stage.ts:1524-1526`), so a `draw('ball')` issued before `show` resolves
against a pose count of 1 and draws pose 0 — the flat sheet, silently, instead of the ball. If you
ever hand-roll an entrance through `crumple.view`, show first.

**`entrance` is an entrance, not a loading indicator, and nothing here should be read as promising
otherwise** (§5.4). `crumpleTo`, and therefore `swapTo`, *on an empty view degenerates to `show()`*
(USAGE §2), so there is no ball to park at before the first sprite exists. **The loading indicator for
the first sprite is `children`**; the ball is the loading indicator only for *swaps*, where a sprite
is already on screen to rise from. This is the single most likely misreading of this package, which
is why it has its own paragraph.

## 9. Knobs

`knobs` on the scene is a plain object of flat or namespaced keys (packages §6.2), and it is a
scene-level option because writing one means calling `stage.set` — the layering test, applied.

```tsx
const scene = usePaperScene({
  create,
  deps: [edgeShape],
  knobs: { edgeWidth, angularity, 'sheet.seed': seed },
})
```

On every change the hook diffs it against the last applied map and writes **only the changed keys**,
**one `stage.set` call per changed key** (§4.3). A refused key is reported and the rest are still
attempted. Re-sending the whole object every render is therefore free, which is what lets you keep the
knobs in ordinary React state.

After a key has been applied, omitting it from the next `knobs` object writes `stage.defaults[key]`.
Undeclared keys are silently skipped, and the batch produces one `knobEpoch` bump. Flat keys use the
bare key for a shared binding; slot-local bindings use `namespace.key`.

```tsx
const [knobs, setKnobs] = useState<pc.Knobs>({})
const scene = usePaperScene({ create, deps, knobs })

<button onClick={() => setKnobs({})}>Reset knobs</button>
```

For a synchronous refusal path, keep `scene.stage.set({ [key]: value })`. The declarative path costs
the React render/effect cycle; it does not promise a synchronous result from `knobs`.

**The one-call-per-key rule is what makes "one bad key does not abandon the batch" true** rather than
a wish. `normalise` returns on the first invalid key and writes nothing
(`packages/core/src/knob-registry.ts:155`), and `applyPatch` only reaches `Object.assign` for a wholly
valid patch (`stage.ts:846`) — so `stage.set({ a: ok, b: bad, c: ok })` applies **none** of the three.
If you write knobs yourself through `scene.stage`, write them one at a time for the same reason.

### The re-frame after a geometry knob

A key whose descriptor moves geometry makes the next demand on the front answer `SourceExpiredError`,
which the stage turns into a re-source — a new sheet handle, and with it a new paper box. **That work
is still in flight when `stage.set` returns**, so someone must join it with
`await stage.prepare(spriteKey)` before re-reading `View.frame`; reading any earlier reads the frame
the sprite is about to leave. This used to be the playground's own `settleFrame`
(`examples/playground/src/useStage.ts`, deleted); the binding now does the join itself, in the
`knobEpoch` effect of `packages/react/src/use-crumple.ts`, and it is a requirement, not an
optimisation.

The binding does it, split across the only seam that exists (§4.3) — `prepare` takes a *sprite* key,
framing state lives on the crumple, and the scene has no register of crumples to walk:

- The **scene** writes the knobs and then bumps **`knobEpoch`**, a second counter alongside
  `generation` — a knob write is not a build and must not masquerade as one.
- Each **crumple** watches `knobEpoch` and joins `stage.prepare` for **its own** sprite, then
  recomputes `frame` and `frameStyle` and refreshes.
- **A crumple with no sprite yet skips the join entirely.** `prepare` on a key with no record returns
  a `SheetError` (`stage.ts:1896`), and a key that is merely reserved has no record until its `add`
  finishes (`stage.ts:1825`) — so joining there would report a library error for the perfectly
  ordinary sequence of moving a knob while a tile is still mounting. Nothing is lost: that
  acquisition is already building at the live knob values.

That lands both halves of the rule — **one join per batch** (the scene bumps once per batch) and **one
re-source per sprite** (each crumple joins its own key). Two crumples sharing a sprite join the same
in-flight re-source, which `prepare` already handles.

`knobEpoch` is public, so a consumer doing their own framing has the same signal to hang on.

## 10. Framing the hero

For a grid, `cssPx` and the managed backing store are the whole story and there is nothing to do — see
USAGE §1. For a hero, where the picture must sit at a fixed on-screen rectangle while the paper is
free to overflow past it, build the stage with `artworkCssPx` and pass the hook **`frameTo`**:

```tsx
const hero = useCrumple({
  spriteKey: selected.id,
  src: selected.url,
  entrance: 'uncrumple',
  frameTo: 360, // the CSS long side the ARTWORK should hold on screen
})

return <Crumple value={hero} className="hero" />
```

That is the whole manoeuvre. The hook computes `crumple.frameStyle` — `frame`'s two boxes under the
one scale `frameTo / max(artwork.w, artwork.h)`, as four CSS strings — and `<Crumple>` spreads it onto
the wrapper. `frameStyle` is the paper box written to `<Crumple>`'s wrapper, while `artworkStyle` is
the artwork rectangle for the surrounding layout under the same scale and the same `null` convention.
Use it directly for a surrounding slot rather than recomputing the artwork box manually:

```tsx
<div className="hero-slot" style={crumple.artworkStyle ?? undefined}>
  <Crumple value={crumple} className="hero-paper" />
</div>
```

Both styles are recomputed after every swap and after a hull-tier
re-source has landed — the
`knobEpoch` join under [Knobs](#9-knobs). Omit `frameTo` — the default — and `frameStyle` is `null`, the wrapper is left
alone, and `frame` is still reported: that is the grid's case.

**Pass the same number you gave `paperStage` and the result is 1:1 at `devicePixelRatio`.** Passing a
different one is not an error and is not corrected: it merely scales, which is a consumer's
prerogative.

**The arithmetic lives in the hook, not in the component** (§6), and that is not an implementation
detail you can ignore — it is why the component can frame at all. `<Crumple>` receives only
`value: Crumple`, so anything it needs must be a field on the instance. `frameTo` is an option of the
*hook*; a component asked to apply it would have nothing to apply.

**Why `frameTo` is an option rather than something the binding works out**, since the question is the
obvious one to ask (§6): you write the `paperStage(...)` call yourself inside `create`, so
`artworkCssPx` never passes through this package, and it is not readable back off a `BlitStage`.
Threading it through `SceneOptions` would have meant stating the number twice and trusting the two
copies to agree. Naming it where it is used makes framing an **explicit request** rather than a
behaviour keyed on how a stage the binding never saw was built.

`ViewFrame` remains available for inspection: it is `{ box, artwork }`, the box the view draws into and
where the unpadded artwork lands inside it, both in that box's pixels, `null` until a front is resident
(`packages/core/src/view.ts:93`).

## 11. What `<Crumple>` renders

```tsx
<Crumple value={crumple} className="tile" style={…} canvasProps={…}>{placeholder}</Crumple>
```

A positioned wrapper element, a `<canvas ref={value.ref}>` inside it, and `children` layered over the
canvas while `value.shown === null` (§6). DOM props land on the wrapper; `canvasProps` is the escape
hatch for the canvas itself.

**The wrapper is a `<div>` with `position: relative`, and it is not overridable in v1** (§6). An `as`
prop is a guess at a requirement nobody has stated yet, and adding one later breaks nothing — so it is
deferred rather than invented.

The wrapper is not decoration: the paper overflows the picture by however far the edge knobs reach, so
pinning the *picture* rather than the *paper* means sizing and offsetting an element from `frame`'s
two boxes — the manoeuvre above, which the component performs by spreading `value.frameStyle` when it
is non-null.

**Where your own `style` prop sets one of the four properties `frameStyle` carries — `width`,
`height`, `left`, `top` — `frameStyle` wins**, because it is applied last (§6). Overriding `width` on
a framed wrapper is asking for a broken frame rather than a customisation, and the other precedence
would make framing fail silently for whoever forgot which four properties were spoken for.

`canvasProps` is typed
`Omit<React.CanvasHTMLAttributes<HTMLCanvasElement>, 'ref' | 'width' | 'height'>`. **All three
exclusions are compile errors rather than silent losses** (§6), which is the point of spelling them
out in the type: `ref` belongs to `value.ref` — it is the seam the whole API is built on, and a second
ref on that element would be a view with no lifetime — and `width` / `height` belong to the stage.

**Nobody but the stage writes `width` or `height` on the canvas.** The binding is always `'managed'`,
under which the core reads `getBoundingClientRect()` and writes the backing store during the draw
(`stage.ts:1059-1072`); a React-set attribute would fight it every blit. The playground learned this
the expensive way, in the pre-migration hero implementation — a canvas with no CSS size takes its
layout size from those attributes, the two feed each other, and the element grows by
`devicePixelRatio` per blit until it hits the front size. Every box around the canvas is sized off
`crumple.frame` today rather than off the canvas's own attributes — `value.frameStyle` for the
wrapper, `heroSlotStyle` (`examples/playground/src/scene/hero.ts`) and the `frameArtwork` it calls
(`examples/playground/src/scene/framing.ts`) for the playground's own layout slot — so the loop has nothing
to feed on. The exclusion is safe to state absolutely only because `'manual'` is not offered.


## 12. Errors

**Nothing in this package throws, and nothing reaches an error boundary.** This is not a stylistic
choice (§7). The whole family returns `Error | T`, a promise that fails resolves to an Error rather
than rejecting, and cancellation is a sentinel rather than an Error at all (USAGE, "The convention,
first"). A React layer that converted those values back into thrown exceptions would discard the one
property the design spent itself on — that a failure is visible in a type and cannot be forgotten.

Consequently: **no Suspense**, no `use()` on the stage promise, **no error-boundary integration**.
`error` is a field on the instance and `status` is a value to branch on.

**That holds even when your own `create` breaks the convention.** A factory that throws — or returns
a rejecting promise — is caught, and the scene degrades into the same `failed` state an Error return
produces, carrying that error with `stage: null`. It does not become the one place in the package
where an exception escapes into your tree.

**`ABORTED` never reaches you through the instance's own fields** — `error`, `status`, `shown` and the
rest are never the sentinel, because "React changed its mind" is not a condition a component renders.

**It does reach exactly one place, and it is the honest price of a real handle** (§7):
`crumple.play` hands back the raw `pc.Run<pc.PlayResult>`, and `PlayResult` is
`undefined | PoseError | Aborted` (`packages/core/src/results.ts:59`) — a stopped run, or one on a
disposed view, settles `ABORTED` (`stage.ts:1347`). A `Run` this package handed you is a core value
and narrows with the core's own two early returns, abort first. The alternative was a wrapper that
swallows `stop()`.

### The two error channels, and why nothing arrives twice

- **`create`'s second parameter is the pre-mount channel.** It is the only way to reach
  `StageOptions.onError`, because you write the `paperStage` call. Spread it or lose the window in
  which the factory itself fails.
- **`SceneOptions.onError` is the post-resolve channel**, fed by the binding's own
  `stage.on('error')`.

They are one dispatcher fed from two places, and the binding keeps it single. The listener handed down
to `paperStage` is registered on the stage's bus **permanently** by the core (`stage.ts:283`) — it is
not a `once` and it is never detached — so the binding's own subscription would double every
post-resolve error, including on the `!observed` path. **The handed-down listener therefore forwards
only while the scene is still building**, and `stage.on('error')` takes over the moment `create`
resolves.

Filter telemetry on `!observed` (packages §10.6): an error also on its way to a return value would
otherwise be counted twice for a different reason.

## 13. Server rendering

`<PaperScene>` renders no DOM. `<Crumple>` renders its wrapper and `children`; the canvas is empty and
no effect runs.

`getServerSnapshot` returns the **detached** snapshot (§8), so `state` is `'detached'` and `shown` is
`null` — which is exactly the branch that renders the placeholder. The server's HTML and the first
client paint therefore agree, and there is no hydration mismatch to suppress. You do not need
`ssr: false`, a dynamic import, or a mounted flag.

## 14. What this package does not do

From §11, and each is deferred with a reason rather than forgotten:

- **`DirectStage` and `HostedStage`.** v1 binds `present: 'blit'` only, because one canvas per
  component is the shape React already has. A `HostedStage` binding is the interesting one — it is how
  this would live inside react-three-fiber — and it needs its own design.
- **`size: 'manual'`.** Deferred rather than half-offered (§5.1): supporting it means reopening
  `width` / `height` on `canvasProps` and making the two settings mean opposite things about who owns
  the element. `scene.stage.view()` is the escape hatch until someone needs it for real.
- **A prefetch hook.** `stage.prepare` and the prefetch discipline in USAGE §9 are reachable through
  `scene.stage` today; a declarative form needs evidence from real use first. Prefetch **before**
  mounting the `Crumple` that will show the key — see [the acquisition
  shape](#the-acquisition-shape-behind-every-sprite).
- **Audio.** `@paper-crumple/audio` is still deferred by packages §3.4.
And two things that are the *application's* job rather than the binding's (§10): generating a knob
panel from the runtime descriptors — a control panel built from `stage.knobs` is an application, not a
binding — and the audio wiring in a `start` handler.

## 15. Testing

The pure testing subpath exports these public values and types:

```ts
import {
  buildingScene,
  createFakeStage,
  deferred,
  detachedCrumple,
  failedScene,
  readyScene,
  type FakeCall,
  type FakeStageHandle,
  type FakeStageOptions,
  type FakeViewHandle,
} from '@paper-crumple/react/testing'
```

`createFakeStage` needs a DOM because it creates a canvas. Put
`/** @vitest-environment jsdom */` at the top of a Vitest file. Testing Library configures
React's act environment; bare `act` users should set:

```ts
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
```

`matchMedia` is guarded and needs no stub unless the test exercises `reducedMotion: 'auto'` with
reduction enabled. The fake has two deliberate limitations: `view.run` always reads `null`, and
`FakeViewHandle.settleRun` controls only the latest run.

For example, assert the calls relevant to the behavior under test:

```ts
const fake = createFakeStage({ sprites: ['hero'] })
const scene = readyScene(fake.stage)

// Render the consumer under <PaperScene value={scene}> with the test renderer of your choice.
expect(fake.calls.filter(({ method }) => method === 'add')).toHaveLength(0)
expect(fake.calls.filter(({ method }) => method === 'view')).toHaveLength(1)
```

`render`, `renderHook`, `renderCrumple`, and `flush` are internal and are not exported. The testing
helpers may add fields within a major version but never remove fields within that major. Consumers
should assert the calls and fields relevant to their behavior rather than exact-object equality over
every helper field.
