---
'@paper-crumple/react': minor
---

Add `@paper-crumple/react`, the React binding deferred by the packages spec. This release carries
the scene layer: `usePaperScene`, `<PaperScene>` and `useScene`, over `@paper-crumple/core` and
`react` as peer dependencies and with no runtime dependencies at all.

The scene builds a `BlitStage` from a consumer-written `create`, rebuilds only when `deps` change,
aborts the in-flight build and disposes the landed one on cleanup, diffs `knobs` at one
`stage.set` per changed key, and moves to `status: 'failed'` when the WebGL2 context is lost.
Nothing in the package throws.
