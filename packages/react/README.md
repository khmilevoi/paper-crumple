# @paper-crumple/react

The React binding for **paper-crumple**: `usePaperScene`, `<PaperScene>` and `useScene` — a
thin, reactive layer over a `BlitStage` you build yourself with `paperStage(...)`. This release
carries the scene only; it ships no component that owns a `<canvas>`.

> The family's documentation lives in core's README:
> <https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme>. Errors are
> values here too — nothing in this package throws, nothing reaches an error boundary, and no
> promise it returns rejects. `error` is a field on the scene and `status` is a value to branch
> on, exactly the way `stage instanceof Error` is elsewhere in the family.

<!-- shared:install-and-import -->

## Install

```sh
npm install @paper-crumple/core @paper-crumple/react react
```

```tsx
import * as pc from '@paper-crumple/core'
import { paperSheet } from '@paper-crumple/paper'
import { tiles } from '@paper-crumple/paper/tiles'
import { bakedMotion } from '@paper-crumple/motion'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import { PaperScene, usePaperScene, useScene } from '@paper-crumple/react'

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
      <Tile canvas={{ src: '/before.png' }} />
    </PaperScene>
  )
}

function Tile({ canvas: { src } }: { canvas: { src: string } }): JSX.Element {
  const scene = useScene()
  return (
    <canvas
      ref={(el) => {
        if (el === null || scene.stage === null) return
        const view = scene.stage.view({ canvas: el })
        if (view instanceof Error) return
        void (async () => {
          const sprite = await scene.stage!.add(src, { key: src })
          if (sprite instanceof Error || pc.isAborted(sprite)) return
          view.show(sprite)
          // `show()` **is** the degraded swap — instant, pose 0, no run — so honouring
          // `prefers-reduced-motion` needs no extra API from this package either.
          if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
            await view.swapTo('/after.png')
          }
        })()
        return () => view.dispose()
      }}
    />
  )
}
```

<!-- /shared:install-and-import -->

## What this package is

Three exports, and that is the whole surface of this release:

- **`usePaperScene(options)`** builds the `BlitStage` your `create` factory returns, rebuilds it
  only when `deps` changes, aborts an in-flight build and disposes a landed one on cleanup, diffs
  `knobs` at one `stage.set` per changed key, and moves `status` to `'failed'` when the WebGL2
  context is lost. It never touches the DOM.
- **`<PaperScene value={scene}>`** is a context provider and nothing else — it renders no DOM of
  its own, so it costs nothing under SSR.
- **`useScene()`** reads the nearest `<PaperScene>`. Called outside one, it returns a permanently
  `'failed'` scene carrying an `Error` that says so, rather than throwing.

`scene.play(from, to)` and `scene.stop()` are the only imperative surface; both are no-ops (an
empty, `completed: false` report from `play`) on a scene that is not `'ready'`, so a consumer
never has to guard a call on `status` first.

## Peer dependencies, and nothing else

```json
"peerDependencies": { "@paper-crumple/core": "^1", "react": "^19" }
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

React 19 only — no `^18.3` range.

## Errors are values here too

Nothing in this package throws, and nothing it returns rejects. A `create` that throws is caught
and turned into `status: 'failed'` with `error` set, exactly like a `create` that returns an
`Error`; a lost WebGL2 context moves the same scene to `'failed'` with `lost: true`. There is no
error boundary this package expects you to install, because there is nothing here for one to
catch.

## Licence

MIT.
