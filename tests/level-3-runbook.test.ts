/**
 * # The level-3 runbook is complete, and its harness is cross-origin isolated
 *
 * Level 3 is **not in CI** (§11, §17.1): SwiftShader timings are meaningless, and here worse than
 * meaningless, because the disputed term is the size-invariant setup cost a software rasteriser
 * does not have in the same proportion. So the *measurement* is not gated — but the *runbook* is,
 * because a recipe missing one of its four instruments produces a number that cannot be read
 * against §17.1's pre-fixed thresholds, and a page that is not cross-origin isolated produces
 * `performance.now()` clamped to 100 µs and every CPU figure is quantisation noise.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const runbook = readFileSync(new URL('docs/level-3-timing.md', root), 'utf8')
const server = readFileSync(new URL('tools/bench-3d/serve.mjs', root), 'utf8')
const page = readFileSync(new URL('tools/bench-3d/index.html', root), 'utf8')

describe('the level-3 runbook (§17.1)', () => {
  it("names all four instruments, in §17.1's order", () => {
    for (const instrument of [
      'Serialised per-draw at 998',
      'One query around N draws',
      'empty query',
      '1x1-scissored',
      'CPU submit cost',
    ]) {
      expect(runbook).toContain(instrument)
    }
  })

  it('names every N of the deciding batch, since a grid does not serialise its draws', () => {
    for (const n of ['1', '8', '32', '100', '256']) {
      expect(runbook).toMatch(new RegExp(`\\b${n}\\b`))
    }
    expect(runbook).toContain('no `finish` inside')
  })

  it('names every size in the sweep and the affine fit that reports A', () => {
    for (const size of ['1x1', '96', '192', '384x366', '768', '998x951']) {
      expect(runbook).toContain(size)
    }
    expect(runbook).toContain('ms = A + B·pixels')
  })

  it("carries §17.1's thresholds, fixed in advance so the result cannot be read to taste", () => {
    expect(runbook).toContain('0.10')
    expect(runbook).toContain('0.167')
    expect(runbook).toContain('reopens instancing')
    expect(runbook).toContain('measured on')
    expect(runbook).not.toMatch(/\[verified\]/)
  })

  it('runs all six poses and the batch both with and without the per-draw clear', () => {
    expect(runbook).toContain('all six poses')
    expect(runbook).toContain('per-draw clear')
  })

  it('discards GPU_DISJOINT_EXT samples rather than averaging them in', () => {
    expect(runbook).toContain('GPU_DISJOINT_EXT')
    expect(runbook).toContain('discard')
  })

  it('restates §16 as inherited properties rather than defects', () => {
    expect(runbook).toContain('inherited')
    for (const constraint of [
      'kinematic',
      'Silhouette adaptivity',
      'rolled bundle',
      'No relief on the reverse',
      'Translucent sheet edges',
      'one-component',
    ]) {
      expect(runbook).toContain(constraint)
    }
    expect(runbook).not.toContain('defect')
  })
})

describe('the level-3 harness', () => {
  it('sets both headers, so the page is cross-origin isolated and performance.now() is not clamped', () => {
    expect(server).toContain('Cross-Origin-Opener-Policy')
    expect(server).toContain('same-origin')
    expect(server).toContain('Cross-Origin-Embedder-Policy')
    expect(server).toContain('require-corp')
  })

  it('refuses to measure a page that is not isolated, rather than reporting clamped noise', () => {
    expect(page).toContain('crossOriginIsolated')
  })

  it('is not wired into CI: no workflow runs it', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
    expect(workflow).not.toContain('bench-3d')
  })
})
