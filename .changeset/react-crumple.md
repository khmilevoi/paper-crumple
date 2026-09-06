---
'@paper-crumple/react': minor
---

Add `useCrumple` and `<Crumple>` to `@paper-crumple/react`.

`useCrumple` creates a `View` when a `ready` scene and an attached canvas coincide and disposes it
in the ref's own cleanup, acquires its sprite through one per-stage, in-flight-deduplicated path
that joins a re-source rather than showing an evicted front, plays the `show` → `draw` → `play`
entrance, and swaps on a `spriteKey` change through `view.swapTo` under the caller's own key — so
the fold preset is stable per picture and a swap back to a picture already seen costs no fetch.
A changed `src` under an unchanged key is reported rather than silently shown. Reduced motion is
consulted at the swap, not at mount. `state`, `parked`, `pose`, `shown`, `frame` and `frameStyle`
are served through `useSyncExternalStore` over a store the binding versions on every call it makes
into the core, because the default entrance, every reduced-motion swap, every `draw`, every landed
re-source and the whole ball park emit no event at all.

`<Crumple>` renders a positioned wrapper, the canvas and a placeholder layered over it while
nothing is shown. Nothing in the package throws.
