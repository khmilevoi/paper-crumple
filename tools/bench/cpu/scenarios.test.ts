import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

function probeScenarios() {
  const loader = new URL('./loader.mjs', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      loader,
      '--input-type=module',
      '--eval',
      `
        import { scenarios } from './tools/bench/cpu/scenarios.mjs'
        const byName = (name) => scenarios.find((scenario) => scenario.name === name)
        const hull = byName('cpu.hull.512')
        const built = hull.op(hull.setup())
        const mask = byName('cpu.hullmask.512')
        const maskContext = mask.setup()
        const ingest = byName('cpu.ingest.1024')
        const ingested = ingest.op(ingest.setup())
        console.log(JSON.stringify({
          hull: {
            kind: built.hull.kind,
            iso: built.hull.iso,
            components: built.stats.components,
            vertices: built.stats.vertices,
          },
          mask: { kind: maskContext.hull.kind, bytes: mask.op(maskContext).length },
          ingest: {
            hullKind: ingested.handle.hull.kind,
            frontRect: ingested.handle.frontRect,
            rect: ingested.handle.rect,
          },
        }))
      `,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

it('keeps the real hull-mask fixture aligned with the live smooth-edge derivation', () => {
  const actual = probeScenarios()

  // The shipped 47px edge with 0.53 variance centres its hull band at 47 reference pixels.
  // At a 512px field, that is 47 * 512 / 1000 texels, and `buildHull` traces its negative iso.
  expect(actual.hull.kind).toBe('polygons')
  expect(actual.hull.iso).toBeCloseTo((-47 * 512) / 1000, 12)
  expect(actual.hull.components).toBe(1)
  expect(actual.hull.vertices).toBeGreaterThan(3)

  // The documented row fills a 512x512 RGBA polygon mask, never a use-alpha fallback.
  expect(actual.mask).toEqual({ kind: 'polygons', bytes: 512 * 512 * 4 })

  // `source()+build()` must reach the same real polygon path and clear its guard band.
  expect(actual.ingest.hullKind).toBe('polygons')
  expect(actual.ingest.frontRect).toEqual({ x: 134, y: 56, w: 824, h: 866 })
  expect(actual.ingest.rect).toEqual({ x: 35, y: -63, w: 1039, h: 1092 })
})
