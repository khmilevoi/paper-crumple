# Reatom performance measurements — 2026-09-11/12

Fresh measurements for runtime `0ad408fb8907b5fc67b01bbcacb94f3ac4f99d4a` retain the
151,344-byte estimate per unobserved 64-view step, matching the frozen baseline. CPU timing
deltas have mixed signs, and `stage.add` retains a 3,448-byte setup increase. Both complete
browser runs passed their correctness and measurement checks, but their idle input controls
show contention. SwiftShader timing remains report-only; no new numerical budget, causal
speedup, or D3D11 acceptance result is claimed.

The current-revision section below contains all 22 original CPU workloads, both observer CPU
distributions, both complete browser runs and their controls. Earlier `67eb4356` measurements
and the allocation investigation are explicitly retained as historical evidence. They do not
measure the current runtime. The original baseline predates the adapter APIs, so comparisons
against it do not isolate Reatom overhead.

## Reproduction and interpretation

The original baseline is commit `b506f6511546222f6d36b5a9616705e23be63f8a`. Its frozen CPU JSON
and both smooth JSONs are preserved under `tools/bench/out/` with their original filenames. The selected
historical smooth run is `reatom-baseline-smooth-run2-b506f651.json`, whose idle control reported
frame p95 16.70 ms and input maximum 16.90 ms. Task 1's behavior-tested hull-mask fixture repair
remains part of both sides of the original-workload comparison.

CPU runs use Node 26.5.0 (V8 14.6.202.34-node.24) on Windows 10.0.26200 and an Intel i7-1165G7. The source loader resolves
the real core, paper, motion and adapter code; GL operations use the existing recording context
or fake slots. Smooth runs use HeadlessChrome 151, ANGLE Vulkan SwiftShader, the built ESM
packages, viewport 1400 × 900, and three timed storms after one cold storm. Reatom core is pinned
to 1001.3.0.

The original 22 CPU workloads and nine smooth rows run before Reatom is imported. The new CPU
and browser observer registries defer native and adapter imports until their setup executes.
A child-process regression records module resolution and verifies that importing either registry
does not load Reatom. Each of the three new modes loads the same runtime outside its timing
window. Earlier eager-import results are retained as diagnostics, not used as final historical
comparisons.

CPU p50 is the harness's existing `medianMs`; p95 is interpolated from its sorted single-call
samples. Sampling retains the existing 200 ms warmup, 1000 ms timed target, 15 minimum and 20,000
maximum iterations. The allocation column is the median heap-plus-array-buffer growth over five
single calls after forced GC. It is an estimate, and a lower bound when GC runs inside a call;
it is not an allocation-event count or retained-memory measurement.

The smooth headline uses the timed storm with the lowest task maximum, then task p95. Every
headline metric comes from that same storm; frame p95 is not separately minimized. All cold and
timed storms remain in the JSON. Independent complete runs are judged first by their idle
controls, without choosing a run on the adapter's favorable timing. Correctness and measurement
probe checks remain mandatory on SwiftShader, while D3D11 timing thresholds remain inapplicable.

## Observer workloads and structural evidence

All three CPU modes issue the same raw `stage.play('flat', 'ball')` and one deterministic dwell
tick across 64 views, using the same fake source, knob descriptors, slots and clock implementation.
Adapter attachment settles during setup. Every operation drains native notifications for the
observed modes so deferred progress publication is included in their measured cost. The fake
motion's draw log is reset during untimed preparation to bound memory across repeated calls.

The three smooth modes reuse the existing 30-view URL burst, artwork pool, 900 ms swap duration,
150 CSS-pixel artwork size, 64 MiB budget, paper tiles, motion packs, recorders and iteration count.
They wrap already-mounted raw views; timed commands remain the original raw `swapTo` calls.
The observer modes are appended after the original nine rows.

| Mode     | Observed values per view        | CPU native area / step connections | Smooth native area / step connections |
| -------- | ------------------------------- | ---------------------------------: | ------------------------------------: |
| raw      | none                            |                              0 / 0 |                                 0 / 0 |
| semantic | shown key, frame, applied knobs |                            192 / 0 |                                90 / 0 |
| progress | semantic values plus progress   |                           192 / 64 |                               90 / 30 |

The connection counts instrument actual native subscription calls made by observation, after
command-controller attachment; they are not invented mode labels or totals of unrelated harness
listeners. Each CPU scenario exports its observed counts and post-disposal evidence. Smooth JSON
stores before/after counts for every storm and final cleanup counts.

The focused regression verifies equal poses and draw counts across CPU modes, zero semantic
publications and zero `view.frame` getter reads during a dwell tick, and exactly 64 progress
publications only in progress mode. Disconnect removes every measured subscription while the
shared stage remains alive; subsequent owner disposal releases both slots. The browser rows
assert actual subscription counts, trace/input/frame probe validity, 30 successful distinct
rectangles and pixel hashes, and zero remaining measured connections after disposal.

The CPU import helper explicitly owns native BroadcastChannels created during Reatom's module
initialization and closes them after import; the persistence extensions are unused by this
benchmark. It restores the native constructor. CPU runs and child-process regressions terminate
naturally, without using a forced process exit as cleanup evidence.

## Historical commands — 67eb4356

