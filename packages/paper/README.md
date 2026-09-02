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

## Edge modes

`paperSheet({ edgeMode })` is a factory option and not a knob, because it changes which set of
knobs exists at all. `'hull'` is the default and needs no tile: it traces the artwork's alpha and
cuts the sheet to it. `'torn'` adds the tear, the teeth and the fibre, and is the mode that reads
the paper tiles.

## The tiles subpath

```ts
import { tiles } from '@paper-crumple/paper/tiles'
```

Four 512×512 grayscale WebP files — 333 KB in total — carrying the only four channels the shader
ever samples. They are **opt-in**, and `paperSheet()` defaults to `tiles: null`: the default edge
mode is `hull`, which needs no tear, no teeth and no fibre at all, so the modal consumer would
otherwise be charged for an asset their configuration cannot use. Without them the sheet renders
against a neutral texel — the render with the photograph turned off, not a render with garbage in
it.

The subpath exports a **named** `tiles` rather than a default, so the specifier and the identifier
match and a reader of the import line can tell what it brought in.

## Relationship to core

`@paper-crumple/core` is a **peer dependency** at `^1.x`, and the two packages share one version
number. If you are wrapping this package, declare core in your own `peerDependencies` and never in
`dependencies` — core's README explains why, under "For wrapper authors".

## Licence

MIT.
