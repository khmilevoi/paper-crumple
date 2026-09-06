---
'@paper-crumple/core': minor
---

**`view.swapTo` takes a key, and a key already resident is a cache hit.**

`swapTo` minted its own key — `swap:<preset>:<counter>` — and the fold preset is
`presetForImageId(key)` at fit time, so the same picture folded differently on every swap. The
docblock's advice for a caller who wanted a stable key was to call `add()` and `crumpleTo()`
themselves, which meant reimplementing the abort gate that makes a superseded swap stop paying for
an ingest nobody will show.

`swapTo`'s options are now `SwapToOptions` — `SwapOptions` plus one optional `key`:

```ts
view.swapTo(src, { key: 'hero', duration: 400 })
```

- **A fresh key mints nothing.** The `add()` runs under the key you passed, so the fold is stable
  per picture, two views can share one front, and the byte budget can bound the result. A
  superseded swap still aborts that `add()` and frees that key.
- **A resident key is adopted, not refused.** `add()` refuses a live key — the hull cache is keyed
  on `(sprite key, sdfRes, hull knobs)` and the bitmap is not in that key — so A → B → A used to
  fail on its third step. It now short-circuits to `crumpleTo(resident)`: no fetch, no byte
  budget, and `src` is not read at all.
- **Not "instant".** A resident swap is still a full crumple on a non-empty view — rise, ball hold,
  descent. What the cache hit removes is the wait, not the animation.
- **Sharing a front holds only once the first `add()` has settled.** A concurrent second `swapTo`
  on the same key is still refused by `reserved`; re-pointing a live key is still `replace()`.

Additive throughout: `SwapOptions` is untouched — it is shared with `crumpleTo`, which takes a
resolved `Sprite` and for which a key is meaningless — and `SwapToOptions` is exported from the
package root, so an existing `SwapOptions` call site still typechecks unchanged.
