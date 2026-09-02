import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dir = new URL('../packages/paper/src/tiles/', import.meta.url)

/**
 * Spec 14's settled recipe: four 512x512 grayscale WebP tiles at quality 84, budgeted at
 * 397 478 B. P10 baked them from the premultiplied product (spec 14.1) and landed at 333 344 B, so
 * there is 64 134 B of headroom. This gate exists for the day someone bumps the quality "just for
 * a moment" — the release fails rather than the tarball quietly growing.
 */
const BUDGET_BYTES = 397_478
const SHIPPED_BYTES = 333_344

const files = readdirSync(dir).sort()
const bytes = new Map(files.map((name) => [name, readFileSync(new URL(name, dir)).length]))
const total = [...bytes.values()].reduce((sum, n) => sum + n, 0)

describe('the shipped paper tiles', () => {
  it('is exactly the four channels the shader samples, and no fifth file', () => {
    expect(files).toEqual(['crumple-a.webp', 'crumple-g.webp', 'crumple-r.webp', 'fibre-a.webp'])
  })

  it('stays inside the 397 478 B budget spec 14 settled on', () => {
    expect(total).toBeLessThanOrEqual(BUDGET_BYTES)
  })

  it('is still the 333 344 B bake, to within a re-encode that keeps the same recipe', () => {
    // Not `toBe`: a legitimate re-bake at the same recipe may move by a few bytes. The budget
    // above is the hard line; this is the tripwire that says a re-bake happened at all.
    expect(total).toBeGreaterThan(SHIPPED_BYTES * 0.9)
    expect(total).toBeLessThan(SHIPPED_BYTES * 1.1)
  })

  it('is WebP in every file, so a PNG regression cannot hide inside the budget', () => {
    for (const name of files) {
      const head = readFileSync(new URL(name, dir)).subarray(0, 12)
      expect(head.toString('ascii', 0, 4)).toBe('RIFF')
      expect(head.toString('ascii', 8, 12)).toBe('WEBP')
    }
  })
})
