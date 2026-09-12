# @paper-crumple/reatom

Reatom bindings for [paper-crumple](https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme).

Install `@paper-crumple/core` and `@reatom/core` alongside this package. Both are peers;
this package declares no runtime dependencies. Reatom compatibility is tested against
`@reatom/core@1001.3.0`.

The root entry imports neither React nor paper/motion. Choose a stage factory and
keep scene, resource, view, and run models outside the UI. React rendering is optional;
`@paper-crumple/react` accepts the model's minimal render value without `PaperScene`.

```ts
// artwork-model.ts
import { action, withAsyncData, wrap } from '@reatom/core'
import { paperStage } from '@paper-crumple/core'
import { paperSheet } from '@paper-crumple/paper'
import { bakedMotion } from '@paper-crumple/motion'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import { reatomScene } from '@paper-crumple/reatom'

export const scene = reatomScene({
  name: 'artwork.scene',
  create: (signal) =>
    paperStage({
      present: 'blit',
      artworkCssPx: 512,
      sheet: paperSheet(),
      motion: bakedMotion({ packs: [pack2x3] }),
      signal,
    }),
})
export const picture = scene.view({ name: 'artwork.picture', source: '/first.webp' })
export const nextArtwork = action(async (source: string) => {
  await wrap(picture.swap(source))
  return source
}, 'artwork.next').extend(withAsyncData({ initState: null as string | null }))
```

```tsx
import { isAbort, wrap } from '@reatom/core'
import { reatomComponent } from '@reatom/react'
import { Crumple } from '@paper-crumple/react'
import { nextArtwork, picture } from './artwork-model'

// The application owns logging/rejection handling; native .error is the error state.
function handleActionRejection(error: unknown) {
  if (!isAbort(error)) console.error(error)
}
const Result = reatomComponent(() => <output>{nextArtwork.data() ?? ''}</output>, 'Result')
const Failure = reatomComponent(
  () => <output>{String(nextArtwork.error() ?? '')}</output>,
  'Failure',
)
export const Artwork = reatomComponent(
  () => (
    <section>
      <Crumple value={picture.render()} style={{ width: 320, height: 480 }}>
        <span>Loading image</span>
      </Crumple>
      <button
        onClick={wrap(() => {
          void nextArtwork('/second.webp').catch(handleActionRejection)
        })}
      >
        Next image
      </button>
      <Result />
      <Failure />
    </section>
  ),
  'Artwork',
)
```

Native `.data`, `.error`, `.pending` and `.ready` belong to each async command.
Separate subscribers can observe result and error independently; a failed command
retains its previous successful payload. Always handle promises launched from UI
events: reading `.error()` does not consume a rejection. Initial attachment failures
appear on `picture.ready.error()`, while subsequent swap failures appear on
`picture.swap.error()` and on an awaiting business action's `.error()`.
Cancellation rejects as native abort and does not become a user error or a new success.

The owner calls `scene.dispose()` when the model scope ends. Creation is lazy;
attach or an explicit resource command initializes the stage. Unmount only detaches
the canvas, cancels its live operation and disposes the raw View. Shared stage/Sprite
resources remain available. Remount reuses the model with a new raw View. The stable
`picture.ref` can also be attached manually. Atom subscriptions never own GPU resources.
Use a separate model factory for each independent Reatom context. When supplying
`reatomContext.Provider`, create models inside that same owner frame before rendering;
do not move one scene's GPU closure between contexts.

`picture.source`, `.knobs`, and `.options` are desired inputs. Set them directly;
the next explicit `ready()` or `swap()` applies them. Read `.sprite()`, `.shown()`
and `.appliedKnobs()` for actual core state. A rejected update does not become
applied state; a swap may show its new image before animation completion. `swap`
uses latest-request-wins semantics for that view and never queues a detached request.

`picture.play(from, to)` starts synchronously and returns a `RunModel`; `run.stop()`
stops that operation and `run.completion.done` observes async settlement. Scene batch
commands retain core aggregate reports: partial `failed[]` entries are report data,
not a synthesized command error. The application decides how to present them.

Ordinary semantic subscriptions do not track every animation step. Subscribe to
`picture.progress` explicitly for `{ pose, frame, ms }` samples; its initial value is
`null` until an actual step. Removing the last subscription stops that observation.
`picture.readPose()` reads current pose on demand without enabling frame updates.

Resource models (`scene.resource({ name, key, source })`) share stage-owned Sprites.
Use `prepare()` to acquire and `replace(source)` to change the source behind a key.
Borrowed ImageBitmap/image/canvas sources require `pin: true`; the caller owns a
borrowed bitmap. Suppliers must return a fresh bitmap on every call and core closes
it. A retained model cannot restore a removed Sprite from an already-closed bitmap;
retain a usable source or supplier for later reconstruction. Direct and Hosted views
use typed rect/framebuffer targets and have no canvas `ref` or `render()`.