Build and repository acceptance gates are recorded in the Task 11 implementation report.
Measurements run sequentially, with no competing task-owned build, test or browser job:

```powershell
rtk proxy node --import ./tools/bench/cpu/loader.mjs --expose-gc tools/bench/cpu/run.mjs --out tools/bench/out/reatom-final-cpu.json
rtk proxy node --import ./tools/bench/cpu/loader.mjs --expose-gc tools/bench/cpu/run.mjs --filter reactivity --out tools/bench/out/reatom-comparison-cpu.json
rtk proxy node tools/bench/smooth/run.mjs --iter 3 --json tools/bench/out/reatom-final-smooth-run1.json --browser.api.port=63400 --browser.api.strictPort
rtk proxy node tools/bench/smooth/run.mjs --iter 3 --json tools/bench/out/reatom-final-smooth-run2.json --browser.api.port=63400 --browser.api.strictPort
```

Port 63400 is checked before use. Existing user browser sessions and unrelated processes are
preserved. Scoped escalation permits the existing worktree dependency junctions; no dependencies
are upgraded or reinstalled for measurement.

## Historical investigation and limits — through 67eb4356

The lazy-import CPU diagnostic at `62926753` reports slower original workloads than the historical run.
For example, `cpu.step.grid64` changes from p50/p95 0.0391/0.1124 ms to 0.0707/0.1902 ms,
and `cpu.stage.add` from 0.0163/0.0326 ms to 0.0325/0.0787 ms. The corresponding heap-growth
estimates increase by 3,072 and 3,600 bytes per operation. Core now maintains observable revisions
and entity change publishers. The focused investigation below identifies a clean-path context
allocation and part of the setup bookkeeping; it does not isolate their entire timing cost.

Numerical kernels with unchanged paper/motion source also vary: `cpu.sdf.512` p95 is 18.9166 ms
at baseline, 39.1350 ms in the eager-import diagnostic, and 24.60 ms in the lazy-import diagnostic.
The source comparison against the baseline contains no changes under `packages/paper/src` or
`packages/motion/src`. Host free memory changed from 2.85 GiB before diagnostics to 12.70 GiB
before the lazy-import runs; the process inventory still reported 194 host Node processes. These facts
limit causal attribution of cross-session timing differences. The report does not claim that
all original workload regressions are absent or entirely explained by host noise.

All six recording-GL scenarios retain their baseline total call counts and synchronous-query
counts. The 64-view step still records 4,800 calls, zero synchronous queries and zero state
captures. This is evidence against added GL work in these workloads; it does not measure GPU
execution time or erase the CPU deltas above.

The standalone and full-run observer distributions differ despite identical mode definitions.
Report their absolute cost per 64-view operation and per view; do not read a faster semantic
median in one run as a speedup caused by subscriptions. These runs are descriptive measurements,
not randomized paired trials or a statistical confidence interval.

The initial one-iteration browser probe passed its structural and correctness checks but had
idle input maximum 30.5 ms, so its timing is excluded. An earlier complete eager-import smooth
run passed all 12 rows and had idle frame p95 16.7 ms / input maximum 17.6 ms; it is also retained
only as a diagnostic because the final registries now defer adapter imports. Diagnostic files
are named `reatom-diagnostic-*-eager.json` and `reatom-smooth-probe.json` under `tools/bench/out`.

The complete lazy-import smooth diagnostic at `62926753` passed all 12 rows, but its selected
idle storm had frame p95 16.8 ms and input maximum 28.3 ms. Its timing is contended. The complete
CPU, standalone CPU, smooth and environment files are preserved as
`reatom-diagnostic-{cpu,comparison-cpu,smooth,environment}-pre-context.json`.

### Allocation attribution before the final runtime correction

The actual compiled `stepOnce` at `62926753` begins with V8's
`CreateFunctionContextWithCells`, before testing `host.needsRenderBatch`. Capturing `r` and
`step` in the conditional batch callback therefore allocates a context even on a clean,
unobserved dwell step. No production file was changed for the negative control: a process-local
loader moved only that callback into a cold helper. The control's `stepOnce` bytecode contains
no function-context or closure creation. This bytecode evidence is specific to Node 26.5.0's
V8; Node 22 and 24 were not measured. Both behavior probes produced 64 views at pose 1,
128 step events including startup, 64 pending timers and unchanged semantic revisions.

The focused grid allocation estimate was 136,544 bytes per operation for current source and
130,352 for the loader control. The final-probe GC counter was zero in both runs; the harness
resets that counter per probe and records only the final probe, so GC during earlier probes
cannot be excluded. Their p50/p95 values were
0.0394/0.1139 ms and 0.0392/0.1324 ms respectively. This is structural evidence of an avoidable
clean-path allocation, not a timing improvement claim or exact accounting of the earlier
48-byte-per-view difference. Heap and JIT variation prevent that stronger interpretation.

HeapProfiler sampling over 100 `stage.add` calls attributed approximately 1.1 KiB per add to
each of the view and sprite `createChanges` initializations, with similar results in both
processes. These are one-time entity publisher allocations, not per-frame notification payloads.
The sampled approximately 2.2 KiB per add only partially explains the earlier 3,600-byte setup
increase. Listener sets are created on subscription; the unobserved dwell branch does not
enqueue or flush semantic change payloads.

