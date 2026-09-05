/**
 * The smoothness bench: thirty on-screen views swapping images, in headless Chromium, with a
 * synthesised user. `swap30.smooth.bench.ts` states the scenario, the metrics and the thresholds.
 *
 *     pnpm bench:smooth                         # SwiftShader — report only (BENCH_OUT = tools/bench/out/smooth.json)
 *     BENCH_GPU=1 pnpm bench:smooth             # ANGLE D3D11 on this machine's GPU — the gate's backend
 *     pnpm bench:smooth -- --filter burst,idle  # rows whose name contains any term (BENCH_FILTER)
 *     pnpm bench:smooth -- --json path          # machine-readable output (BENCH_OUT)
 *     pnpm bench:smooth -- --iter 3             # timed storms per row, 2 by default (BENCH_ITER)
 *     pnpm bench:smooth -- --profile            # one more storm per row under the CDP profiler (BENCH_PROFILE)
 *     pnpm bench:smooth -- --check              # the D3D11 verdict becomes an assertion, so the run
 *                                               # exits non-zero when a row misses (BENCH_CHECK;
 *                                               # BENCH_GATE / --gate is the old spelling)
 *
 * `run.mjs` turns those flags into the environment this config reads; `-t <name>` also works,
 * since every row is a test named after itself. Build core, paper and motion first: the bench
 * imports their dist entry points (`deps.ts`).
 *
 * The launch flags are the GL bench's — the `gl` project's SwiftShader triple, or the ANGLE D3D11
 * triple under `BENCH_GPU=1` — and the viewport is the scenario's 1400×900 CSS px, set on the
 * Playwright context and on vitest's tester frame alike so the grid is on screen and the
 * synthesised input lands on it.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { smoothCommands } from './commands.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const realGpu = process.env.BENCH_GPU === '1'
const outPath = resolve(
  root,
  process.env.BENCH_OUT ??
    (realGpu ? 'tools/bench/out/smooth-gpu.json' : 'tools/bench/out/smooth.json'),
)
const profileDir = resolve(root, 'tools/bench/out/profiles')
const traceDir =
  process.env.BENCH_TRACE_DUMP === '1' ? resolve(root, 'tools/bench/out/traces') : undefined
const traceCategories = (process.env.BENCH_TRACE_CATS ?? '').split(',').filter(Boolean)
const runId = new Date().toISOString()
const iterations = Math.max(1, Number(process.env.BENCH_ITER ?? 2) || 2)
const profile = process.env.BENCH_PROFILE === '1'
const filter = process.env.BENCH_FILTER ?? ''
const check = process.env.BENCH_CHECK === '1' || process.env.BENCH_GATE === '1'
const viewport = { width: 1400, height: 900 }

export default defineConfig({
  root,
  define: {
    __BENCH_ITER__: JSON.stringify(iterations),
    __BENCH_GPU__: JSON.stringify(realGpu),
    __BENCH_PROFILE__: JSON.stringify(profile),
    __BENCH_FILTER__: JSON.stringify(filter),
    __BENCH_CHECK__: JSON.stringify(check),
  },
  test: {
    name: 'bench-smooth',
    // The probes (`*.smooth.probe.ts`) isolate one mechanism each and are opt-in: `--probe`
    // (`BENCH_PROBE=1`) adds them, `-t probe-blit` / `-t probe-stage` picks one.
    include: [
      'tools/bench/smooth/**/*.smooth.bench.ts',
      ...(process.env.BENCH_PROBE === '1' ? ['tools/bench/smooth/**/*.smooth.probe.ts'] : []),
    ],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
    browser: {
      enabled: true,
      headless: true,
      viewport,
      provider: playwright({
        launchOptions: {
          channel: 'chromium',
          args: realGpu
            ? ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist']
            : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
        contextOptions: { viewport },
      }),
      instances: [{ browser: 'chromium' }],
      commands: smoothCommands({ outPath, profileDir, runId, traceDir, traceCategories }),
    },
  },
})
