# @paper-crumple/react

The React binding for **paper-crumple**: `usePaperScene`, `<PaperScene>` and `useScene` build the
scene — a thin, reactive layer over a `BlitStage` you build yourself with `paperStage(...)`.
`useCrumple` and `<Crumple>` sit on top of it and own one sprite's whole state machine, including
the `<canvas>` it draws into.

> The family's documentation lives in core's README:
> <https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme>. Errors are
> values here too — nothing in this package throws, nothing reaches an error boundary, and no
> promise it returns rejects. `error` is a field on both the scene and the crumple; `status` (the
> scene) and `state` (the crumple) are values to branch on, exactly the way `stage instanceof Error`
> is elsewhere in the family.

<!-- shared:install-and-import -->

## Install

```sh
npm install @paper-crumple/react @paper-crumple/core @paper-crumple/paper @paper-crumple/motion react
```

```tsx
import * as pc from '@paper-crumple/core'
import { paperSheet } from '@paper-crumple/paper'
import { tiles } from '@paper-crumple/paper/tiles'
import { bakedMotion } from '@paper-crumple/motion'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import { Crumple, PaperScene, useCrumple, usePaperScene } from '@paper-crumple/react'

function Gallery(): JSX.Element {
  // You write the `paperStage(...)` call; both parameters `usePaperScene` hands you go into it.
  const scene = usePaperScene({
    create: (signal, onError) =>
      pc.paperStage({
        present: 'blit',
        cssPx: 512,
        sheet: paperSheet({ tiles }),
        motion: bakedMotion({ packs: [pack2x3] }),
        signal,
        onError,
      }),
    deps: [],
  })

  if (scene.status === 'failed') return <p>{scene.error.message}</p>
  return (
    <PaperScene value={scene}>
      <Hero selected={{ id: 'hero', src: '/paper.jpg' }} />
    </PaperScene>
  )
}

function Hero({ selected }: { selected: { id: string; src: string } }): JSX.Element {
  // The default reducedMotion: 'auto' consults matchMedia('(prefers-reduced-motion: reduce)')
  // before entrances and swaps, showing the target directly when reduced motion is preferred.
  const crumple = useCrumple({
    spriteKey: selected.id,
    src: selected.src,
    entrance: 'uncrumple',
    frameTo: 360,
  })

  return (
    <>
      <Crumple value={crumple} className="hero">
        {crumple.shown === null ? <span>Loading…</span> : null}
      </Crumple>
      {crumple.parked ? <span>Loading the next picture…</span> : null}
    </>
  )
}
```

<!-- /shared:install-and-import -->

## What this package is

The scene and the crumple:

- **`usePaperScene(options)`** builds the `BlitStage` your `create` factory returns, rebuilds it
  only when `deps` changes, aborts an in-flight build and disposes a landed one on cleanup, diffs
  `knobs` at one `stage.set` per changed key, and moves `status` to `'failed'` when the WebGL2
  context is lost. Its discriminated snapshot carries generic build metadata: `status` discriminates
  `stage`, `meta`, and `error`. It exposes `onReady`, `onFailed`, and `onKnobRefused` callbacks;
  reset goes through `stage.defaults`, and the positional overload `usePaperScene(create, deps,
options?)` is supported too. It never touches the DOM.
- **`<PaperScene value={scene}>`** is a context provider and nothing else — it renders no DOM of
  its own, so it costs nothing under SSR.
- **`useScene()`** reads the nearest `<PaperScene>`. Called outside one, it returns a permanently
  `'failed'` scene carrying an `Error` that says so, rather than throwing.