Evidence is retained under `tools/bench/out/reatom-allocation-{current,cold-helper-control}`:
`.json` records behavior and heap estimates, `.heapprofile` records sampled allocation stacks,
and `-bytecode.txt` records the actual compiled wrapper. The production correction was
independently reviewed and committed as `67eb4356da4cd809d0473a0a80c249476df8c8bd`; it moves
the capturing callback into a cold helper while preserving the batch boundary. Final CPU and
both complete smooth measurements use the reviewed correction after rebuilding all packages.

After that correction, the final full CPU run reports exactly 151,344 bytes per 64-view step,
matching the historical estimate and removing the pre-correction 3,072-byte difference in this
run. Its p50/p95 remain 0.0611/0.1706 ms versus baseline 0.0391/0.1124 ms. `stage.add` remains
35,598 bytes per operation versus 31,990, with p50/p95 0.0342/0.0831 ms versus 0.0163/0.0326 ms.
The context fix resolves the identified clean-path allocation; it does not establish absence
of timing regressions or remove the one-time publisher setup cost. The full run and standalone
observer comparison below preserve their differing distributions.

## Current runtime measurements — 0ad408fb (2026-09-12)

These fresh measurements use clean runtime revision `0ad408fb8907b5fc67b01bbcacb94f3ac4f99d4a`, after all five packages were rebuilt. The prior measurements at `67eb4356` remain historical evidence below; they are not measurements of this revision. Full CPU generated at 2026-09-12T00:09:59.187Z; standalone CPU at 2026-09-12T00:10:28.101Z. Smooth run IDs: 2026-09-12T00:11:05.733Z, 2026-09-12T00:19:31.407Z. Node v26.5.0, V8 14.6.202.34-node.24, Windows 11 Pro 10.0.26200, 11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz. Both browser runs use Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36; renderer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver); viewport 1400 × 900, three timed storms plus one cold storm per row.

The same methodology and unchanged workload definitions described above apply. CPU measurements use the source loader; browser measurements use freshly rebuilt ESM packages. SwiftShader remains report-only, with no new numerical budget or D3D11 acceptance claim. Execution and correctness success do not imply timing acceptance against the historical baseline.

### All 22 original CPU workloads at the current revision

Times are milliseconds; bytes/op retain the five-probe heap-growth caveat. Deltas use the frozen baseline, not the earlier adapter measurement.

| Scenario                 | Baseline p50 | Current p50 | p50 delta | Baseline p95 | Current p95 | p95 delta | Baseline bytes/op | Current bytes/op | Bytes delta |
| ------------------------ | -----------: | ----------: | --------: | -----------: | ----------: | --------: | ----------------: | ---------------: | ----------: |
| cpu.sdf.512              |      17.1068 |     17.1525 |     +0.3% |      18.9166 |     21.9433 |    +16.0% |           3180376 |          3180376 |          +0 |
| cpu.sdf.1024             |      69.3974 |     68.8732 |     -0.8% |      75.6208 |     79.9312 |     +5.7% |          12643016 |         12643016 |          +0 |
| cpu.sdf.1024.photo       |      69.3560 |     69.2150 |     -0.2% |      75.4232 |     78.3522 |     +3.9% |          12643016 |         12643016 |          +0 |
| cpu.contours.512         |       0.4524 |      0.4048 |    -10.5% |       0.7324 |      0.6033 |    -17.6% |            196144 |           196144 |          +0 |
| cpu.contours.1024        |       1.2671 |      0.9741 |    -23.1% |       2.1590 |      1.6040 |    -25.7% |            421816 |           421816 |          +0 |
| cpu.hull.512             |       0.6076 |      0.5423 |    -10.7% |       1.0761 |      0.8235 |    -23.5% |            391856 |           391856 |          +0 |
| cpu.hull.1024            |       1.4077 |      1.4245 |     +1.2% |       2.4107 |      2.3487 |     -2.6% |            749992 |           749992 |          +0 |
| cpu.mask                 |       1.6318 |      1.8483 |    +13.3% |       2.2510 |      2.7605 |    +22.6% |               656 |              656 |          +0 |
| cpu.extent               |       1.5352 |      1.6646 |     +8.4% |       1.9763 |      2.4423 |    +23.6% |               784 |              784 |          +0 |
| cpu.resample             |      15.2998 |     14.7299 |     -3.7% |      17.8438 |     16.0457 |    -10.1% |            520728 |           520728 |          +0 |
| cpu.resample.photo       |      14.1824 |     14.0062 |     -1.2% |      18.5867 |     15.3248 |    -17.5% |            520728 |           520728 |          +0 |
| cpu.readback.decode.512  |       0.5875 |      0.5361 |     -8.7% |       1.0606 |      0.8373 |    -21.1% |               544 |              544 |          +0 |
| cpu.hullmask.512         |       0.1438 |      0.1491 |     +3.7% |       0.2641 |      0.2609 |     -1.2% |           1060762 |          1060762 |          +0 |
| cpu.ingest.1024          |       1.3407 |      1.4827 |    +10.6% |       2.3598 |      2.6961 |    +14.3% |           1430860 |          1430892 |         +32 |
| cpu.ingest.1024.fallback |      18.4897 |     18.8585 |     +2.0% |      21.4881 |     22.7428 |     +5.8% |           4607444 |          4607444 |          +0 |
| cpu.pack.parse           |       0.0015 |      0.0015 |     +0.0% |       0.0026 |      0.0024 |     -7.7% |              5744 |             5744 |          +0 |
| cpu.pack.decode          |       3.1658 |      3.3160 |     +4.7% |       4.3649 |      4.6028 |     +5.4% |           4593096 |          4593096 |          +0 |
| cpu.step.grid64          |       0.0391 |      0.0407 |     +4.1% |       0.1124 |      0.1079 |     -4.0% |            151344 |           151344 |          +0 |
| cpu.knobs.patch          |       0.0134 |      0.0143 |     +6.7% |       0.0250 |      0.0276 |    +10.4% |             23616 |            23816 |        +200 |
| cpu.knobs.patch.draw     |       0.0099 |      0.0097 |     -2.0% |       0.0167 |      0.0167 |     +0.0% |             14248 |            14416 |        +168 |
| cpu.knobs.patch.stage64  |       0.0366 |      0.0373 |     +1.9% |       0.1019 |      0.0904 |    -11.3% |            167360 |           167456 |         +96 |
| cpu.stage.add            |       0.0163 |      0.0209 |    +28.2% |       0.0326 |      0.0421 |    +29.1% |             31990 |            35438 |       +3448 |

