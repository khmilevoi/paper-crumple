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
