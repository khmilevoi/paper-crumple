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