The grid estimate is 151344 bytes/op, equal to the frozen baseline; p50 changes +4.1% and p95 -4.0%. Stage setup remains more expensive: `stage.add` grows by 3448 bytes/op (+10.8%), with p50/p95 deltas +28.2% / +29.1%. Original timing deltas have mixed signs; no blanket absence of regression or causal speedup is established. All 6 recording-GL scenarios retain baseline total calls, synchronous-query counts and state captures in every recorded warm/cold case. Grid64 still records 4,800 calls, zero synchronous queries and zero captures.

### Same-revision CPU observation costs

| Mode                | Standalone p50 ms | Standalone p95 ms | Full-run p50 ms | Full-run p95 ms | Standalone bytes/op | Full-run bytes/op |
| ------------------- | ----------------: | ----------------: | --------------: | --------------: | ------------------: | ----------------: |
| reactivity-raw      |            0.0321 |            0.0941 |          0.0518 |          0.1471 |              117616 |            154304 |
| reactivity-semantic |            0.0347 |            0.1179 |          0.0432 |          0.1420 |              130128 |            170576 |
| reactivity-progress |            0.1330 |            0.3274 |          0.1355 |          0.3255 |              180112 |            222720 |

Per-view normalization of the same absolute costs (one operation divided by 64; not individually timed views):

| Distribution | Mode                | p50 µs/view | p95 µs/view | Estimated bytes/view |
| ------------ | ------------------- | ----------: | ----------: | -------------------: |
| full         | reactivity-raw      |       0.809 |       2.299 |              2411.00 |
| full         | reactivity-semantic |       0.675 |       2.219 |              2665.25 |
| full         | reactivity-progress |       2.117 |       5.086 |              3480.00 |
| standalone   | reactivity-raw      |       0.502 |       1.470 |              1837.75 |
| standalone   | reactivity-semantic |       0.542 |       1.842 |              2033.25 |
| standalone   | reactivity-progress |       2.078 |       5.116 |              2814.25 |

| Distribution | Mode minus raw      | p50 delta ms/op | p95 delta ms/op | p50 delta µs/view | p95 delta µs/view | Bytes delta/op |
| ------------ | ------------------- | --------------: | --------------: | ----------------: | ----------------: | -------------: |
| full         | reactivity-semantic |         -0.0086 |         -0.0051 |            -0.134 |            -0.080 |         +16272 |
| full         | reactivity-progress |         +0.0837 |         +0.1784 |            +1.308 |            +2.787 |         +68416 |
| standalone   | reactivity-semantic |         +0.0026 |         +0.0238 |            +0.041 |            +0.372 |         +12512 |
| standalone   | reactivity-progress |         +0.1009 |         +0.2333 |            +1.577 |            +3.645 |         +62496 |

Each operation covers 64 views. These differences compare distributions, not paired calls; a negative semantic delta does not mean observers make rendering faster. Actual CPU semantic/step connections remain raw 0/0, semantic 192/0, progress 192/64 in both runs. Every measured connection is zero after disposal and all three owners report disposed. Raw evidence retains publication and getter-read counters.

### Browser idle controls, including both historical controls

| Revision/run   | Default idle storm | Idle frame p95 ms | Idle input p95/max ms | Idle drops | All timed frame p95 ms | All timed input maxima ms | All timed dropped frames |
| -------------- | -----------------: | ----------------: | --------------------- | ---------: | ---------------------- | ------------------------- | ------------------------ |
| Baseline run 1 |                  3 |             16.70 | 16.73/18.20           |          0 | 16.71 / 16.70 / 16.70  | 18.00 / 17.40 / 18.20     | 0 / 0 / 0                |
| Baseline run 2 |                  1 |             16.70 | 16.04/16.90           |          0 | 16.70 / 16.70 / 16.80  | 16.90 / 18.50 / 17.50     | 0 / 0 / 0                |
| 67eb4356 run 1 |                  1 |             16.80 | 16.23/17.30           |          0 | 16.80 / 16.80 / 16.71  | 17.30 / 28.30 / 17.10     | 0 / 2 / 0                |
| 67eb4356 run 2 |                  1 |             16.70 | 16.63/17.20           |          0 | 16.70 / 16.70 / 16.71  | 17.20 / 19.90 / 17.10     | 0 / 2 / 0                |
| 0ad408fb run 1 |                  1 |             16.80 | 16.74/26.30           |          0 | 16.80 / 16.70 / 16.70  | 26.30 / 28.60 / 26.00     | 0 / 0 / 0                |
| 0ad408fb run 2 |                  3 |             16.70 | 16.60/18.60           |          0 | 16.70 / 16.70 / 16.70  | 26.30 / 22.20 / 18.60     | 0 / 0 / 0                |

