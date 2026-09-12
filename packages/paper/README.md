# @paper-crumple/paper

The `SheetRenderer` half of **paper-crumple**: the signed distance field, the looseness blur, the
hull tracer, the torn edge, folds, the facet mosaic and the shadow — plus every CPU primitive
exported separately rather than hidden behind the effect.

> The family's documentation lives in core's README:
> <https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme>. Errors are
> values here too — nothing throws, `ABORTED` is a sentinel and not an `Error`, and a failing
> promise resolves to an `Error` rather than rejecting.

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

## The edge: shape, finish, width

`paperSheet({ edgeShape, edgeFinish })` are factory options and not knobs, because together they
pick which set of knobs exists at all. Choose `edgeShape: 'none'` to disable the paper edge and its
finish completely, preserving the artwork's alpha contour and the other sheet and motion effects.
This shape exposes no edge width, shape or finish knobs; `edgeFinish` is ignored.

For `smooth` and `torn`, `edgeWidth` is an animatable **knob** controlling the paper margin.
At `edgeWidth: 0`, `torn` with `edgeFinish: 'paper'` keeps a narrow ragged band directly outside
the artwork's alpha contour, without a flat paper strip and without cutting into the image.
The existing `deckleWidth` controls this intrinsic band; setting it to `0` removes its width.
To migrate an old zero-width configuration intended to remove all edge decoration, use
`paperSheet({ edgeShape: 'none' })` instead.

One qualifier on "animatable", because the two shapes pay different prices for it. Under
`edgeShape: 'torn'` the width is a **front-tier** knob: a new value re-renders the front and nothing
else. Under `edgeShape: 'smooth'` it is **hull-tier** — the polygon is traced at the width — so every
distinct value re-sources the sprite, which costs a field readback and a trace. Still no rebuild of
the stage, and still fine for a handful of steps; not something to drive at 60 Hz under `smooth`.

|                       | `edgeFinish: 'clean'`                            | `edgeFinish: 'paper'`                                                          |
| --------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `edgeShape: 'none'`   | original alpha contour, no edge                  | original alpha contour, finish ignored                                         |
| `edgeShape: 'smooth'` | plain cut, no tile needed                        | clean silhouette, deckle band, fibres and tear shadow                          |
| `edgeShape: 'torn'`   | ragged noise-thresholded contour, no tile needed | the ragged contour plus the paper finish — the mode that reads the paper tiles |

`edgeShape: 'smooth'` is the default and traces the artwork's alpha with a CPU polygon (straight
runs, sharp corners); `edgeFinish: 'clean'` is the default and adds nothing to the rim. Only
`edgeFinish: 'paper'` reads the `tiles` subpath below.

The decorated combinations expose these counts of knobs from the `sheet` slot alone:
`smooth`/`clean` **24**, `smooth`/`paper` **30**, `torn`/`clean` **28**, `torn`/`paper` **34**
(design 2026-09-05 §2.4).

## The tiles subpath

```ts
import { tiles } from '@paper-crumple/paper/tiles'
```

Four 512×512 grayscale WebP files — 333 KB in total — carrying the only four channels the shader
ever samples. They are **opt-in**, and `paperSheet()` defaults to `tiles: null`: the default is
`edgeShape: 'smooth'`, `edgeFinish: 'clean'`, which needs no tear, no teeth and no fibre at all, so
the modal consumer would otherwise be charged for an asset their configuration cannot use. Without
them the sheet renders against a neutral texel — the render with the photograph turned off, not a
render with garbage in it.

The subpath exports a **named** `tiles` rather than a default, so the specifier and the identifier
match and a reader of the import line can tell what it brought in.

## Relationship to core

`@paper-crumple/core` is a **peer dependency** at `^1.x`, and the two packages share one version
number. If you are wrapping this package, declare core in your own `peerDependencies` and never in
`dependencies` — core's README explains why, under "For wrapper authors".

## Licence

MIT.
