# @paper-crumple/motion

The `MotionSource` half of **paper-crumple**: the CRMP v1 pack format and its parser, the float16
and octahedral-normal codecs, aspect buckets, fit, the sheet program and its thirty-six
preconfigured VAOs.

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

## One pack, one module, one subpath

```ts
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import pack1x1 from '@paper-crumple/motion/packs/1x1'
import pack3x2 from '@paper-crumple/motion/packs/3x2'

const motion = bakedMotion({ packs: [pack2x3, pack1x1] })
```

`bakedMotion` takes its packs **explicitly**, and the main entry imports `./packs` not at all.
There is no dynamic form and that is deliberate: a template-literal `new URL()` over a bucket name
compiles to a static module map in Vite and a context module in webpack, and all three packs land
in every bundle — which is exactly what these subpaths exist to prevent. `sideEffects: false` does
not help, because it is a module-granularity hint and cannot eliminate entries of a
dynamically-indexed object literal.

A bucket you did not supply returns an `AssetError` naming the subpath you forgot to import.

Each module inlines its manifest, reaches its binary through
`new URL('./2x3.bin', import.meta.url)` from a module shipped beside it, and exports the Blender
provenance as a separate `sim` binding so that a consumer who does not import it pays nothing for
it.

## Relationship to core

`@paper-crumple/core` is a **peer dependency** at `^1.x`, and the two packages share one version
number. If you are wrapping this package, declare core in your own `peerDependencies` and never in
`dependencies` — core's README explains why, under "For wrapper authors".

## Licence

MIT.