Both current runs are retained in full. The historical approximately 16.7 ms idle-frame / below approximately 20 ms input-maximum guideline is a control-quality aid, not a new SwiftShader performance budget. Interpret each run against its idle controls; no run is selected using favorable adapter timing. The harness still selects one timed storm by lowest task maximum, then task p95, and takes every headline metric from that storm.

Run 1 has 3 of three timed idle storms at or above approximately 20 ms input maximum; timed idle frame p95 spans 16.70–16.80 ms. Its timing is contended; the default storm must not be treated as representative of every timed storm. All storms remain reported.

Run 2 has 2 of three timed idle storms at or above approximately 20 ms input maximum; timed idle frame p95 spans 16.70–16.70 ms. Its timing is contended; the default storm must not be treated as representative of every timed storm. All storms remain reported.

### Original browser workloads at the current revision

The frozen baseline column uses baseline run 2, as in the historical report. Both current runs and all cold/timed storms remain available.

| Original row   | Baseline frame p95 ms | Run 1 frame p95 ms | Run 2 frame p95 ms | Baseline storm ms | Run 1 storm ms (delta) | Run 2 storm ms (delta) |
| -------------- | --------------------: | -----------------: | -----------------: | ----------------: | ---------------------: | ---------------------: |
| idle           |                 16.70 |              16.80 |              16.70 |            2000.5 |         2000.9 (+0.0%) |         2000.6 (+0.0%) |
| sequential     |                 16.80 |              16.80 |              16.80 |            2667.2 |        3069.7 (+15.1%) |        3071.0 (+15.1%) |
| burst-url      |                 66.70 |              66.70 |              55.91 |            4509.1 |         4628.2 (+2.6%) |         4476.8 (-0.7%) |
| burst-bitmap   |                 83.36 |              66.66 |              66.70 |            5307.6 |        4534.8 (-14.6%) |        4623.7 (-12.9%) |
| stream         |                 66.70 |              66.70 |              50.00 |            5423.0 |        4842.8 (-10.7%) |         4984.2 (-8.1%) |
| double-swap    |                 81.64 |              66.68 |              66.70 |            5267.6 |         5110.0 (-3.0%) |         5184.3 (-1.6%) |
| burst-drag     |                 66.80 |              66.70 |              66.70 |            6244.0 |         5868.3 (-6.0%) |        5568.4 (-10.8%) |
| burst-url@dpr2 |                233.30 |             234.97 |             259.96 |           14265.5 |       12524.6 (-12.2%) |       12834.5 (-10.0%) |
| stream@dpr2    |                250.00 |             214.95 |             283.30 |           14489.5 |        13098.3 (-9.6%) |       13018.7 (-10.2%) |

### Same-revision browser observation costs

| Run | Mode                | Default storm ms | Frame p95 ms | Timed frame-p95 range ms | Task p95 ms | Input p95 ms | Timed storm range ms |
| --- | ------------------- | ---------------: | -----------: | ------------------------ | ----------: | -----------: | -------------------- |
| 1   | reactivity-raw      |           4750.7 |        70.85 | 66.60–70.85              |       20.12 |        31.59 | 4651.7–4750.7        |
| 1   | reactivity-semantic |           4660.7 |        66.70 | 66.70–66.70              |       21.65 |        31.55 | 4660.7–4736.0        |
| 1   | reactivity-progress |           4690.9 |        66.76 | 66.76–83.32              |       20.47 |        30.90 | 4690.9–4795.6        |
| 2   | reactivity-raw      |           4966.2 |        70.02 | 66.70–70.02              |       19.78 |        31.51 | 4966.2–5126.2        |
| 2   | reactivity-semantic |           4996.5 |        66.60 | 66.60–66.68              |       22.99 |        35.91 | 4996.5–5090.9        |
| 2   | reactivity-progress |           5092.2 |        66.70 | 66.70–66.70              |       19.09 |        32.26 | 5037.9–5092.2        |

Run 1: semantic minus raw storm -90.0 ms; progress minus raw -59.8 ms. These whole-storm differences include software rasterization and synchronization, not isolated JavaScript adapter cost.

Run 2: semantic minus raw storm +30.3 ms; progress minus raw +126.0 ms. These whole-storm differences include software rasterization and synchronization, not isolated JavaScript adapter cost.

