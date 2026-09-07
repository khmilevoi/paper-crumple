---
'@paper-crumple/core': patch
---

Add the normative `identityResample` reference and the resource accounting.

`identityResample` and `axisPlan` are a single-pass, all-integer, alpha-weighted area filter whose
weights are quantised to `Q = 128` per axis, so the two-dimensional total is `T = 16384` at every
ratio. Identity at ratio 1 is a structural property of the formula, not a fast path, and CI
compares the short-circuit copy against the general path so it cannot drift. `sizeForDisplay`
rounds a display footprint up to the next multiple of 64; `sdfResFor` is measured on the front's
long side. `overscanFor` derives the paper margin per sprite from its edge parameters instead of
the two hard-coded copies of `0.28`, and `checkGuardBand` returns an `Error` rather than letting
the shader's hard cut slice the scrap flat. `frontBytes`, `handleBytes` and `scratchBytes` close
the budget of spec 8.9, with the front LRU that governs its one per-sprite tier.
