import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = new URL('../', import.meta.url)
const workflow = parse(readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')) as {
  jobs: Record<
    string,
    { strategy?: { matrix?: Record<string, unknown> }; steps?: { run?: string }[] }
  >
}

const runs = (job: string): string[] =>
  (workflow.jobs[job]?.steps ?? []).filter((step) => step.run).map((step) => step.run!)

describe('the level-1 matrix', () => {
  const matrix = workflow.jobs.level1!.strategy!.matrix!

  it('pins the floor to an exact patch, because a floating 22 drifts with the runner image', () => {
    expect(matrix['node-version']).toEqual(['22.18.0', '24', '26'])
  })

  it('keeps every version a string, so YAML cannot turn 24 into a number', () => {
    for (const version of matrix['node-version'] as unknown[]) {
      expect(typeof version).toBe('string')
    }
  })

  it('runs the matrix on ubuntu and adds one windows lane on node 24', () => {
    expect(matrix.os).toEqual(['ubuntu-latest'])
    expect(matrix.include).toEqual([{ os: 'windows-latest', 'node-version': '24' }])
  })

  it('runs lint, format, typecheck and level 1, and never pulls a browser', () => {
    expect(runs('level1')).toEqual(
      expect.arrayContaining([
        'pnpm install --frozen-lockfile',
        'pnpm lint',
        'pnpm format:check',
        'pnpm typecheck',
        'pnpm test',
      ]),
    )
    expect(runs('level1').join('\n')).not.toMatch(/test:gl|playwright/)
  })
})

describe('the level-2 lane', () => {
  it('installs Chromium with its system dependencies, then runs level 2', () => {
    expect(runs('level2')).toEqual(
      expect.arrayContaining(['pnpm exec playwright install --with-deps chromium', 'pnpm test:gl']),
    )
  })

  it('runs the level-2 suite in exactly one lane, so a later plan cannot duplicate it', () => {
    const glLanes = Object.keys(workflow.jobs).filter((job) =>
      runs(job).some((step) => step.includes('test:gl')),
    )
    expect(glLanes).toEqual(['level2'])
  })
})