Both complete runs passed 12/12 correctness and measurement checks (Vitest durations 477.86 and 495.25 seconds). All four storms for each of the three observer rows preserve 30 successful results, 30 distinct rectangles and 30 distinct pixel hashes, with zero failed or aborted adds. Measured semantic/step connections before and after every observer storm are raw 0/0, semantic 90/0 and progress 90/30; all remaining connections are zero after disposal. The JSON comparison summary verifies these invariants across all 24 observer storms.

### Current-revision provenance, variability and cleanup

- cpu: 2026-09-12T00:09:19.0963035Z to 2026-09-12T00:10:02.9638519Z; monitoring wall time 43.87 seconds; exit 0, natural completion, 3 recorded process identities, zero remaining.
- comparison-cpu: 2026-09-12T00:10:21.2795238Z to 2026-09-12T00:10:32.3463044Z; monitoring wall time 11.07 seconds; exit 0, natural completion, 3 recorded process identities, zero remaining.
- smooth-run1: 2026-09-12T00:11:04.9881795Z to 2026-09-12T00:19:12.2635523Z; monitoring wall time 487.28 seconds; exit 0, natural completion, 12 recorded process identities, zero remaining.
- smooth-run2: 2026-09-12T00:19:30.7601529Z to 2026-09-12T00:27:55.0329751Z; monitoring wall time 504.27 seconds; exit 0, natural completion, 13 recorded process identities, zero remaining.

All 498 freshly enumerated source, built and benchmark/configuration hashes match before and after this measurement window. These are current hashes, not copied historical hashes. All 40 historical artifact hashes and the historical manifest remain unchanged. All 34 recorded process identities, including the exit-capture diagnostic, were absent after the sequence. Process records include PID, parent PID, creation time, exact commands and memory snapshots. Port 63400 was free before and after each run and after the entire sequence; no process was forcibly terminated. Existing user/browser/editor processes were preserved. Host free memory changed from 11.44 GiB to 12.13 GiB; these are host snapshots, not recovered-memory measurements. Monitoring samples sum task working sets, which can double-count shared memory and are not private allocations.

An initial full CPU attempt produced all rows and its process identities disappeared naturally, but the PowerShell monitor did not retain the process handle and returned a null exit code. It is preserved as an exit-capture diagnostic, not execution-pass evidence. The monitor alone was corrected to retain the handle; one unchanged full CPU rerun then supplied exit 0. The diagnostic grid64 p50/p95 were 0.1441/0.4132 ms versus 0.0407/0.1079 ms in the verified rerun. This large same-source timing swing limits causal attribution to runtime changes; the diagnostic was excluded for missing exit-code evidence, not unfavorable timing. No browser runs were discarded or replaced.

Exact benchmark invocations (the execution JSONs preserve absolute installed executable paths and the full argument arrays):

```powershell
rtk proxy C:/nvm4w/nodejs/node.exe --import ./tools/bench/cpu/loader.mjs --expose-gc tools/bench/cpu/run.mjs --out tools/bench/out/reatom-0ad408fb-cpu.json
rtk proxy C:/nvm4w/nodejs/node.exe --import ./tools/bench/cpu/loader.mjs --expose-gc tools/bench/cpu/run.mjs --filter reactivity --out tools/bench/out/reatom-0ad408fb-comparison-cpu.json
rtk proxy C:/nvm4w/nodejs/node.exe tools/bench/smooth/run.mjs --iter 3 --json tools/bench/out/reatom-0ad408fb-smooth-run1.json --browser.api.port=63400 --browser.api.strictPort
rtk proxy C:/nvm4w/nodejs/node.exe tools/bench/smooth/run.mjs --iter 3 --json tools/bench/out/reatom-0ad408fb-smooth-run2.json --browser.api.port=63400 --browser.api.strictPort
```

### Current-revision artifacts

Raw artifacts remain local and gitignored. The new manifest adds current evidence while retaining references to all original 40 artifacts and the unchanged historical manifest.

- [reatom-0ad408fb-cpu.json](../../tools/bench/out/reatom-0ad408fb-cpu.json)
- [reatom-0ad408fb-comparison-cpu.json](../../tools/bench/out/reatom-0ad408fb-comparison-cpu.json)
- [reatom-0ad408fb-smooth-run1.json](../../tools/bench/out/reatom-0ad408fb-smooth-run1.json)
- [reatom-0ad408fb-smooth-run2.json](../../tools/bench/out/reatom-0ad408fb-smooth-run2.json)
- [reatom-0ad408fb-comparison-summary.json](../../tools/bench/out/reatom-0ad408fb-comparison-summary.json)
- [reatom-0ad408fb-environment.json](../../tools/bench/out/reatom-0ad408fb-environment.json)
- [reatom-0ad408fb-cleanup.json](../../tools/bench/out/reatom-0ad408fb-cleanup.json)
- [reatom-0ad408fb-artifacts.json](../../tools/bench/out/reatom-0ad408fb-artifacts.json)
- [reatom-0ad408fb-diagnostic-exitcode-cpu.json](../../tools/bench/out/reatom-0ad408fb-diagnostic-exitcode-cpu.json)

## Historical measured results — 67eb4356

Final production revision: `67eb4356da4cd809d0473a0a80c249476df8c8bd`, with the uncommitted Task 11 benchmark and packaging changes recorded in `reatom-final-environment.json`. That file preserves individual SHA-256 source hashes, runtime/hardware metadata and dirty status. Full CPU generated at 2026-09-11T21:52:20.774Z; standalone observer CPU at 2026-09-11T21:52:37.107Z. Browser run IDs: 2026-09-11T21:52:52.560Z, 2026-09-11T22:02:27.443Z.

