# @paper-crumple/core

The orchestrator and the contracts of the **paper-crumple** family: the stage, views, the knob
registry, the scheduler, events, the WebGL2 foundation and the error classes. This README is the
family's documentation entry point; `@paper-crumple/paper` and `@paper-crumple/motion` point back
here.

## Errors are values

Nothing in this family throws. A call that can fail returns `Error | T`, the caller narrows with
`instanceof Error` and exits early, and TypeScript will not let the check be skipped:

```ts
const stage = await paperStage({ present: 'blit', cssPx: 512, sheet, motion })
if (stage instanceof Error) return
// `stage` is a BlitStage from here on.
```

Four rules follow from that, and every one of them is load-bearing:

- **Cancellation is a sentinel, not an error.** `ABORTED` is a `Symbol.for('paper-crumple.aborted')`
  and never an `Error`. An operation that takes a `signal` carries `| Aborted` in its return type
  and one that does not never mentions it, so the type tells you whether a call is cancellable.
  Narrow it with `isAborted(x)`.
- **A promise that fails resolves to an Error rather than rejecting.** There is no `.catch()` to
  forget and no unhandled rejection to lose.
- **Narrow across a package boundary with `Err.is()`, not `instanceof`.** Two copies of this package
  in one realm make `instanceof` lie; every error class carries a static `.is()` that does not.
  `GlError.is(e)` where you would have written `e instanceof GlError`.
- **`on()` never returns an `Error | T`.** Subscribing cannot fail.

The helpers are `attempt` (wrap a throwing boundary), `matchError` (exhaustive with a mandatory
`else`), `partition`, `unwrap` / `unwrapAsync` (for the call site that genuinely wants a throw) and
`findCause`. The named result unions — `SourceError`, `BuildError`, `LoadError`, `AddError`,
`ReadyError`, `PlayResult`, `SwapResult`, `MountResult`, `SetResult` — are exported and **may gain
members in a minor release**. Annotate with the alias, never with its constituents.

<!-- shared:install-and-import -->

## Install

```sh
npm install @paper-crumple/core @paper-crumple/paper @paper-crumple/motion
```

```ts
import { isAborted, paperStage } from '@paper-crumple/core'
import { bakedMotion } from '@paper-crumple/motion'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import { paperSheet } from '@paper-crumple/paper'
import { tiles } from '@paper-crumple/paper/tiles'

async function crumple(canvas: HTMLCanvasElement): Promise<void> {
  const stage = await paperStage({
    present: 'blit',
    cssPx: 512,
    sheet: paperSheet({ tiles }),
    motion: bakedMotion({ packs: [pack2x3] }),
  })
  if (stage instanceof Error || isAborted(stage)) return

  const before = await stage.add('/before.png', { key: 'before' })
  if (before instanceof Error || isAborted(before)) return

  const view = stage.view({ canvas })
  if (view instanceof Error) return
  view.show(before)

  // `show()` **is** the degraded swap — instant, pose 0, no run — so honouring
  // `prefers-reduced-motion` needs no extra API.
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const after = await stage.add('/after.png', { key: 'after' })
    if (after instanceof Error || isAborted(after)) return
    view.show(after)
    return
  }

  await view.swapTo('/after.png')
}
```

Five module specifiers, and that is the floor rather than an oversight: the pack and the tiles live
on their own export subpaths so that an author who bakes their own animation never drags in
someone else's megabytes. `tiles` and the pack are both opt-in — `paperSheet()` defaults to
`tiles: null` and renders without grain, and `bakedMotion({ packs })` takes its packs explicitly.

<!-- /shared:install-and-import -->

## What is in the box

Three packages, one version number. Each is first-class and installable on its own.

