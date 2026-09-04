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
 *   pnpm bench:smooth -- --gpu                   ANGLE D3D11 (same as BENCH_GPU=1)
 *   pnpm bench:smooth -- --gate                  the D3D11 verdict fails the run (BENCH_GATE=1)
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
    else if (flag === '--gpu') o.env.BENCH_GPU = '1'
    else if (flag === '--gate') o.env.BENCH_GATE = '1'
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
