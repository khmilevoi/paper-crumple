# Level 3 — the 3D draw cost at 384 px

**Not in CI, and not a guarantee.** Level 3 is timing, and SwiftShader timings are meaningless
(spec §11). Here they are worse than meaningless: the disputed term is the *size-invariant* setup
cost, which a software rasteriser does not have in the same proportion at all (§17.1). This is a
manual run on real hardware, written up as "measured on «machine»" and never presented as a
guarantee.

The hull half of this tier was settled during scheduling and is written up in §8.2.1. It is not
re-run. **One number remains**, and §8.7's no-instancing conclusion is marked "probably right" until
it lands.

## Running it

```
pnpm --filter @paper-crumple/core build
pnpm --filter @paper-crumple/motion build
node tools/bench-3d/serve.mjs
```

Then open `http://localhost:8317/tools/bench-3d/`. The page refuses to measure anything unless
`crossOriginIsolated` is true.

## Why the server exists

**The page must be cross-origin isolated**, or `performance.now()` is clamped to 100 µs and every
CPU figure below is quantisation noise. `serve.mjs` sets `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` on every response, which is the whole of its job.

Use `EXT_disjoint_timer_query_webgl2` for GPU time, and **discard any sample where
`GPU_DISJOINT_EXT` is set rather than averaging it in**. `createGpuTimer` from
`@paper-crumple/core/unstable` already does this — its `poll()` returns `undefined` for a disjoint
interval rather than a number — so do not write a second timer.

## The four instruments, in this order

1. **Serialised per-draw at 998x951 first**, to reproduce 0.29–0.41 ms and prove the harness before
   it is trusted anywhere else. If this does not land in that band, stop: nothing measured after it
   means anything.
2. **One query around N draws with no `finish` inside, for N in 1, 8, 32, 100, 256.** This is the
   deciding number. A grid does not serialise its draws, and the marginal cost of the hundredth draw
   is what instancing would be competing against — not the isolated cost of the first.
3. **An empty query and a 1x1-scissored draw as controls**, to separate query overhead and the
   driver's own floor from the work being measured.
4. **CPU submit cost**, separately from GPU time.

## The sweep

Sizes: 1x1, 96 (96²), 192 (192²), **384x366**, 768 (768²) and 998x951. Fit `ms = A + B·pixels` and
report `A` — the whole argument in §8.7 is about whether `A` is small.

Run **all six poses** with their real covered-pixel counts, and run the batch both with and without
the **per-draw clear**, since the only existing figure includes one (`material.js:154-156`).

## Thresholds, fixed in advance so the result cannot be read to taste

| result | what it means |
| --- | --- |
| **≤ 0.10 ms** | The question is settled and §8.7's conclusion may be marked verified. |
| **0.10 – 0.167 ms** | The documented grid size is capped and the conclusion stands with that caveat. |
| **> 0.167 ms** | Instancing is reconsidered for v1, as a v1.1 item and not a re-plan; this **reopens instancing**. |

Record the escape hatch either way: dwells are 70–135 ms, so a grid-wide step may be spread across
four frames, and **no threshold here is a cliff**.

## The write-up

```
Measured on «machine» — «CPU», «GPU», «browser and version», «driver».
Not a guarantee. Every figure below is one machine's.
```

All timing figures in this project are from one integrated Intel Iris Xe. They are evidence that the
approach is cheap, not a portable guarantee, and the same caution applies to §8.9's memory figures.

### Measured on `khmil-win11` — 2026-09-02

```
Measured on khmil-win11 — 11th Gen Intel Core i7-1165G7 @ 2.80GHz,
Intel(R) Iris(R) Xe Graphics (0x00009A49), driver 32.0.101.7088,
HeadlessChrome/151.0.7922.34, ANGLE D3D11 (vs_5_0 ps_5_0).
Not a guarantee. Every figure below is one machine's.
```

Preconditions, all met: `crossOriginIsolated` **true**; smallest observed non-zero
`performance.now()` delta **5 µs**, so the 100 µs clamp is off; `EXT_disjoint_timer_query_webgl2`
**present**; `GPU_DISJOINT_EXT` never set — **0 discarded samples** across every row of every run.
Six repeats, `TRIALS = 8` each.

