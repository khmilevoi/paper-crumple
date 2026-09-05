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
headless Chromium under a CDP-synthesised user — `sequential` / burst-url / burst-bitmap /
stream / double-swap cadences, plus `idle`, `burst-drag` and DPR 2 — measuring main-thread tasks
(CDP `Tracing` and the `longtask` observer), frame times, input latency and the swap outcomes
against the thresholds its doc comment states for the D3D11 backend. The `double-swap` row prints
its waste as `raw/completed`: raw is every `sheet.source` call beyond one per view — a job the
second wave finds inside `source()` is cancelled at its next check point and still counts, so one
or two by construction — and completed is the calls that ran to their end and returned a handle
for a sprite nobody adopted; only the completed count is gated (0). `--filter`, `--json`
(`BENCH_OUT`), `--iter`, `--profile` (`.cpuprofile` per row, ranked by phase with
`profile-phases.mjs`), `--trace-dump` (`BENCH_TRACE_DUMP=1`, every storm's raw trace events under
`tools/bench/out/traces/`, tens of MB each), `--trace-cats <list>` (`BENCH_TRACE_CATS`, extra
trace categories), `--probe` (`BENCH_PROBE=1`, adds the `*.smooth.probe.ts` isolation probes —
pick one with `-t probe-blit` / `-t probe-stage`) and `--check` (`BENCH_CHECK=1`, the run exits
non-zero when a D3D11 row misses; `--gate` is the old spelling); output under `tools/bench/out/`.
Each row's `stalls:` line is the trace's `gpu` category read for the main thread: how often and
how long it waited on the GPU process (`getError` round trips, a software 2D canvas's
`ReadbackImagePixels`, every `WaitForGetOffset`), the longest single `GPUTask` on the GPU
process's main thread, and the two longest tasks with the event each spent its time in — a spike
reads as a wait or as work from this line alone.

**How to read a run.** Start at the `idle` row: it is the control, and if its frame p95 is not
≈ 16.7 ms with an input max under ~20 ms the machine was busy and the whole run is contended —
discard it rather than reading anything into the other rows. Then check each row's `probe` line:
it is the first check of every verdict and fails unless the CDP trace actually returned tasks, the
synthesised user was handled, the rAF recorder saw frames and the expected number of runs settled;
a row whose `probe` failed measured nothing, and its other checks mean nothing either. Read the
`sequential` row next — thirty awaited `add`s on a stage with no views — because its
`sequentialIdealMs` is the floor every storm's ingest time is divided by, and the same probe runs
per row for the row's own source kind (a bitmap ingest and a URL ingest are different numbers).
Only then read the storm rows, from the `plan[…]` line, which is the flat per-row JSON object
(`summaries[]` in `BENCH_OUT`) printed verbatim: `task max` and `>50` are the hard line, `p95` is
the discriminating one (over the **work tasks**, those of 1 ms or more — sub-millisecond timer
ticks would pin any quantile to zero), `frame p95` is what the reader actually sees, and `ok` /
`rects` / `abort` / `waste` are the correctness columns — thirty swaps must give thirty sprites
with thirty distinct `sprite.rect`s, and `waste` is the superseded ingest that still ran. Each row
runs one cold storm and two timed ones and reports the better (lowest task max, then task p95), so
compare the headline against the per-storm lines beneath it before trusting a single number; two
whole runs, better kept, is the intended protocol. SwiftShader is report-only (spec §11): its
columns exist so a change can be seen off the gate machine, not to be judged against a threshold.

`tools/bake/` will hold the Python pack writer and its unit tests, the Blender launcher, the
synthetic-pack generator, the JS twin writer and the `tiny` fixture. P12 creates it.
`synthetic.bin` (539 KB) is a fixture and must not ship.

The Blender-dependent parts of the bake pipeline — `crumple.py`, `smoke.py`, `foldTable.mjs`,
`folds.json` — are excluded from the published graph. `run.mjs` honours a `BLENDER=` environment
override over its hard-coded Steam path.
