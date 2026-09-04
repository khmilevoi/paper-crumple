/**
 * The GL bench: JS-side timings of every WebGL2 scenario, in headless Chromium.
 *
 *     pnpm bench:gl                       # SwiftShader, the reproducible gate (BENCH_OUT = tools/bench/out/gl.json)
 *     BENCH_GPU=1 pnpm bench:gl           # ANGLE D3D11 on this machine's GPU — evidence, not a gate
 *     BENCH_PROFILE=1 pnpm bench:gl       # also writes .cpuprofile files for the heavy scenarios
 *     BENCH_ITER=10 pnpm bench:gl         # timed iterations per scenario (5 by default)
 *     pnpm bench:gl -- -t gl.sdf          # vitest's own name filter
 *
 * Build core, paper and motion first: the bench imports their dist entry points (`deps.ts`).
 *
 * The launch flags are the `gl` project's, verbatim, so a SwiftShader number here is comparable
 * with the level-2 suite's environment; `BENCH_GPU=1` swaps in the ANGLE D3D11 triple
 * `docs/level-3-timing.md` records reaching the Intel Iris Xe from headless Chromium.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import { benchCommands } from './commands.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const realGpu = process.env.BENCH_GPU === '1'
const outPath = resolve(
  root,
  process.env.BENCH_OUT ?? (realGpu ? 'tools/bench/out/gl-gpu.json' : 'tools/bench/out/gl.json'),
)
const profileDir = resolve(root, 'tools/bench/out/profiles')
const runId = new Date().toISOString()
const iterations = Math.max(1, Number(process.env.BENCH_ITER ?? 5) || 5)
const profile = process.env.BENCH_PROFILE === '1'

export default defineConfig({
  root,
  define: {
    __BENCH_ITER__: JSON.stringify(iterations),
    __BENCH_GPU__: JSON.stringify(realGpu),
    __BENCH_PROFILE__: JSON.stringify(profile),
  },
  test: {
    name: 'bench-gl',
    include: ['tools/bench/gl/**/*.gl.bench.ts'],
    // One page at a time against the ~16 live WebGL2 context cap, and one scenario at a time so
    // nothing else shares the rasteriser thread with the one being timed.
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          channel: 'chromium',
          args: realGpu
            ? ['--use-gl=angle', '--use-angle=d3d11', '--ignore-gpu-blocklist']
            : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      }),
      instances: [{ browser: 'chromium' }],
      commands: benchCommands({ outPath, profileDir, runId }),
    },
  },
})
