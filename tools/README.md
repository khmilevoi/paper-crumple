# tools

Kept in the repository and never published (spec §13). `pnpm-workspace.yaml` lists `packages/*`
and nothing else, so nothing here is a workspace package and nothing here can reach a tarball —
the guarantee is structural rather than a matter of discipline.

`tools/bench/cpu/` is the CPU benchmark suite (`pnpm bench:cpu`): the per-add geometry
(`cpu.sdf.*`, `cpu.contours.*`, `cpu.hull.*`, `cpu.ingest.1024`, …), the scheduler and knob paths
over a 64-view grid with fake slots (`cpu.step.grid64`, `cpu.knobs.patch`), and the GL call
counts the real slots issue per operation against a recording `WebGL2RenderingContext`
(`calls.add.1024.hull`, `calls.step.grid64`, …). It runs the packages' sources under plain Node
through a resolve hook (`loader.mjs`), writes JSON to `BENCH_OUT` (default `tools/bench/out/`,
gitignored) and, with `--profile`, a `.cpuprofile` per scenario that `profile-summary.mjs` ranks.

`tools/bench/smooth/` is the smoothness bench (`pnpm bench:smooth`; `BENCH_GPU=1` for ANGLE
D3D11 as with `bench:gl`): thirty on-screen `{ canvas }` views swapping 1024² artworks in
headless Chromium under a CDP-synthesised user — burst / stream / double-swap cadences, URL and
pre-decoded-bitmap sources, DPR 1 and 2 — measuring main-thread tasks (CDP `Tracing` and the
`longtask` observer), frame times, input latency and the swap outcomes against the thresholds
its doc comment proposes for the D3D11 backend. `--filter`, `--json`, `--iter`, `--profile`
(`.cpuprofile` per row, ranked by phase with `profile-phases.mjs`) and `--gate`; output under
`tools/bench/out/`.

`tools/bake/` will hold the Python pack writer and its unit tests, the Blender launcher, the
synthetic-pack generator, the JS twin writer and the `tiny` fixture. P12 creates it.
`synthetic.bin` (539 KB) is a fixture and must not ship.

The Blender-dependent parts of the bake pipeline — `crumple.py`, `smoke.py`, `foldTable.mjs`,
`folds.json` — are excluded from the published graph. `run.mjs` honours a `BLENDER=` environment
override over its hard-coded Steam path.
