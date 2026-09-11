import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { quantile, runScenario } from './harness.mjs'

it('reports p95 separately from p90', async () => {
  expect(quantile([0, 10, 20], 0.95)).toBe(19)
  const result = await runScenario(
    { name: 'quantiles', setup: () => null, op: () => {} },
    {
      warmupMs: 0,
      warmupMin: 0,
      minTimeMs: 0,
      minIterations: 2,
      maxIterations: 2,
      allocSamples: 0,
    },
  )
  expect(result.p95Ms).toEqual(expect.any(Number))
})

it('sets up the existing hull mask workload', () => {
  const loader = new URL('./loader.mjs', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      loader,
      '--input-type=module',
      '--eval',
      "import { scenarios } from './tools/bench/cpu/scenarios.mjs'; const c = scenarios.find((s) => s.name === 'cpu.hullmask.512').setup(); if (c.hull.kind !== 'polygons') process.exitCode = 1",
    ],
    { cwd: process.cwd() },
  )
  expect(result.status, result.stderr.toString()).toBe(0)
})
