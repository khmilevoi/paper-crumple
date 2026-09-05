/**
 * `pnpm bench:smooth` — the smoothness bench's command line, turned into the environment
 * `vitest.smooth.config.ts` reads, then vitest itself.
 *
 *   pnpm bench:smooth                            every row, table on stdout, JSON to BENCH_OUT
 *   pnpm bench:smooth -- --filter burst,stream   rows whose name contains any of the terms
 *   pnpm bench:smooth -- --json path             machine-readable output (else BENCH_OUT, else
 *                                                tools/bench/out/smooth.json / smooth-gpu.json)
 *   pnpm bench:smooth -- --iter 3                timed storms per row (2)
 *   pnpm bench:smooth -- --profile               one more storm per row under the CDP profiler
 *   pnpm bench:smooth -- --trace-dump            keep every storm's raw trace events (BENCH_TRACE_DUMP;
 *                                                tools/bench/out/traces/, tens of MB per storm)
 *   pnpm bench:smooth -- --trace-cats gpu.angle  extra trace categories, comma-separated
 *                                                (BENCH_TRACE_CATS; the GPU process's side of a stall)
 *   pnpm bench:smooth -- --probe -t probe-stage  the isolation probes (BENCH_PROBE; `*.smooth.probe.ts`,
 *                                                one mechanism each — the blit alone, the stage alone)
 *   pnpm bench:smooth -- --gpu                   ANGLE D3D11 (same as BENCH_GPU=1)
 *   pnpm bench:smooth -- --check                 the D3D11 verdict fails the run (BENCH_CHECK=1;
 *                                                --gate / BENCH_GATE is the old spelling)
 *
 * Anything else is handed to vitest unchanged (`-t smooth.burst`, `--reporter`, ...). The
 * `bench:smooth` script installs Chromium first, as `bench:gl` does.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

function parseArgs(argv) {
  const o = { env: {}, rest: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') continue // pnpm forwards its own separator
    const eq = a.indexOf('=')
    const flag = eq >= 0 ? a.slice(0, eq) : a
    const value = () => (eq >= 0 ? a.slice(eq + 1) : String(argv[++i] ?? ''))
    if (flag === '--filter') o.env.BENCH_FILTER = value()
    else if (flag === '--json' || flag === '--out') o.env.BENCH_OUT = value()
    else if (flag === '--iter') o.env.BENCH_ITER = value()
    else if (flag === '--profile') o.env.BENCH_PROFILE = '1'
    else if (flag === '--trace-dump') o.env.BENCH_TRACE_DUMP = '1'
    else if (flag === '--trace-cats') o.env.BENCH_TRACE_CATS = value()
    else if (flag === '--probe') o.env.BENCH_PROBE = '1'
    else if (flag === '--gpu') o.env.BENCH_GPU = '1'
    else if (flag === '--check' || flag === '--gate') o.env.BENCH_CHECK = '1'
    else o.rest.push(a)
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const vitest = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
)
const result = spawnSync(
  process.execPath,
  [vitest, 'run', '--config', 'tools/bench/smooth/vitest.smooth.config.ts', ...args.rest],
  { cwd: root, env: { ...process.env, ...args.env }, stdio: 'inherit' },
)
process.exitCode = result.status ?? 1
