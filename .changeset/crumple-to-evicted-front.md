---
'@paper-crumple/core': patch
---

**A swap onto a sprite whose front the byte budget evicted no longer reports "the front is not
resident".**

Under a budget that holds fewer fronts than there are sprites — a gallery that prefetches its
samples, then swaps to one of them — `view.swapTo(src, { key })` took §5.3's cache-hit branch,
found the KEY resident and handed `crumpleTo` a bare `Sprite` whose FRONT was not. The rebuild
`crumpleTo` runs at the ball is synchronous only, and §8.5 keeps one artwork slot, so the
commonest case answered `SourceExpiredError` and scheduled an asynchronous re-source instead. The
first render of the descent then drew a record whose `front` was still `null`, and the view
reported `the front is not resident; prepare() it first` — while the stage was, at that moment,
preparing exactly that front.

- **`crumpleTo` now routes a front-less sprite through `prepare()`**, which is the one demand that
  waits for a re-source (§8.5.1), and hands the run the promise form of the same target. The run
  parks at the ball until the front is drawable, which is what the park is for. A resident front
  is untouched: no promise, no park, and the synchronous adopt of every ordinary swap is
  unchanged. `swapTo` inherits the fix, because its cache hit goes through `crumpleTo`.
- **A rebuilt front is attached again.** An eviction deletes the LRU's slot, and `attach`, `pin`
  and `hold` are no-ops for a key the LRU does not hold, so the insert that ends a rebuild created
  a fresh slot with `attachCount: 0` — and §4.5's "an attached sprite is unevictable" was then
  false for exactly the sprite a view was showing. `rebuildFront` now restores the pin and the
  attachments the way `replace()` always has, and `replace()`'s own restore is guarded so a slot
  that survived is not attached twice.
