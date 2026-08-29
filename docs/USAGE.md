# Usage: the `@paper-crumple` package family

Status: **derived from the design, not from an implementation.** Nothing here has been compiled or
run — the packages do not exist yet. Every call, option and return type below is taken from
`docs/superpowers/specs/2026-08-26-paper-crumple-packages-design.md`, with the section it comes from
cited inline. The five places where an earlier draft of this document had to guess at a signature
are now settled in the spec and are listed under [The open questions, closed](#the-open-questions-closed).

This document is the working draft of the consumer-facing half of P13's README.

## Install and import

```sh
npm i @paper-crumple/core @paper-crumple/paper @paper-crumple/motion
```

```ts
import * as pc from '@paper-crumple/core'
import { paperSheet } from '@paper-crumple/paper'
import { tiles } from '@paper-crumple/paper/tiles'      // opt-in, §14: the default is tiles: null
import { bakedMotion } from '@paper-crumple/motion'
import pack2x3 from '@paper-crumple/motion/packs/2x3'   // one module per pack, §3.2 / §14
```

**There is no `paper-crumple` bundle package.** Install the three scoped packages directly. A bundle
was designed and cancelled (§14): hello-world is irreducibly five module specifiers, because the
pack and tile subpaths were never re-exportable without defeating the whole point of the subpath
split (§3.2), so a bundle bought a shorter install line and nothing else against a hand-maintained
re-export surface. The unscoped `paper-crumple` name on npm carries a deprecation stub pointing
here, so that the name every document and search result says out loud is not an exact-name
typosquat waiting to happen. Record the one real loss: there is no single `esm.sh/paper-crumple`
URL for a CDN playground, and three scoped packages with peer relationships are genuinely awkward
there.

`core` is a `peerDependency` of `paper` and `motion`, so the three resolve to **one** copy of core
under every modern package manager — which is what makes `instanceof` safe (§10.4). Declare core in
your own `dependencies`; if you are publishing a wrapper around this library, declare core in
`peerDependencies` and never in `dependencies`, because that is the one install shape that produces
two copies. Assert it rather than hoping:

```ts
const dup = pc.assertSingleCore()
if (dup) throw dup     // CoreDuplicateError, carrying { version } — a startup failure, not a
                       // once-per-session console warning (§10.4)
```

The three packages ship one shared version number under Changesets `fixed`, which without a bundle
is the only visible signal that they are a family. The peer range is `^1.x` and not `~1.x`: §10.2
designs minors to be additive, so tilde peers would turn every routine upgrade into a three-package
flag day. Core's README is canonical; this block appears identically in all three (§14).

## The convention, first

Every function returns `Error | T`. Nothing throws above the named boundary helpers, and a promise
that fails **resolves to an Error rather than rejecting** (§10.8). Cancellation is not a failure and
is not an Error at all: it is a sentinel.

```ts
export const ABORTED: unique symbol      // = Symbol.for('paper-crumple.aborted')
export type Aborted = typeof ABORTED
```

Every operation that accepts a `signal` returns `T | SomeError | Aborted`; every operation that does
not, cannot abort and does not carry `Aborted` in its union. The type is therefore the answer to
"is this cancellable". Callers narrow with two early returns, abort first:

```ts
const view = await stage.mount({ key, src, canvas }, { signal })
if (view === pc.ABORTED) return           // abort first, as its own early return (§10.5)
if (view instanceof Error) return view
view.refresh()
```

**Forgetting the first line is now a compile error**, and that is the entire reason the sentinel
exists:

```ts
const view = await stage.mount({ key, src, canvas }, { signal })
if (view instanceof Error) return view
view.refresh()
//   ~~~~~~~ Property 'refresh' does not exist on type 'View | Aborted'.
```

`Symbol.for`, never a bare `Symbol()`. A unique per-module symbol would recreate §10.4's
duplicate-core hazard in its worst form: copy B's sentinel would fail copy A's `isAborted` **and**
fail `instanceof Error`, and would then flow into code typed as success — on the most routine event
in a scrolling grid. The sentinel lives in the same global registry as the version marker the spec
already puts in `globalThis[Symbol.for('paper-crumple.core')]`.

The rule in one line: **the sentinel is a return, the class is a cause.** `AbortedError` survives as
a class, but only inside `cause` chains, where a wrapping error records that the thing underneath it
was cancelled. `isAborted()` is the reader for that direction and is specified over exactly four
shapes: `x === ABORTED`; `x instanceof AbortedError`; an `AbortedError` or a `DOMException` named
`AbortError` anywhere in the cause chain; and `cause: ABORTED`, which is legal since ES2022 and
cheap to miss.

```ts
try { await audio.resume() } catch (e) {
  if (!pc.isAborted(e)) throw e           // for an Error in hand; `=== ABORTED` is for a return
}
```

Abort is **all-or-nothing at the call level**: an element union inside a batch result never contains
`Aborted`, and a cancelled batch returns the sentinel in place of the whole array. Without that rule
the generic helpers cannot be typed and the ownership of half-built work is undefined.

`instanceof` is canonical **within** a package; `Err.is()` is canonical **across** a package seam
(§10.4). Two installed copies of `@paper-crumple/core` would give you two `GlError` classes, and
`err instanceof GlError` would return `false` — narrowing an Error as a success value. The peer
dependency makes that unlikely, `Err.is()` makes it harmless, and `assertSingleCore()` makes it
loud.

## 1. A grid of tiles — the main scenario

N tiles, N `<canvas>` elements, **one** WebGL2 context. The stage creates its own surface and blits
into the elements you supply; it never calls `getContext('webgl2')` on an element it did not create
(§4.0).

```ts
// grid.ts — imports as above.

type Item = { id: string; url: string; el: HTMLCanvasElement }

export async function mountGrid(items: Item[], ac: AbortController) {
  // --- the stage ------------------------------------------------------------
  // Async factory (§4): yields a stage whose invariants hold, an Error, or ABORTED. There is no
  // `canvas` option — the stage owns its drawing surface (§4.0) and blits into yours.
  const stage = await pc.paperStage({
    sheet:   paperSheet({ edgeMode: 'torn', tiles }),     // edgeMode is a factory option (§6.5)
    motion:  bakedMotion({ packs: [pack2x3, pack1x1] }),  // an unsupplied bucket returns an
                                                          // AssetError naming the missing subpath
    cssPx:   192,                 // the stage runs sizeForDisplay({ cssPx, dpr: devicePixelRatio,
                                  // cap: 512 }) for you. Exactly one of cssPx / maxSize is required.
    budget:  64 * 1024 * 1024,    // §8.8: the byte budget governs exactly one per-sprite tier — fronts
    present: 'blit',              // no default any more: this literal selects the BlitStage overload
    onError: ({ error, view, observed }) => {
      // §10.6 exists for the ORPHAN: an error raised inside a setTimeout step, with no caller on
      // the stack and no return value to become. `observed: true` means this error is, or will be,
      // a return value someone can narrow — reporting it here as well double-counts every handled
      // failure. Telemetry filters on !observed. ABORTED is never emitted here at all.
      if (!observed) report(error, view)      // view === null => stage-originated (§7.1)
    },
    signal:  ac.signal,           // an abort mid-flight disposes what the factory built and returns
                                  // ABORTED: a context nobody will receive must not be kept, because
                                  // the browser's ceiling is roughly sixteen live contexts (§4.0)
  })
  if (stage === pc.ABORTED) return
  if (stage instanceof Error) return stage    // ReadyError = GlError | KnobError

  // Degradation is a value, not a rejection (§4): a paper tile that failed to fetch leaves a
  // usable stage that renders without grain.
  for (const w of stage.warnings) console.warn('paper-crumple:', w.message)

  // --- one call per tile ----------------------------------------------------
  const views = new Map<string, pc.View>()

  for (const item of items) {
    // mount = add + view + show('flat'), one await, one pair of guards.
    // A string / URL / Blob source lets the library derive its own re-supplier, so the front is
    // LRU-reclaimable by default and the budget above actually bounds it (§8.5.1).
    const view = await stage.mount(
      { key: item.id, src: item.url, canvas: item.el, fit: 'contain', tag: item.id },
      { signal: ac.signal },
    )
    if (view === pc.ABORTED) return
    if (view instanceof Error) { console.warn(view); continue }   // AddError | ViewError
    views.set(item.id, view)
  }

  return { stage, views }
}
```

The key selects the fold preset (§4.1) as well as naming the sprite, and `tag` is what makes a
`stage.play()` report entry correlatable without a reverse `Map<View, id>` (§7.1).

**There is deliberately no `mountAll`.** A batch form was designed and rejected because its return
type could not be honest: `Array<View | AddError> | Aborted` omits the `ViewError` that `mount` can
produce, and a whole-batch `Aborted` cannot say who owns the sprites and views already built before
the signal fired — either answer contradicts §10.5's "keep what is already paid for" or contradicts
"the return value is the complete account". The loop above is four lines and leaves the abort policy
where the caller can see it.

**The destination canvas is sized for you.** `BlitTarget.size` defaults to `'managed'`, under which
the stage sets `canvas.width/height` to `round(cssSize × devicePixelRatio)`, capped at the front
size, whenever it is stale. It reads `getBoundingClientRect()` once per draw, which needs no
observer: draws happen six times per fold, not sixty times per second. A zero CSS size — a hidden
element — is left alone rather than resized to zero. Without this the headline scenario ships blurry
on every retina grid, because a consumer's `<canvas>` arrives at its stock 300×150 backing store and
the front size is bucket-derived and unexposed; §7.4's claim that the number of places
`devicePixelRatio` is thought about goes from N to one is true of the front and was false of the
destination. Pass `size: 'manual'` to own it yourself, and then `sprite.frontSize`, `sprite.rect`
and `view.idealSize` are the numbers your layout code needs.

The blit also **clears the destination 2D canvas** before each `drawImage`, at minimum the letterbox
bars. Without that, a swap from a wide sprite to a narrow one under `fit: 'contain'` leaves the
previous sprite's edges on the tile — §4.3's scissored clear covers the GL surface only.

One sprite may be shown by several views — the same garment as a grid thumbnail and in a detail
panel, sharing one front texture. That is why the pose belongs to the view, not to the sprite
(§4.3). `mount` composes the common case; the pieces it composes are still there for this one:

```ts
const sprite = stage.get('sweater')            // Sprite | undefined — a missing key is not a failure
if (sprite) {
  const detail = stage.view({ canvas: detailEl, fit: 'contain' })  // no signal, so no Aborted
  if (detail instanceof Error) return detail   // ViewError: a second view on the same element, or
  detail.show(sprite)                          // an element already carrying a non-2D context
}
```

## 2. The headline: exchanging a sprite through the ball

```ts
// §4.2. A crumples into a ball, the ball is exchanged, B uncrumples out of it. The exchange is
// invisible because at the ball alphaFloor === 1: the sheet is pure paper and carries no sprite
// identity at all, so a bucket change across the swap is invisible rather than merely well hidden.

// swapTo = add + crumpleTo(pending). It is also the loading indicator: the view rises, parks at the
// ball for as long as the fetch takes, and uncrumples into whatever arrives.
const run: pc.Run<pc.SwapResult> = view.swapTo(next.url, { duration: 900, signal })

// `start` has ALREADY been emitted — synchronously, inside the call above, before it returned — so
// an AudioContext.resume() in a start handler still runs inside the user gesture (§4.2, §7.1).
const r = await run
if (r === pc.ABORTED) return
if (r instanceof Error) return r        // the target failed => already rolled back to A (§7.1)
```

`play`, `crumpleTo` and `swapTo` return a `Run`, not a promise:

```ts
interface Run<R = PlayResult> extends PromiseLike<R> {
  readonly done: Promise<R>
  stop(): void
}
```

The parameter is not decoration, and it is the rolled-back swap in the sample above that puts it
there.
`view.play` returns `Run` — `Run<PlayResult>` — and can fail only in ways the traversal itself
produces. `crumpleTo` and `swapTo` return `Run<SwapResult>`, because they can also fail with the
**target's** error: the incoming sprite never loads, the view descends on the old one instead, and
the caller is handed a failure no `play` can produce. One settled result type could not honestly
cover both, and collapsing them would have meant either lying to `play` about what it can return or
losing the target failure on the swap. Both are §10.2 aliases and may gain members in a minor
release.

`Run` is a thenable, so `await view.play('flat', 'ball')` reads exactly as it would have. What
changed is that the returned value stops **being** a promise, and that is the point. The
synchronous-`start` contract above cannot survive `swapTo` being refactored into an `async`
function, and iOS audio breaks silently when it does — a prose warning is the only thing that ever
stood between a maintainer and that edit. Now the signature does: a `Promise` has neither `done` nor
`stop`, so an `async` reimplementation no longer satisfies the return type, and the refactor is a
type error at the declaration rather than a bug report from a phone.

`run.stop()` stops that one run and touches no other. `crumpleTo` remains for the case where you
already hold the pending sprite — it accepts a `Promise<Sprite | Error>` directly, so a
`stage.add()` can be passed straight through — and `crumpleTo()`, and therefore `swapTo()`, on an
empty view degenerates to `show()`.

### Dwell arithmetic (§7.2)

`DWELL_MS = [95, 70, 120, 75, 135, 90]`. The scheduler renders pose *i*, waits `DWELL_MS[i]`,
renders the next, and **never waits after the last pose**: N poses, N−1 gaps.

```ts
await view.play('flat', 'ball')   // 495 ms  (NOT 585 — that is the documented ~15 % sync error)
await view.play('ball', 'flat')   // 490 ms
await view.play(2, 4)             // 195 ms — raw indices, the escape hatch; see below
view.refresh()                    // a redraw at the current pose: one render, no run, no events

await view.swapTo(next.url)       // 985 ms from 'flat': 495 rise + 90 ball hold + 400 fall
```

`duration` applies **one** multiplier over the traversed gaps only, so the hand-made uneven cadence
survives exactly. Park time is never rescaled: the hold is `max(scaledBallDwell, timeUntilSettled)`,
and the deadline is re-based on leaving the ball so a stall does not become debt the descent tries
to catch up on. A hand-chained `play('flat', 'ball')` + `play('ball', 'flat')` costs exactly 985 ms
with a zero-length seam and does **not** reproduce the ball hold — insert `DWELL_MS[5]` yourself if
you want it.

When `duration` is shorter than the blocking GPU cost the run overruns and **no pose is skipped**.
Six hard steps are the effect.

`PoseRef = 'flat' | 'ball' | number`, and the named form is canonical: every signature, default and
example uses it, because §10.1 calls a raw index at a call site the likeliest runtime error in the
API. Raw indices remain legal and are the documented escape hatch for a custom pack, next to
`stage.poseCount` / `view.poseCount` — a pack with a different frame count makes `'flat'` and
`'ball'` the only two references that stay correct.

**`PoseRef` is an input type only, and the direction matters.** `'flat'` and `'ball'` are resolved to
indices on the way in, so everything the library *reports* carries the resolved number: `start.from`,
`start.to`, `start.via`, `step.pose` and the `view.pose` accessor are all `number` (§7.1). The
mistake the asymmetry invites is reading a pose and comparing it to a name — `if (e.pose === 'ball')`
is rejected by TypeScript, which is the good case, and silently never true in JavaScript, which is
not. Compare against a resolved index, or pass a reported one straight back into a call, which is
what it is for.

`play(x, x)` also stays legal (§4.5), but it is
no longer the documented redraw: it emits a `start` / `step` / `end` triple for a repaint, which
pollutes every consumer's metrics. `view.refresh()` redraws at the current pose and
`view.draw(pose)` draws exactly one pose with no run and no events — the honest hook for
scroll-driven or devtools-stepped scrubbing.

### Reduced motion

The library's two stated jobs are a transition and a loading indicator, so the reduced-motion branch
belongs on the getting-started path rather than in an appendix. No API is needed for it: `show()`
**is** the degraded swap.

```ts
const reduce = matchMedia('(prefers-reduced-motion: reduce)')

async function exchange(stage: pc.BlitStage, view: pc.View, next: Item, signal: AbortSignal) {
  if (!reduce.matches) return await view.swapTo(next.url, { duration: 900, signal })

  // The degraded path: one draw at 'flat'. No run, no start/step/end triple, nothing to stop —
  // which is also why nothing downstream of it needs a reduced-motion branch of its own.
  const sprite = await stage.add(next.url, { key: next.id, signal })
  if (sprite === pc.ABORTED) return
  if (sprite instanceof Error) return sprite
  view.show(sprite)
}
```

Branch at the swap and not at mount, so that a user who changes the OS setting mid-session gets the
new behaviour on their next interaction without a stage rebuild. The same query gates the loading
loop in §3: a view parked at `'ball'` and pulsing is motion, and under `reduce` the honest indicator
is a static one somewhere else in your UI.

## 3. Events, the loading loop, and a wave across the grid

```ts
// §7.1: on() returns its unsubscribe closure. Subscribing cannot fail, so it is not an Error | T.
const off = view.on('end', (e) => {
  // The documented way to write a looping indicator. `end` reports both ends of the run that just
  // finished as resolved indices, and play() accepts indices, so the ping-pong needs no state of
  // its own. A call made from inside a handler for this view's own event is deferred by exactly ONE
  // microtask into a single-slot pending box, so unbounded synchronous recursion is structurally
  // impossible. This is the only deferral in the library — a call from a click handler still runs
  // synchronously.
  if (e.completed) view.play(e.to, e.from)
})

view.on('step', ({ pose, frame, ms }) => metrics.record(pose, ms))
view.on('start', ({ from, to, via }) => {
  // `via: 5` marks a run that rises to the ball, parks and descends — a crumpleTo or a swapTo —
  // and such a run is ONE run: one start, one end (§7.1). A reported pose is an index, never a
  // name, which is why this reads 5 and not 'ball'.
  if (via === 5) audio.play()
})
```

`view.state` exposes §4.5's state machine under §4.5's own names: `'idle'`, `'playing'`,
`'crumpling.rise'`, `'crumpling.ball'`, `'crumpling.fall'`, `'crumpling.recover'`, and the terminal
`'disposed'`. The four crumple phases are worth distinguishing rather than collapsing.
`'crumpling.ball'` is the **parked** one — no timer but the ball dwell, no draws — and it is the
state a loading indicator sits in for as long as the fetch takes; `'crumpling.recover'` is the
descent on the **old** sprite after a target failure, which is the only way to tell a rolled-back
swap from a successful one before `end` arrives. `view.run` is the live run or `null`, typed at the
default: `Run | null`, which is `Run<PlayResult> | null`. That is the right parameter for it because
the accessor exists for `stop()` and for a liveness test, not for awaiting a run you did not start —
whoever called `swapTo` is already holding the `Run<SwapResult>` it returned, and that is the handle
that reports a target failure. Awaiting `view.run` will not tell you the incoming sprite failed;
`view.state === 'crumpling.recover'` and the `end` event will. Together they replace the `isPlaying`
counter every consumer used to hand-roll out of `start` / `end` pairs. `view.pose` is the `current` that §4.5 tells you to write
`play(current, 'flat')` with:

```ts
if (view.state === 'idle') await view.play(view.pose, 'flat')
if (view.state === 'crumpling.ball') showSpinner()   // parked on the fetch, not stalled
view.run?.stop()                                     // stops this view's run and nothing else
```

Ordering rules worth relying on (§7.1):

- `start` is emitted **synchronously** inside the call that begins a run, before the first
  `setTimeout`, and is always immediately followed by `step { pose: from }`.
- **Every `start` is followed by exactly one `end`.** Supersession, `stop()`, `dispose()` and
  `error` are not exceptions. A run that never started emits neither.
- Supersession emits `end` before `start`, so a counter built on the pair stays correct.
- `error` is never terminal on its own but forces `completed: false`:
  `completed = reachedTo && noErrorEmitted && notSuperseded`.
- A failure the caller can see is **returned**, not emitted; the `error` event carries
  `observed: true` when it is also on its way to a return value, and the no-listener `console.error`
  fallback fires only for `observed: false`. `ABORTED` is never emitted as an `error` at all.

```ts
// --- a wave across the whole grid (§4.4) -----------------------------------------
// stage.play never returns an Error and never rejects. It snapshots its eligible views
// synchronously in registration order, starts view i at t0 + i × stagger, and runs N independent
// chains so one superseded view does not disturb the other ninety-nine. Its own `start` is emitted
// synchronously too, so it is under the same not-async contract as view.play.
const report = await stage.play('flat', 'ball', { duration: 900, stagger: 40 })
// wall time = duration + (n − 1) × stagger; `duration` is PER VIEW.

for (const { view, reason } of report.skipped) {
  // 'busy' | 'no-sprite' | 'cancelled' | 'disposed'. Skipping is never silent, and view.tag is
  // what lets you name the tile without keeping a reverse Map.
  console.info('skipped', view.tag, reason)
}
for (const { view, error } of report.failed) console.error(view.tag, error)

stage.stop()                    // stops only stage-owned runs
stage.stop({ all: true })       // stops everything, including a user-initiated garment swap
```

**Collisions are decided by scope, not by method** (§4.4). Within a scope the latest call wins;
across scopes the narrower scope wins:

```
stage.play                    vs  view-owned run     -> skip, reported with reason 'busy'
stage.play                    vs  stage-owned run    -> supersede (a tie)
view.play / crumpleTo / swapTo vs  anything          -> supersede
```

`stop()` freezes the view at its current pose and **issues no draw** — a cancel path must not
render. There is no `stopped` state; `stop()` is a transition to `idle` (§4.5).

## 4. Knobs

Ground truth is namespaced; the flat form is a resolver (§6.2). Roughly 38 of the 45 keys are unique
and keep working bare, and the ambiguous remainder is reachable only namespaced — because the
generated flat union is built from the descriptors by **excluding every key more than one slot
declares**.

```ts
stage.set({ 'sheet.grain': 0.09, 'motion.grain': 0.18 })   // always unambiguous
stage.set({ tearAmp: 44 })                                 // unique declarer -> resolves bare
stage.set({ paperColor: '#f7f4ed', paperBack: '#e8e2d4' }) // core-owned shared knobs, both slots bound

// stage.set({ grain: 0.2 })
//            ~~~~~ 'grain' does not exist in type … — declared by sheet AND motion (§6.2), so it
//                  is not in the flat union at all. The two values are separately tuned, against a
//                  flat sheet and a shaded 3D mesh; there was never one `grain` to set.
```

The exclusion is a type-level one, and it is the only thing that changed: the runtime validator
still returns a `KnobError` for an ambiguous bare key, for the untyped callers of §7 that can still
reach one. From TypeScript that error is now unreachable, which is the point — it is the one class
of `KnobError` a reader can stop writing a branch for. Out-of-range stays, and is the whole of
`set()`'s return:

```ts
const preset = { tearAmp: 44, looseness: 0.3 }
const err = stage.set(preset)      // SetResult = KnobError | undefined — `undefined`, not `void`,
if (err) console.error(err.message)// so `if (err)` narrows and the result is storable
```

There is exactly one `set()`. An earlier draft carried a second `setExact()` because `Partial<K>`
catches a typo in an object **literal** and not in a patch built in a variable (§6.8) — presets and
config objects, which is where typos actually live. The patch parameter now takes a generic that
rejects excess properties in both, so the second method has nothing left to do.

Where a knob lives (§6.6) follows the invalidation ladder `draw -> front -> hull -> field` (§6.3),
and the scope is typed by it:

```ts
sprite.set({ tearAmp: 52 })       // front-class: rebuilds a texture the SPRITE owns
sprite.set({ ambient: 0.5 })      // draw-class on a sprite is legal — the resolution order says so
gridView.set({ ambient: 0.45 })   // draw-class: overridable per view, no second front
detailView.set({ ambient: 0.7 })  // the same garment, darker in the detail panel

// gridView.set({ tearAmp: 52 })
//               ~~~~~~~ not assignable: a front-class knob on a draw-class scope (§6.6). It used
//                       to compile and fail at runtime.
```

Resolution order for a draw: **core defaults -> slot defaults -> sprite -> view.**

A front-class `set()` on a *running* view marks the front dirty and does **not** rebuild eagerly — a
slider dragged at 60 Hz would otherwise fire sixty rebuilds inside one dwell for one visible result.
The rebuild lands at the top of the next step, at most one dwell later; until then the view draws
the last front it drew successfully, at the new pose. Never a blank frame, never a skipped step
(§8.8).

Front-class knobs are sprite-scoped, so one view's edge slider visibly alters another view's
in-flight animation if both show the same sprite. Register the image under two keys if you need
per-view edge treatment.

## 5. A single large view: `present: 'direct'`, `stage.caps` and `exact: true`

```ts
// §4.0: `direct` makes the surface a detached canvas the consumer appends, sizes and positions.
// Views draw into rects of it and nothing is copied — one composited layer instead of N, at the
// cost of keeping the element's geometry synchronised with whatever the views sit on. That
// synchronisation against inertial scrolling on iOS is the cost `blit` exists to avoid.
const stage = await pc.paperStage({
  sheet:   paperSheet({ edgeMode: 'torn', tiles }),
  motion:  bakedMotion({ packs: [pack2x3] }),
  maxSize: 512,
  present: 'direct',              // selects the DirectStage overload
  signal,
})
if (stage === pc.ABORTED) return
if (stage instanceof Error) return stage

// stage: pc.DirectStage. surface.canvas is HTMLCanvasElement on this interface and on no other, so
// the `as HTMLCanvasElement` this line used to need is gone.
container.appendChild(stage.surface.canvas)

const resizeErr = stage.resize(1024, 1024)   // GlError | undefined; the surface never shrinks
if (resizeErr) return resizeErr

// stage.caps re-exports what the GL foundation already graded (§5.1):
// { maxTextureSize: number; floatRT: boolean; timer: boolean }. A consumer choosing maxSize or
// exact needs maxTextureSize BEFORE the first add(), and this is where it comes from.
// exact: true renders the front at the source size, which is +22.3 MB of front and +39.4 MB
// transient during its build (§7.4) — for the single large view, never for a grid.
const hero = await stage.add(heroUrl, {
  key: 'hero',
  exact: stage.caps.maxTextureSize >= 2048,
  signal,
})
if (hero === pc.ABORTED) return
if (hero instanceof Error) return hero

const view = stage.view({ rect: { x: 0, y: 0, w: 998, h: 951 } })  // a DirectTarget: `{ rect }` is
if (view instanceof Error) return view                             // not assignable to a BlitStage
view.show(hero)

// §7.3: one save/restore around a batch of draws. Optional — a bare show() outside a batch still
// saves and restores. A nested batch is a no-op, and fn's return value passes through.
const poses = stage.batch(() => {
  view.show(hero)
  return view.poseCount     // per-pack: 'flat' and 'ball' are the two references that always hold
})
```

`present` has no default and must be written. Three named interfaces — `BlitStage`, `DirectStage`,
`HostedStage` — with three `paperStage` overloads replace the generic `Stage<P extends Present>` an
earlier draft reached for, and the rejection is worth recording because the generic looks obviously
better. Methods in TypeScript are **bivariant**, so `Stage<'blit'>` assigns to `Stage<Present>` and
`.view({ rect })` is then callable on it with no complaint — any `AnyStage` alias offered as the
cure for the parameter leaking into consumer signatures is unsound by construction. And inference
from an options bag collapses to `Stage<Present>` the moment the options are built in a variable
rather than passed as a literal, which is the same hole §6.8 documents for `Partial` patches. The
named interfaces also let `resize()` simply **not exist** on `HostedStage`, rather than existing and
always returning a `GlError`.

## 6. Injecting an existing context (three.js and friends)

```ts
// §4.0.2: injected attributes are GRADED, not matched. The stage owns nothing about this context:
// it never resizes the canvas, never calls loseContext(), and validates the GRANTED attributes
// read from getContextAttributes() rather than a declaration it was handed.
const stage = await pc.paperStage({
  sheet:   paperSheet({ edgeMode: 'hull' }),   // the default mode: no tear, no teeth, no fibre tile
  motion:  bakedMotion({ packs: [pack2x3] }),
  maxSize: 384,
  gl:      renderer.getContext() as WebGL2RenderingContext,
  signal,
})
if (stage === pc.ABORTED) return
if (stage instanceof Error) return stage      // depth: true is hard, always

// stage: pc.HostedStage. There is no resize() on it to call by mistake — the canvas is the host's.
```

| attribute | rule |
| --- | --- |
| `depth: true` | hard, always — without it the ball self-occludes wrongly, which reads as corruption |
| `alpha`, `premultipliedAlpha`, `preserveDrawingBuffer` | hard only if a view targets the default framebuffer; otherwise a `stage.warnings` entry |
| `antialias`, `stencil`, `powerPreference` | advisory always |

three.js grants `alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: false, depth: true`
by default — accepted for a `{ framebuffer }` view, correctly refused for a `{ rect }` one.

```ts
const view = stage.view({
  framebuffer: myRenderTarget.__webglFramebuffer,
  viewport: { x: 0, y: 0, w: 1024, h: 1024 },
  rect:     { x: 64, y: 64, w: 384, h: 384 },
})
if (view instanceof Error) return view
```

A `{ rect }` target on a `HostedStage` is the **one** target check that stays at runtime, and it is
documented as such rather than lamented: it depends on `surface.presentable`, which is the result of
grading the granted attributes above, and no type can know what a context you already built was
granted. Every other target mismatch is now a `HostedTarget` / `DirectTarget` / `BlitTarget`
assignment error.

## 7. A knob panel without TypeScript

`stage.knobs` and `slot.knobs` are `readonly KnobDescriptor[]` **at runtime** — the same descriptors
that generate the types. A `hull` stage exposes 31 knobs, a `torn` one 46 (§6.5).

A descriptor's `key` is **slot-local** (§6.1) and carries no namespace of its own, so build the
panel from the slots rather than from `stage.knobs` — a key a panel writes back has to be one
`stage.set()` can resolve, and only the slot knows which namespace its keys belong to.

```js
// Keep the slot objects you passed to paperStage.
const sheet  = paperSheet({ edgeMode: 'torn', tiles })
const motion = bakedMotion({ packs: [pack2x3] })

for (const [ns, slot] of [['sheet', sheet], ['motion', motion]]) {
  for (const k of slot.knobs) {
    if (k.dev) continue                     // excluded from presets and the default panel
    // A `binds` descriptor is one core-owned value both slots share (§6.2) — paperColor and
    // paperBack — and the bare key is the one that addresses it.
    const key = k.binds ? k.key : `${ns}.${k.key}`
    switch (k.kind) {
      case 'number':
      case 'int':
        // `reference: 'sprite-px'` means the value is quoted against a 1000 px-tall sprite; the
        // renderer rescales it and the UI shows it unscaled (§6.4). Read it as target pixels and
        // the torn edge comes out roughly 2.4x too coarse at 384 px.
        addSlider(key, k.min, k.max, k.step, k.default, k.ui?.label, k.ui?.unit)
        break
      case 'bool':  addToggle(key, k.default); break
      case 'color': addColorPicker(key, k.default); break
      case 'enum':  addSelect(key, k.values, k.default); break
    }
  }
}

// and the write-back, on every change:
const err = stage.set({ [key]: value })
if (err) showValidationError(key, err)      // KnobError: out of range, or an ambiguous bare key
```

That last comment is the reason the namespacing above is not optional. Excluding ambiguous keys from
the flat union is a **type-level** operation on a generated type, and a JavaScript consumer has no
types: the runtime validator still rejects an ambiguous bare key with a `KnobError`, exactly as it
did before. A descriptor loop that writes `stage.set({ [k.key]: value })` therefore works for the
roughly 38 unique keys and comes back with a `KnobError` on `grain` and `debug`, which are the two
the built-in pair collide on (§6.2) — and which are two genuinely different knobs, separately tuned
against a flat sheet and a shaded 3D mesh. A TypeScript consumer never sees this: for them the bare
`grain` does not exist.

## 8. Errors in anger

```ts
const sprite = await stage.add(src, { key, signal })
if (sprite === pc.ABORTED) return                        // abort first, and the type insists (§10.5)
if (sprite instanceof Error) {                           // then errors
  if (pc.GlError.is(sprite)) return hardFail(sprite)     // tag-based; safe across a package seam
  const gl = pc.findCause(sprite, pc.GlError)            // reach a GlError under a PackError
  if (gl) return hardFail(gl)
  return softFail(sprite)
}
```

For dispatch over more than two cases, `matchError` takes a map keyed by `_tag` with a **mandatory**
`else`:

```ts
const message = pc.matchError(err, {
  GlError:    () => 'this device cannot render it',       // keys are `_tag` values (§10.2)
  AssetError: () => 'that image could not be loaded',
  else:       (e) => e.message,      // required, and this is why: §10.2 designs the named union
})                                   // aliases to GAIN MEMBERS in a minor release
```

The named union aliases — `SourceError`, `BuildError`, `LoadError`, `AddError`, `ReadyError`, and
the composed-call results `PlayResult`, `MountResult`, `SwapResult` and `SetResult` (§10.2) — **may
gain members in a minor release.** `if (x instanceof Error)`, `CrumpleError.is(x)` and a
`matchError` with its `else` are unaffected; an exhaustive `_tag` switch will break, and breaking it
is correct, because a consumer who claimed to handle every case no longer does.

Consumer-side relief that does not change a single return type (§10.7):

```ts
const s = stage.get(key)                          // Sprite | undefined — a miss is not a failure,
if (!s) return                                    // so it is not wrapped in unwrap()

const t = await pc.unwrapAsync(stage.add(src, { key }))   // throws; AbortedError on the sentinel

const all = await stage.addAll(entries)
if (all === pc.ABORTED) return                    // a cancelled batch is ABORTED whole — which is
const [ready, failed] = pc.partition(all)         // exactly what lets partition's input exclude it
```

Abort semantics (§10.5): abort means *stop spending, keep what is already paid for.* A hull that
already landed is kept; a half-built front is discarded. An aborted `add()` frees its key. The
shared per-bucket pack fetch is **never** cancelled by a per-sprite `signal` — cancelling a 539 KB
fetch to save bandwidth on a scroll costs a re-download two tiles later. And the factory is held to
its own rule: a `paperStage` whose signal fires mid-flight disposes what it built rather than
handing back a context nobody will receive, which is the `if (signal.aborted) return stage.dispose()`
line every StrictMode-safe React effect would otherwise have to carry.

## 9. Residency, prefetch and the budget

```ts
const io = new IntersectionObserver((entries) => {
  for (const en of entries) {
    const id = (en.target as HTMLElement).dataset.id!
    if (en.isIntersecting) {
      // §8.5.1: invokes the supplier, re-runs the source, rebuilds — ~3 ms end to end at grid size.
      // Unreachable from any synchronous call: a front is never evicted while attached, pinned,
      // or the pending target of a live crumpleTo, so show() can never wait on a decode.
      void stage.prepare(id, { signal: ac.signal })
    }
  }
})

const u = stage.usage()
// { bytes, reclaimable, unreclaimable, fronts, handles, pinned, attached }
// The stage emits ONE warning when `unreclaimable` exceeds `bytes`, naming how many sprites carry
// `pin: true`: the budget bounds the reclaimable set, and cannot bound a set the application has
// forbidden the library to free.
if (u.unreclaimable > u.bytes) console.warn('too much of this grid was pinned at creation')

stage.pin('hero'); stage.unpin('hero')

// The real re-point case — the user uploads a new photo of the same garment. Keeps the key, the
// pins and the attachments; drops the front and invalidates the hull entry. add() on a live key
// returns an Error instead, because the hull cache is keyed on the KEY and not on the image:
// re-pointing silently would give the new sprite the old one's torn edge (§4.1).
await stage.replace('sweater', file)      // a File is a Blob, so it is a SpriteSource
```

`add`, `addAll`, `replace`, `mount` and `swapTo` all take the same `SpriteSource`:

```ts
type SpriteSource =
  | string | URL | Blob
  | ImageBitmap | HTMLImageElement | HTMLCanvasElement
  | (() => Promise<ImageBitmap | Error>)
```

For `string | URL | Blob` the library derives the re-supplier itself, so the sprite is reclaimable by
default and §8.8's byte budget actually bounds it. For a bare `ImageBitmap`, `HTMLImageElement` or
`HTMLCanvasElement` no re-supplier can be derived, and **`pin: true` is required by the type** — a
sprite the budget cannot bound becomes a signed decision instead of an accident. The name matches
`stage.pin(key)` deliberately: same semantics, fixed at creation.

Because the library now supplies its own re-supplier, it is also the party that can break §8.5.1's
rule that a supplier must return the same image the key was registered with — a URL cannot promise
the remote bytes are unchanged. So the rule is enforced rather than merely stated: the `ETag` /
`Last-Modified` of the first response is recorded and re-supply issues a conditional request. A
`304` means unchanged and the rebuild proceeds; a `200` upgrades the rebuild to `replace()`
semantics — the hull entry is invalidated, so the new bytes cannot inherit the old torn edge — and
emits a warning. The limit, stated honestly: a cross-origin response without
`Access-Control-Expose-Headers: ETag` exposes neither header, and there the contract is documented
and unenforced. `Blob` sources are immutable and are not checked.

Steady-state memory at `maxSize` 384 (§8.9, measured on one integrated Intel Iris Xe — quote it as
"measured on X", never as a guarantee): **≈ 49.1 MB at 100 sprites, ≈ 71.9 MB at 1000**, because the
only tier that grows with sprite count is capped by the LRU.

## 10. Teardown, context loss and rebuild

```ts
view.dispose()            // detaches; emits end { completed: false } if a run was live; leaves the
                          // element's last blitted pixels in place — the element is yours

stage.remove('sweater')                    // a SheetError while the sprite is still ATTACHED (a
                                           // refcount: shown by a live view, or the pending target
                                           // of a live crumpleTo)
stage.remove('sweater', { detach: true })  // disposes those views first. The stage knows them
                                           // because mount() created them.

stage.dispose()           // stops every run, releases every GPU resource, and calls loseContext()
                          // ONLY when stage.surface.owned
stage.dispose()           // idempotent — and show(null) / remove() on a disposed stage are no-ops,
                          // because React runs cleanups child-first and a concurrent route change
                          // can invert that order
```

**Context loss has its own channel**, because it is the one error whose documented response is not
"log it" but "dispose and rebuild everything", and sifting `GlError`s out of the general error
stream to recognise it is not a reasonable ask:

```ts
const offLost = stage.on('lost', () => {
  // §4.6: the stage listens for webglcontextlost on its OWN surface — the listener can neither
  // outlive the stage nor collide with one you installed. By the time this fires the stage is
  // already dead and every method returns a GlError.
  stage.dispose()
  void rebuild()          // a new stage, new views on the SAME elements, redraw: no DOM churn
})

if (stage.lost) void rebuild()   // for a subscriber that arrives after the fact
```

Because `{ canvas }` views hold blitted copies rather than references, a lost context freezes the
visible grid at its last correct pose instead of blanking it, which is what makes the rebuild
invisible.

## What the library guarantees about pixels

> **Pose 0 is the source, resampled — and the resample is bit-defined** (§7.4.2).

The guarantee is over the **front texture**, not over a drawn frame. A `{ canvas }` view blits 1:1
only when its backing store equals the front size; any other size resamples through the 2D context's
own filter, which the library does not control. And a drawn frame reproduces the front byte for byte
only when the sheet's screen footprint is an exact, integer-aligned 1:1 map of the front's texel
grid, which the bucket stretch and non-integer cover-scale make untrue in general.

Managed sizing narrows the gap without closing it. The destination backing store is now
`round(cssSize × devicePixelRatio)` capped at the front size, so the stock 300×150 case is gone and
the blit never upsamples; the destination is also cleared before each `drawImage`, so nothing of a
previous sprite survives in the letterbox bars. A 1:1 blit is now reachable — size the CSS box so
that `cssSize × dpr` lands on the front size — rather than accidental, but it is still not the
default and the guarantee above is still the one being made.

Under `exact: true` the resample reduces to a bitwise copy on every channel of every texel,
including RGB under zero alpha.

## The open questions, closed

An earlier draft of this document ended with five places where the design stated a behaviour but not
a signature, and asked that the implementation close them deliberately rather than by accident. All
five are now settled in the spec, and are recorded here rather than deleted because readers of that
draft were told they were open:

1. **`sprite.set()` / `view.set()`** — settled in §6.6. Scope is typed by invalidation class, so a
   front-class knob is not assignable to `view.set` at all; and the contradiction inside §6.6 is
   resolved in favour of the resolution order, so a sprite **may** carry draw-class values (§4).
2. **The return of `set()`** — settled in §6.1 as `KnobError | undefined`, aliased `SetResult`.
   `undefined` and not `void`, so `if (err)` narrows and the result is storable (§4).
3. **The return of `view.play()` / `view.crumpleTo()`** — settled in §4.2 as `Run<R = PlayResult>`,
   a thenable over `R` carrying `done` and `stop()`. `play` returns `Run<PlayResult>`; `crumpleTo`
   and `swapTo` return `Run<SwapResult>`, because they alone can fail with the target's error and
   roll back. It is also the type-level replacement for the prose warning against refactoring
   `crumpleTo` to `async` (§2).
4. **The export shape of `@paper-crumple/paper/tiles`** — settled in §14 as a named `tiles`, which
   is what the import block at the top of this document uses.
5. **`stage.on` versus `view.on`** — settled in §7.1 as `Events[E] & { view: View | null }`, and the
   `error` member of `Events` now carries `observed` as well (§1, §3).