### Original CPU workloads

All times below are milliseconds; allocation values are bytes per operation under the heap-delta caveat above.

| Scenario                 | Baseline p50 | Final p50 | Baseline p95 | Final p95 | Baseline bytes/op | Final bytes/op |
| ------------------------ | ------------ | --------- | ------------ | --------- | ----------------- | -------------- |
| cpu.sdf.512              | 17.1068      | 18.6236   | 18.9166      | 23.2250   | 3180376           | 3180376        |
| cpu.sdf.1024             | 69.3974      | 81.5602   | 75.6208      | 101.7914  | 12643016          | 12643016       |
| cpu.sdf.1024.photo       | 69.3560      | 105.6253  | 75.4232      | 133.9525  | 12643016          | 12643016       |
| cpu.contours.512         | 0.4524       | 0.4612    | 0.7324       | 0.8798    | 196144            | 196144         |
| cpu.contours.1024        | 1.2671       | 1.1405    | 2.1590       | 2.2245    | 421816            | 421816         |
| cpu.hull.512             | 0.6076       | 0.6765    | 1.0761       | 1.1606    | 391856            | 391856         |
| cpu.hull.1024            | 1.4077       | 1.4828    | 2.4107       | 2.8845    | 749992            | 749992         |
| cpu.mask                 | 1.6318       | 1.9764    | 2.2510       | 2.7081    | 656               | 656            |
| cpu.extent               | 1.5352       | 1.8858    | 1.9763       | 2.6793    | 784               | 784            |
| cpu.resample             | 15.2998      | 18.1539   | 17.8438      | 26.7754   | 520728            | 520728         |
| cpu.resample.photo       | 14.1824      | 16.9043   | 18.5867      | 26.1206   | 520728            | 520728         |
| cpu.readback.decode.512  | 0.5875       | 0.6713    | 1.0606       | 1.3463    | 544               | 544            |
| cpu.hullmask.512         | 0.1438       | 0.1920    | 0.2641       | 0.4446    | 1060762           | 1060762        |
| cpu.ingest.1024          | 1.3407       | 1.6826    | 2.3598       | 3.4757    | 1430860           | 1430860        |
| cpu.ingest.1024.fallback | 18.4897      | 23.9821   | 21.4881      | 34.5736   | 4607444           | 4607444        |
| cpu.pack.parse           | 0.0015       | 0.0020    | 0.0026       | 0.0037    | 5744              | 5744           |
| cpu.pack.decode          | 3.1658       | 4.3113    | 4.3649       | 8.2180    | 4593096           | 4593096        |
| cpu.step.grid64          | 0.0391       | 0.0611    | 0.1124       | 0.1706    | 151344            | 151344         |
| cpu.knobs.patch          | 0.0134       | 0.0189    | 0.0250       | 0.0422    | 23616             | 24024          |
| cpu.knobs.patch.draw     | 0.0099       | 0.0109    | 0.0167       | 0.0232    | 14248             | 14416          |
| cpu.knobs.patch.stage64  | 0.0366       | 0.0469    | 0.1019       | 0.1179    | 167360            | 167456         |
| cpu.stage.add            | 0.0163       | 0.0342    | 0.0326       | 0.0831    | 31990             | 35598          |

### Same-revision CPU observation comparison

| Mode                | Standalone p50 ms | Standalone p95 ms | Full-run p50 ms | Full-run p95 ms | Standalone bytes/op | Full-run bytes/op |
| ------------------- | ----------------- | ----------------- | --------------- | --------------- | ------------------- | ----------------- |
| reactivity-raw      | 0.0332            | 0.0684            | 0.0585          | 0.1718          | 117616              | 154304            |
| reactivity-semantic | 0.0547            | 0.1868            | 0.0566          | 0.2010          | 130128              | 170608            |
| reactivity-progress | 0.1716            | 0.4762            | 0.1777          | 0.4259          | 180112              | 222720            |

Standalone semantic minus raw is 0.0215 ms at p50 and 0.1184 ms at p95 for one 64-view operation (0.336 / 1.850 microseconds per view). These are differences between measured distributions, not paired per-call latency estimates.

Standalone progress minus raw is 0.1384 ms at p50 and 0.4078 ms at p95 for one 64-view operation (2.163 / 6.372 microseconds per view). These are differences between measured distributions, not paired per-call latency estimates.

### Browser controls and original rows

| Run | Default idle storm | Idle frame p95 ms | Idle input maximum ms | Idle dropped frames | All timed idle input maxima ms |
| --- | ------------------ | ----------------- | --------------------- | ------------------- | ------------------------------ |
| 1   | 1                  | 16.80             | 17.30                 | 0                   | 17.30 / 28.30 / 17.10          |
| 2   | 1                  | 16.70             | 17.20                 | 0                   | 17.20 / 19.90 / 17.10          |

Run 2 is the reference after reviewing the idle controls, using the existing approximately 16.7 ms frame p95 / below approximately 20 ms input maximum guideline. The harness's default storm selection is unchanged; every row from both runs is reported below. All cold and timed storms remain available.

