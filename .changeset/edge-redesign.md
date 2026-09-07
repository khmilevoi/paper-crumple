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
- the shader's `baseAngular` term must be small, and **on real artwork it usually is not**.
  `baseAngular` replaces the base field with its piecewise-linear interpolant on a lattice of side
  `L = 1000 / (tearFreq * 1.2)` reference px — 417 at `tearFreq: 2`, 93 at the shipped 9, 35 at 24
  — and on a convex feature of local curvature radius `rho` the interpolant falls below the field
  by the chord sag, pulling the contour inward by about `tearAngular * L^2 / (8 * rho)`. That pull
  scales as `1 / rho`: at the shipped `tearFreq: 9` it is `857 / rho` reference px, so 2.5 on the
  343-reference-px arc the test disc presents, 8.6 on a feature of radius 100, and more than
  `edgeWidth * edgeVariance` itself on anything sharper. There is therefore no single number to
  subtract — the `1 / rho` law above is the whole statement, and a reader who wants their own case
  evaluates it at their own `rho`.

**So the dependable guarantee under `torn` is `0.4 * edgeWidth`, not `edgeWidth * (1 - edgeVariance)`.**
The shader's `tearFloor` clamps the inward reach at `0.4 * edgeWidth` unconditionally
(`paper-shader.ts`, `tearOf`), and on any convex detail with `rho` below roughly 260 reference px
at the shipped defaults that floor — 18.8 reference px at `edgeWidth: 47` — is what actually stops
the tear, since `edgeWidth * (1 - edgeVariance)` less the `baseAngular` pull has already fallen
under it. Most of a real silhouette is that sharp. The clean `edgeWidth * (1 - edgeVariance)` is
the refinement, recovered where the pull is below a texel — at `tearAngular: 0`, or at a
`tearFreq` high enough that `tearAngular * L^2 / (8 * rho)` is negligible **for the `rho` in hand**
(on the test disc that threshold is around `tearFreq: 12`; on a feature ten times sharper it is not
reached inside the knob's range at all).

**A fourth boundary, on the reserve rather than on the width.**

- **The reserve bounds the alpha BOX, not the distance from the alpha.** `overscanRadius` reserves
  `reserve.radius` reference px around the artwork's alpha bounding box per axis, and
  `checkGuardBand` holds that grown box inside the front; across four fixtures, `tearFreq`
  {2, 9, 24}, `tearAngular` {0.8, 1} and three lattice phases no painted texel left it (worst
  `64.81` of `83.91`). The Euclidean distance from the alpha is NOT bounded by `reserve.radius`
  inside a concavity: `baseAngular`'s interpolant pushes the webbed contour outward along the
  exterior medial ridge, and on a 20-texel slit between two lobes the paper sat up to `117.95`
  reference px from the alpha (`84.33` at the shipped `tearFreq: 9`), about 11 texels past the
  box's edge and 37 reference px inside the reserve. The box bound is measured, not derived: the
  worst geometry for it is a notch opening AT the box edge with a gap just under `2 * edgeWidth`,
  which puts the web outside the box before the push starts. That fixture was built and measured —
  two flat teeth 30 texels apart, gap against `2 * edgeWidth = 30.5` — and it did NOT approach the
  reserve: the web reached `61.73` of `83.91` out through the gap's mouth, never past the teeth's
  own outline, and the fixture's worst cell overall was `64.81` (margin `19.10`, 22.8 %).

**A sixth correction to the design document, alongside the five the plan already lists.** §6's
table states `uThickness = W` in all four `shape x finish` cells. That is wrong under `smooth`:
the polygon already sits at `edgeWidth * (1 ± edgeVariance)`, so biasing it outward by `edgeWidth`
again would reach `2 * edgeWidth`. The shipped code sets the outward bias to `0` under `smooth`
instead, and the design document is being corrected to match rather than the other way around.

Folds now read on a torn edge: both contour shapes carry a solid annulus for a fold line to fall
on, which `torn` never had.
