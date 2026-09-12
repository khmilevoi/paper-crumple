---
'@paper-crumple/react': major
---

Complete the React scene, request lifecycle, and consumer testing APIs for the staged 1.0.0 release.

`usePaperScene` now accepts `usePaperScene(create, deps, options?)` as well as the options object.
`Scene<M>`, `SceneOptions<M>`, `<PaperScene>` and `useScene<M>()` carry metadata returned as
`SceneBuild<M>`. `onReady` reports the landed build with its generation and abort signal;
`onFailed` reports startup failures and context loss. Refused declarative knob writes now reach
`onError` and the new `onKnobRefused(key, value, error)` callback. Removing a declarative knob key
resets it when that exact key exists in `stage.defaults`; undeclared keys and refused resets are
silently skipped. The core default map is covered by the existing core changeset.

The scene types now discriminate on `status`: `ready` carries a stage and metadata, `failed`
carries an error, and `building` carries neither. Consumers constructing scene fixtures must
provide the fields for the matching branch. `SceneCounters` and `SceneMethods` name the shared
parts. The binding's `KnobValue` export is removed; use `Knobs` or `Knobs[string]` from
`@paper-crumple/core`. `CreateStage<M>` and `StageErrorListener` name the scene factory and error
callback types.

`useCrumple` adds `pending` and `onSettle` to track request completion across animated entrances,
swaps, reduced-motion shows, and rollback. `shown` still changes at adoption during the fold;
use `pending` or `onSettle` when waiting for the whole request. Settlement fires once per completed
request, with superseded and unmounted requests suppressed. `status` exposes acquisition and
rollback alongside the view state, `sprite` reports the shown sprite, and `retry()` retries the
current source without changing its key. Reentrant callbacks cannot publish a superseded run or
settlement, and a current request's frame error is preserved while a later successful request
clears an older error.

`draw(pose)` updates the pose and snapshot together; `sync()` publishes state after direct view
operations. `artworkStyle` provides the artwork dimensions at the same scale as `frameStyle`.
Frame styles are derived during render, followed by a refresh after the first sized frame commits,
so first entrances use the correct backing-store dimensions. `parked` clears when the swap leaves
the ball. The new request, status, settlement, and artwork-style types are exported from the root.

The new `@paper-crumple/react/testing` subpath exports `createFakeStage`, its typed handles and call
logs, `deferred`, `buildingScene`, `readyScene`, `failedScene`, and `detachedCrumple`. These pure
fixtures work without a browser or WebGL context and stay separate from the production root entry;
ReactDOM render helpers remain internal. Documentation covers these APIs, direct `File` sources,
automatic reduced motion, and consumer hook tests.
