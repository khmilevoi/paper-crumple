---
'@paper-crumple/core': minor
'@paper-crumple/paper': minor
'@paper-crumple/motion': minor
---

`View.frame`, `SheetFront.artwork`, and a reserve that is actually frozen.

**`View.frame`** reports where the shown sprite's *artwork* lands in the box the view draws into —
`{ box: Size, artwork: Rect }`, both in that box's pixels, `null` while no front is resident. It
is the one number a consumer pinning the picture (rather than the paper) at a fixed on-screen
rectangle needs, and the one nothing else said: `Sprite.rect` is the paper's box and
`Sprite.frontSize` the whole front. The motion slot centres the sheet on the paper's box, which
the hull grows asymmetrically around the picture, so the artwork is neither the box's centre nor a
constant fraction of it — reconstructing it outside the library needed `rect`, `frontSize`, a
second decode of the source and an invariant (`fit` frozen, `frontRect` drifting) that only holds
at `add()`. The accessor is derived from the same placement rule `resolveTarget` already relies on.

**`SheetFront.artwork`** is the field that makes it possible: the unpadded artwork's box in the
built front, which `paperSheet().build()` had as `placement` all along and now reports next to
`rect`. This is an addition to the `SheetRenderer` contract (spec 5.2): a custom sheet slot must
now report it. Every slot in this family does.

**`paperSheet()` freezes the overscan reserve at the factory's defaults plus `overscanHeadroom`,
scaled by the sprite's aspect — never at the live knob values.** `maxDist` is both a hull-tier
knob and the whole of `r_hull`, so a reserve derived from the live values was re-frozen on every
hull-tier re-source: `p` grew, `A = maxSize / (1 + 2p)` shrank, and the artwork rescaled inside a
bucket `fit` had sized once at `add()` — spec 8.6's forbidden silent clamp, as a silent rescale.
`build()`'s `checkReserve` already compared against the factory reserve; `source()` now agrees
with it. A knob past the reserve is "re-add required", as spec 8.6 says, and `overscanHeadroom`
is the way to buy room. The `PaperSheet.overscan` doc comment states the reading and why the
literal one — "the values at first `add()`" — is not implementable by a `source()` that has no
memory of an earlier handle.
