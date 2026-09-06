---
'@paper-crumple/core': minor
'@paper-crumple/paper': minor
---

Replace `EdgeMode` with three orthogonal settings.

`paperSheet({ edgeMode })` is gone. In its place: `edgeShape` (`'smooth' | 'torn'`), `edgeFinish`
(`'clean' | 'paper'`) and `edgeWidthUnit` (`'px' | 'percent'`), with the paper's width moved out
of the look knobs and into one animatable `edgeWidth` knob (plus `edgeVariance` for how far it
wanders along the contour). `edgeWidth = 0` is "no edge": the silhouette collapses onto the
artwork's alpha and the finish switches off with it.

Breaking, and freely so — nothing has been released:

- `EdgeMode`, `PaperEdgeMode` and `descriptorsFor(mode)` are deleted.
- `minDist`, `maxDist`, `tearAmp`, `midAmp` and `thickness` cease to be knobs; the first two are
  derived as `edgeWidth (1 ± edgeVariance)` and the next two from the budget `edgeWidth *
  edgeVariance - 1.6 * chew`. `thickness` never described a thickness — it was the contour's own
  width in all four of its uses — so it has become `edgeWidth`.
- `tearMix` is new; `looseness` survives as a pure shape knob.
- Presets that stored any deleted key must be regenerated. The playground's own URL fragment is
  one such preset: `#edgeMode=...` links are **not** carried forward — `edgeMode` is simply an
  unknown fragment key now, and a saved link built for the old vocabulary loads the new defaults
  instead of erroring.
- `PaperSheet.overscan` is now an upper bound rather than every sprite's exact reserve.

**Migration is otherwise quiet.** Legacy `hull` becomes `paperSheet({})` — `edgeShape: 'smooth'`,
`edgeFinish: 'clean'` — and keeps its render inside spec §9.1's one-texel parity band, aligned on
`artworkRect`. Legacy `both` becomes `smooth`/`paper`; legacy `torn` becomes `torn`/`paper`, its
width now fixed instead of drifting with `looseness`. `torn`/`clean` is a genuinely new
combination with no legacy equivalent — the ragged contour with no deckle, no fibres and no tear
shadow.

**A narrowing you should know about.** The reserve radius cap moves from 500 to 482 reference px
(`RADIUS_CAP_REFERENCE_PX`), because the guard band that protects a full-bleed bitmap is now
counted against the same ceiling as the paint reserve. Its real consequence: with every finish
knob pushed to its maximum, the legal `overscanHeadroom` ceiling drops from `0.316` to
**`0.268`**. A caller running near the old ceiling — `overscanHeadroom >= 0.27` at extreme
`edgeWidth` / `edgeVariance` / `fiberLen` / `deckleWidth` — now gets a `KnobError` naming the
reserve radius where `develop` used to render.

**The percent unit's default is `5.9`, not the design document's `5.7`.** `5.9` is the value that
actually reproduces `W = 46.9785` reference px on a square at the library's own default
`overscanHeadroom: 0`; `5.7` was derived at `edgeVariance: 0`, an operating point the shipped
default (`0.53`) does not sit at, and does not reproduce.

**The front grows about 5.2 %** (308 → 324 texels on the reference fixture), because the guard
margin that used to be one aspect-free additive term is now a per-axis one. Anything a caller
measures in `sprite-px` scales with the front, so a measurement taken against `develop`'s front
will read about 5 % larger here at the same knob values.

**Knobs that feed the reserve are bounded by the sheet, not by their own declared range.**
`edgeWidth`, `edgeVariance`, `fiberLen` and `deckleWidth` are each capped, on a given sheet, by
that sheet's frozen reserve — push past it and `build()` answers "re-add required" rather than
silently clipping. This is **not new**: it is byte-identical to `develop`, where the same
mechanism already capped `maxDist` at 72 of its declared 140 — the new names just make the ceiling
visible instead of quietly absorbing it. `overscanHeadroom` is the lever: raise it before the
build to raise every one of these ceilings together.

**The `edgeWidth (1 ± edgeVariance)` band is exact only inside three documented boundaries** —
`packages/paper/src/edge-derive.ts` states all three and this note does not claim more than that
file does:

- the tear budget must be unclamped (`edgeWidth * edgeVariance > 1.6 * chew`, roughly
  `edgeVariance > 0.06` at the shipped defaults);
- `edgeVariance` must stay below `0.6` — above it `tearFloor = tight + 0.4 * edgeWidth` binds
  first, and the true lower reach becomes `max(edgeWidth * (1 - edgeVariance), 0.4 * edgeWidth)`;
  and
- the shader's `baseAngular` term must be small. `baseAngular` replaces the base field with its
  piecewise-linear interpolant on a `uTearFreq * ANG_FREQ` lattice, which pulls the contour inward
  by roughly `ang * L^2 / (8 * rho)` — about 50 reference px at `tearFreq: 2`, checked only by the
  tear floor above. **At the shipped defaults the precise lower-reach law is
  `edgeWidth * (1 - edgeVariance) - 2.5`, not the clean `edgeWidth * (1 - edgeVariance)`**; the
  clean form holds at `tearAngular: 0` or at a `tearFreq` above roughly 12.

**A sixth correction to the design document, alongside the five the plan already lists.** §6's
table states `uThickness = W` in all four `shape x finish` cells. That is wrong under `smooth`:
the polygon already sits at `edgeWidth * (1 ± edgeVariance)`, so biasing it outward by `edgeWidth`
again would reach `2 * edgeWidth`. The shipped code sets the outward bias to `0` under `smooth`
instead, and the design document is being corrected to match rather than the other way around.

Folds now read on a torn edge: both contour shapes carry a solid annulus for a fold line to fall
on, which `torn` never had.