Both default idle summaries meet that guideline. Run 1 has one contended timed idle storm
(28.3 ms input maximum, two dropped frames); Run 2's timed maxima are all below 20 ms, although
its second storm also records two dropped frames. Run 2 is preferred on this control evidence,
not on observer timings. Both complete runs passed all 12 correctness and measurement checks;
their wall times were 524.50 and 528.25 seconds. No additional final runs were selected or discarded.

| Original row   | Baseline frame p95 ms | Run 1 frame p95 ms | Run 2 frame p95 ms | Baseline storm ms | Run 1 storm ms | Run 2 storm ms |
| -------------- | --------------------- | ------------------ | ------------------ | ----------------- | -------------- | -------------- |
| idle           | 16.70                 | 16.80              | 16.70              | 2000.5            | 2000.3         | 2000.8         |
| sequential     | 16.80                 | 16.80              | 16.70              | 2667.2            | 3530.2         | 3468.2         |
| burst-url      | 66.70                 | 66.70              | 70.85              | 4509.1            | 5193.2         | 5244.7         |
| burst-bitmap   | 83.36                 | 83.30              | 66.70              | 5307.6            | 4956.5         | 5095.7         |
| stream         | 66.70                 | 66.70              | 66.70              | 5423.0            | 5231.0         | 5256.3         |
| double-swap    | 81.64                 | 66.78              | 83.30              | 5267.6            | 5293.1         | 5298.2         |
| burst-drag     | 66.80                 | 81.55              | 66.70              | 6244.0            | 6002.9         | 5751.4         |
| burst-url@dpr2 | 233.30                | 216.64             | 216.62             | 14265.5           | 13484.3        | 13453.4        |
| stream@dpr2    | 250.00                | 264.11             | 233.30             | 14489.5           | 13494.0        | 14168.5        |

### Same-revision browser observation comparison

| Run | Mode                | Default storm ms | Frame p95 ms | Timed frame-p95 range ms | Task p95 ms | Input p95 ms | Timed storm range ms |
| --- | ------------------- | ---------------- | ------------ | ------------------------ | ----------- | ------------ | -------------------- |
| 1   | reactivity-raw      | 5064.9           | 66.70        | 66.60–66.70              | 21.36       | 31.78        | 5064.9–5284.5        |
| 1   | reactivity-semantic | 5129.9           | 50.10        | 50.10–66.70              | 21.50       | 30.77        | 5117.4–5257.0        |
| 1   | reactivity-progress | 5089.2           | 66.70        | 66.68–83.40              | 20.72       | 30.09        | 5083.6–5375.4        |
| 2   | reactivity-raw      | 5066.5           | 66.70        | 65.02–83.34              | 20.34       | 30.36        | 5055.1–5190.9        |
| 2   | reactivity-semantic | 5057.7           | 66.70        | 66.68–83.33              | 19.99       | 29.78        | 5057.7–5133.3        |
| 2   | reactivity-progress | 5139.8           | 83.23        | 66.70–83.30              | 21.58       | 31.40        | 5125.1–5357.3        |

The traces include long software-rasterization and GPU-synchronization stalls. These browser
numbers describe the entire storm, not isolated JavaScript adapter cost. A faster headline for
one mode does not demonstrate that adding observers improves rendering. For example, Run 2's
semantic storm is 8.8 ms shorter than raw while progress is 73.3 ms longer; both differences sit
inside the observed timed-storm ranges. The original sequential row remains slower than the
historical baseline (3468.2 versus 2667.2 ms), while other original storm deltas have mixed signs.
These observations do not establish hardware-GPU performance or a causal adapter timing effect.

### Source stability and process cleanup

All 477 source and built-file hashes recorded before measurement still matched afterward.
Both browser process trees were recorded with process IDs, parent IDs and creation times;
none of their 20 recorded identities remained after completion. Port 63400 had zero listeners.
CPU and browser runners exited naturally; no task process was forcibly terminated. Host free
memory was 12.36 GiB before and 12.17 GiB after measurement. These are host snapshots, not RAM
recovery measurements; unrelated browser and Node sessions were preserved.

### Artifacts

Raw results and provenance (local, gitignored):

- [reatom-final-cpu.json](../../tools/bench/out/reatom-final-cpu.json)
- [reatom-comparison-cpu.json](../../tools/bench/out/reatom-comparison-cpu.json)
- [reatom-final-smooth-run1.json](../../tools/bench/out/reatom-final-smooth-run1.json)
- [reatom-final-smooth-run2.json](../../tools/bench/out/reatom-final-smooth-run2.json)
- [reatom-final-environment.json](../../tools/bench/out/reatom-final-environment.json)
- [reatom-final-cleanup.json](../../tools/bench/out/reatom-final-cleanup.json)
- [reatom-baseline-cpu-b506f651.json](../../tools/bench/out/reatom-baseline-cpu-b506f651.json)
- [reatom-baseline-smooth-run1-b506f651.json](../../tools/bench/out/reatom-baseline-smooth-run1-b506f651.json)
- [reatom-baseline-smooth-run2-b506f651.json](../../tools/bench/out/reatom-baseline-smooth-run2-b506f651.json)
- [SHA-256 artifact manifest](../../tools/bench/out/reatom-final-artifacts.json)