| Package                 | Subpath                           | What it holds                                                                                                                                                             |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@paper-crumple/core`   | `.`                               | `paperStage()`, views, sprites, the knob registry, the scheduler, events, the error classes and every contract type.                                                      |
| `@paper-crumple/core`   | `@paper-crumple/core/unstable`    | The slot-authoring surface: `GlContext`, `compile`, `createTarget`, the GPU timer, `SheetHandle`, `MotionFit`, `MotionClip`.                                              |
| `@paper-crumple/paper`  | `.`                               | `paperSheet()` — the `SheetRenderer`: SDF, looseness blur, the edge (shape, finish, width), folds, facet mosaic and shadow, plus every CPU primitive exported separately. |
| `@paper-crumple/paper`  | `@paper-crumple/paper/tiles`      | The four baked grayscale paper tiles, 333 KB, opt-in. Named export `tiles`.                                                                                               |
| `@paper-crumple/motion` | `.`                               | `bakedMotion()` — the `MotionSource`: the CRMP v1 parser, codecs, buckets, fit and the sheet program.                                                                     |
| `@paper-crumple/motion` | `@paper-crumple/motion/packs/2x3` | One baked pack, one module, one subpath. Also `.../packs/1x1` and `.../packs/3x2`.                                                                                        |

The three share **one version number**, fixed by Changesets. That is not a convenience: both slots
bind to core's concrete GL foundation, the knob registry couples them at the value level, the
context attributes are a cross-package runtime invariant, and class identity is a public contract.
Divergence is not merely unlikely — the design forbids it, and with no umbrella package the shared
number is the only visible signal that these ship as a family.

Both slots declare core as a **`^1.x` peer** — a caret, never a tilde. Minors here are additive, so
a tilde would turn every routine upgrade into a three-package flag day with peer warnings through
every partial state on the way.

## @paper-crumple/core/unstable

Everything a third party needs to _build_ a slot — `GlContext`, `compile`, `createTarget`, the GPU
timer, `SheetHandle`, `MotionFit`, `MotionClip` — lives behind the `/unstable` subpath and
**may change in any release, including a patch**. The contract _types_ stay at the stable root: a
consumer writing `const s: SheetRenderer = paperSheet()` imports from `@paper-crumple/core` and
never needs `/unstable` at all.

It is an import path rather than a JSDoc tag because an import path greps cleanly and shows up in a
diff, and TypeScript does not enforce a tag.

## For wrapper authors

If you are publishing a package that wraps this family, declare `@paper-crumple/core` in
**`peerDependencies`** and never in `dependencies`.

An application that installs core directly alongside both slots resolves to one copy under every
modern package manager, so the application's own install was never the hazard. A third-party
wrapper that lists core as a regular dependency is: it can land a second copy in the graph, and
across that seam `instanceof` is `false` for errors that are the right class. Call
`assertSingleCore()` at startup — it returns a `CoreDuplicateError` rather than throwing, so you
decide whether a duplicate core is a startup failure or a logged degradation — and narrow with
`Err.is()` rather than `instanceof` in any code that crosses a package boundary.

## Reduced motion

`view.show(sprite)` is instant — pose 0, no run — so it _is_ the degraded swap, and honouring
`prefers-reduced-motion` needs no API of its own. The branch in the install block above is the whole
accommodation.

## Prefetching the next swap

`view.swapTo(url)` in the install block above is `add()` + `crumpleTo(pending)` behind one call, and
its `add()` starts at the click. When you already know what comes next, start it earlier: every
asynchronous ingest runs through one stage-wide, prioritised lane, `add()` is its **background**
class, and a background job is promoted to the head of the lane the moment a `crumpleTo` holds the
promise it returned. Keep that promise and hand it to `crumpleTo`: a prefetch still in flight at
the click is promoted and adopted when it lands, a landed one is a resident sprite, and neither
pays a second ingest. `swapTo(url)` is for a key never prefetched — on one whose prefetch is in
flight it would queue a second ingest of the same image behind the running one.

```ts
// At idle, once the current page is on screen. The promises are the prefetch.
const prefetched = new Map<string, ReturnType<typeof stage.add>>()
for (const n of nextPage) {
  const pending = stage.add(n.url, { key: n.id, signal })
  prefetched.set(n.id, pending)
  void pending.then(() => prefetched.delete(n.id)) // settled: `stage.get` is the truth now
}

// At the click: a resident sprite, else the pending add, else the ordinary swap.
const target = stage.get(next.id) ?? prefetched.get(next.id)
const run =
  target !== undefined ? view.crumpleTo(target, { signal }) : view.swapTo(next.url, { signal })
```

A superseded `swapTo` aborts the `add()` it started, and an aborted `add()` frees its key, so
clicking through five pages costs one ingest rather than five. `docs/USAGE.md` §9 has the whole
story, budget included.

## CDN and playgrounds

There is no single `esm.sh/paper-crumple` URL, and that is a real cost rather than an oversight:
three scoped packages with peer relationships are awkward on that kind of host, where you will
write three pinned specifiers or an import map instead of one line. The trade was taken knowingly —
an umbrella package could not have re-exported the pack and tile subpaths without defeating the
point of having them.

## Requirements

WebGL2. `"engines": { "node": ">=22" }` is published metadata for contributors and CI; Node loads
none of this code.

## Documentation

All three packages point `homepage` here:
<https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme>

## Licence

MIT.
