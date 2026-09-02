import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
) as {
  jobs: Record<
    string,
    { 'runs-on'?: string; strategy?: unknown; steps?: { run?: string; uses?: string }[] }
  >
}

const job = workflow.jobs.packaging
const runs = (job?.steps ?? []).filter((s) => s.run).map((s) => s.run!)

describe('the packaging lane', () => {
  it('exists as its own job rather than riding on level 1', () => {
    expect(job).toBeDefined()
    expect(job!['runs-on']).toBe('ubuntu-latest')
  })

  it('is a single lane with no matrix — packaging is the same on every Node', () => {
    expect(job!.strategy).toBeUndefined()
  })

  it('builds all three published packages before packing them', () => {
    const build = runs.find((r) => r.includes('turbo run build'))
    expect(build).toBe(
      'pnpm exec turbo run build --filter=@paper-crumple/core --filter=@paper-crumple/paper --filter=@paper-crumple/motion',
    )
    expect(runs.indexOf(build!)).toBeLessThan(runs.indexOf('pnpm verify:packaging'))
  })

  it('runs the zero-dependency gate and the tarball gate', () => {
    expect(runs).toEqual(
      expect.arrayContaining([
        'pnpm install --frozen-lockfile',
        'pnpm verify:deps',
        'pnpm verify:packaging',
      ]),
    )
  })

  it('pulls no browser and runs no GL suite, so the single level-2 lane stays single', () => {
    expect(runs.join('\n')).not.toMatch(/test:gl|playwright/)
  })

  it('leaves the two jobs that were already here alone', () => {
    expect(Object.keys(workflow.jobs)).toEqual(expect.arrayContaining(['level1', 'level2']))
  })
})
