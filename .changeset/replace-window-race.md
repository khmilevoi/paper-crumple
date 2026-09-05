---
'@paper-crumple/core': patch
---

**`stage.replace()` guards the window between its release and its rebuild** (spec §8.5, §8.8,
§8.10).

While a replacement is being sourced and built, the key's record holds neither a handle nor a
front. A `prepare(key)`, or a front-class `set()` on a sprite a view is showing, that landed in
that window used to build from the released handle: either a front the replace then overwrote
without releasing it (a leak), or a re-source of the OLD image that ran ahead of the background
replace and, landing after it, installed the old image under a `replace()` that had already
resolved. The replace now registers itself as the key's in-flight re-source for the length of its
rebuild, so those demands wait on it the way they wait on a re-source (§8.5.1), and it re-checks
the record's identity afterwards: a `remove(key)` inside the window wins — the halves the rebuild
produced go back to their slots, nothing is inserted into the LRU under the removed key, and the
replace resolves to a `SheetError` that says so.