- **`useCrumple(options)`** owns one sprite's whole lifetime against the nearest `useScene()` (or
  the `scene` option, for a second scene on one page). It opens a `View` when a `ready` scene and
  an attached canvas coincide, disposes it when either goes away, acquires `spriteKey`/`src`
  through one per-stage, in-flight-deduplicated path, plays the entrance, and swaps to a new `src`
  under the same key through `view.swapTo` (or `view.crumpleTo` if the target acquisition is
  already in flight) — reduced motion is consulted at the swap, not cached at mount. It returns
  a `Crumple`: a reactive snapshot (`state`, `parked`, `pose`, `shown`, `requested`,
  `error`, `frame`, `frameStyle`, `view`) plus the identity-stable `ref`, `play`, `stop` and
  `refresh`. Its snapshot also includes `status`, `sprite`, `pending`, and `artworkStyle`, with
  `draw`, `sync`, and `retry` methods. `state` is one of the core's own view states while a view
  exists, and `'detached'` while none does. The `Crumple` object itself is deliberately **not**
  identity-stable — it is a fresh object every render — so depend on `crumple.shown` or
  `crumple.play`, never on `crumple` itself. `onSettle` is the request-completion callback for
  animated completion, degraded show, and rollback; superseded and unmounted requests do not
  settle to the consumer.
- **`<Crumple value={crumple}>`** is the component that owns the `<canvas>`: a positioned wrapper
  sized from `crumple.frameStyle`, a `<canvas ref={crumple.ref}>` inside it, and `children`
  rendered as a placeholder layered over the canvas while `crumple.shown === null`. `canvasProps`
  is the escape hatch for the canvas element itself; it excludes `ref`, `width` and `height` at
  the type level, because `size` is always `'managed'` and nobody but the stage writes `width` and
  `height` on the canvas.

`CrumpleOptions`, `CrumpleProps`, `CrumpleSnapshot`, `CrumpleState`, `CrumpleFrameStyle`,
`SceneBuild`, `SceneSnapshot`, `CreateStage`, `StageErrorListener`, `CrumpleStatus`,
`CrumplePending`, `CrumpleSettleEvent`, and `CrumpleArtworkStyle` are exported too, for typing a
wrapper around `useCrumple` or `<Crumple>` without redeclaring its shapes. For consumer tests,
use `@paper-crumple/react/testing`; the render harness remains internal.

`scene.play(from, to)` and `scene.stop()` are the scene's own imperative surface; both are no-ops
(an empty, `completed: false` report from `play`) on a scene that is not `'ready'`, so a consumer
never has to guard a call on `status` first. `crumple.play(from, to)`, `crumple.stop()` and
`crumple.refresh()` work the same way on the crumple — each is a safe no-op (`play` returns
`null`) while no view exists yet, so a consumer never has to guard on `state` either.

## Peer dependencies, and nothing else

```json
"peerDependencies": {
  "@paper-crumple/core": "^1",
  "react": "^19",
  "typescript": ">=5.0"
},
"peerDependenciesMeta": {
  "typescript": { "optional": true }
}
```

This package has **no runtime dependencies at all** — `dependencies` in its manifest is an
explicit empty object, not an absent key. `@paper-crumple/core` and `react` are both peers, for
the same reason core gives for its own slots: a wrapper that lists core as a regular dependency
can land a second copy in the graph, and across that seam `instanceof` lies about an `Error` that
is the right class. If you are publishing your own wrapper around this package, declare
`@paper-crumple/core` in **your** `peerDependencies` too, and never in `dependencies`.

**`@paper-crumple/paper` and `@paper-crumple/motion` are not imported by this package at all**,
not even as types. You write the `paperStage(...)` call yourself inside `create`, so `sheet` and
`motion` reach the stage without passing through any type this package declares.

TypeScript is optional and has no runtime weight. `@paper-crumple/paper` and
`@paper-crumple/motion` are example dependencies, not React package peers.

React 19 only — no `^18.3` range.

## Errors are values here too

Nothing in this package throws, and nothing it returns rejects. A `create` that throws is caught
and turned into `status: 'failed'` with `error` set, exactly like a `create` that returns an
`Error`; a lost WebGL2 context moves the same scene to `'failed'` with `lost: true`. There is no
error boundary this package expects you to install, because there is nothing here for one to
catch.

The crumple works the same way: a refused acquisition or a swap whose target fails is reported
through `crumple.error` (and `onError`, if you passed one) rather than thrown; a failed swap rolls
back to the sprite that was already shown, so the canvas never lands ahead of what `crumple.error`
says happened.

## Licence

MIT.