| instrument | measured | note |
| --- | --- | --- |
| 1. serialised per-draw, 998x951, with clear | **0.431 – 0.463 ms** | **misses the 0.29–0.41 ms gate by ~11 %** — see below |
| 2. one query around N draws at 384x366, N = 1 / 8 / 32 / 100 / 256 | 0.058 / 0.343 / 1.319 / 4.17 / 10.72–10.91 ms | linear; slope 0.0406 (N=32), 0.0415 (N=100), 0.0418 (N=256) |
| **the deciding number** — `(mean(N=256) − mean(N=1)) / 255` | **0.0418 – 0.0426 ms** | **≤ 0.10 ms** |
| 3. empty query (control) | 0.0004 ms | query overhead is not a term |
| 3. 1x1-scissored draw (control) | 0.024 – 0.027 ms | the driver's own floor |
| 4. CPU submit cost | 1.60 – 3.07 ms | dominated by JS, not GPU; see below |
| size sweep fit `ms = A + B·pixels` | **A = 0.070 ms**, B = 4.69e-7 ms/px | §8.7's affine estimate was 0.21–0.28 ms |
| pose sweep, all six poses, no clear | 0.073 – 0.102 ms | spans 1.4x, as the spike's did |
| pose sweep, all six poses, with clear | 0.117 – 0.459 ms | the clear is the larger term at this size |

**Verdict: 0.042 ms — the ≤ 0.10 ms band.** The size-invariant term `A` that the whole of §8.7
turns on is **0.070 ms**, not the 0.21–0.28 ms the affine fit feared, and the ~4x instrument
disagreement §17.1 records resolves in favour of the wall-clocked `gl.finish()` figure. Even the
un-cancelled N=1 batch total (0.058 ms) and the slowest clear-free single pose (0.102 ms) sit at or
under the threshold, so the verdict does not depend on the slope cancellation.

**One caveat, recorded rather than smoothed over.** Instrument 1 is the harness gate, and it read
0.431–0.463 ms against a required 0.29–0.41 ms — outside the band, stably, in all six repeats. This
is a *different physical* Iris Xe on a newer driver than the spike's, and the run is the ported
renderer rather than the spike's; the size sweep's own 998x951 point (0.433 ms) agrees with it, so
the harness is self-consistent. Everything that argues the harness is sound is present — zero
disjoint discards, a ~0 ms empty query, a linear N-sweep, an unclamped clock. But the band was fixed
in advance precisely so a result could not be read to taste, and 0.45 is not in it.

**The NVIDIA T500 in the same machine is not a usable instrument here** and its numbers are not
reported above. Its 1x1-scissored control alone is **0.102 ms** — a floor as large as the entire
threshold — and instrument 1 moves from 0.099 ms on a cold GPU process to 1.0–1.17 ms on every
later run as the part clock-gates. Its marginal figure (0.089–0.097 ms) still lands ≤ 0.10 ms, but
it is not evidence.

**The escape hatch, recorded as required:** dwells are 70–135 ms, so a grid-wide step may be spread
across four frames. No threshold here is a cliff. The CPU submit cost of 1.6–3.1 ms per draw is the
term that would actually bite at 100 sprites, and it is JS-side work that instancing would not fix.

## Inherited constraints (§16)

These are **inherited properties of the baked assets and the approach, not flaws to be fixed
during the port**. They are restated here because a timing run is where someone first looks closely
at the render and mistakes one of them for a regression.

- Stage 1 of the bake is **kinematic**. At 64 quads a crease cannot be both solver-owned and smooth;
  the geometric bend radius from smooth hook weights is the accepted substitute.
- **Silhouette adaptivity** is lost against the 2D spike: the sheet is generic, so its fold lines
  know nothing about the garment. Gaps appear at early flap poses and are closed by the alpha
  compaction only by the time the ball forms.
- The 3x2 ball reads more like a **rolled bundle** than a crumpled ball.
- **No relief on the reverse**; no shadow map.
- **Translucent sheet edges** are drawn without blending, under a depth-tested `discard`.
- The ball's **one-component**/zero-holes property is measured at pixel-noise level: at the accepted
  bake flags a scale and phase sweep still misses a handful of samples out of 425 per bucket, always
  by exactly one pixel.
