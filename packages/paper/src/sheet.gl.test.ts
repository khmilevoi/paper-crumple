import { afterEach, describe, expect, it } from 'vitest'
import { GlError, SheetError } from '@paper-crumple/core'
import { createGlFixture, type PaperGlFixture } from './testing/gl-fixture.js'
import { paperSheet } from './sheet.js'

// The `source`/`build` suites are added by tasks 11 and 12; this file stays additive across all
// three (task 10's own brief).

let fixture: PaperGlFixture | null = null

afterEach(() => {
  // §4.0 caps live WebGL2 contexts at roughly sixteen and Vitest opens one page per file.
  fixture?.dispose()
  fixture = null
})

function open() {
  fixture = createGlFixture(8, 8)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture.ctx
}

describe('paperSheet as a factory (spec 6.5, 14)', () => {
  it("defaults to edgeMode 'hull', which is paper.js's own default", () => {
    expect(paperSheet().edgeMode).toBe('hull')
  })

  it('exposes 24 descriptors in hull mode and 34 in torn mode', () => {
    expect(paperSheet().knobs).toHaveLength(24)
    expect(paperSheet({ edgeMode: 'torn' }).knobs).toHaveLength(34)
    expect(paperSheet().knobs.map((k) => k.key)).not.toContain('tearAmp')
  })

  // §8.6's headline figures (hull ~= 0.09, torn ~= 0.17) are worked from an illustrative
  // maxDist of 64 reference px (core's own `overscan.test.ts` says so explicitly: "the default
  // *values* of these knobs belong to the paper slot"). This package's own `HULL_KNOBS` default
  // is `maxDist: 72` (paper-knobs.ts, task 3, already landed), and `TORN_KNOBS`'s defaults carry
  // through the rest of the formula, so the number this factory actually reports is
  // `84 / (1000 - 168) ≈ 0.1010` for hull and `≈ 0.2139` for torn — both computed here from the
  // real, already-landed knob defaults and `EDGE_SLOP_REFERENCE_PX = 12` (core, unmodifiable),
  // not from §8.6's illustrative example. See task 10's own report for the arithmetic.
  it('reports the factory-level overscan: ~0.10 for hull, ~0.21 for torn (spec 8.6)', () => {
    expect(paperSheet().overscan).toBeGreaterThan(0.09)
    expect(paperSheet().overscan).toBeLessThan(0.11)
    const torn = paperSheet({ edgeMode: 'torn' }).overscan
    expect(torn).toBeGreaterThan(0.19)
    expect(torn).toBeLessThan(0.22)
  })

  it('reserves more when overscanHeadroom is given', () => {
    expect(paperSheet({ overscanHeadroom: 0.5 }).overscan).toBeGreaterThan(paperSheet().overscan)
  })

  it('defaults tiles to null, because hull needs no fibre at all (spec 14)', async () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    await expect(sheet.tilesReady).resolves.toBe(true)
    sheet.dispose()
  })
})

describe('mount and dispose (spec 5.2)', () => {
  it('is a SheetError, not a throw, to source before mount', async () => {
    const sheet = paperSheet()
    const bitmap = await createImageBitmap(new ImageData(4, 4))
    const r = await sheet.source(bitmap, { maxSize: 128, exact: false })
    expect(SheetError.is(r)).toBe(true)
    expect((r as Error).message).toContain('mount')
    bitmap.close()
  })

  it('is a SheetError, not a throw, to build before mount', () => {
    const sheet = paperSheet()
    const r = sheet.build(
      {} as Parameters<typeof sheet.build>[0],
      { w: 128, h: 128 },
      {} as Parameters<typeof sheet.build>[2],
    )
    expect(SheetError.is(r)).toBe(true)
    expect((r as Error).message).toContain('mount')
  })

  it('mounts once and reports a GlError rather than throwing on a second mount', () => {
    const ctx = open()
    const sheet = paperSheet()
    expect(sheet.mount(ctx)).toBeUndefined()
    expect(GlError.is(sheet.mount(ctx))).toBe(true)
    sheet.dispose()
  })

  it('is idempotent on dispose, because React runs cleanups child-first', () => {
    const ctx = open()
    const sheet = paperSheet()
    sheet.mount(ctx)
    sheet.dispose()
    // Not merely "did not throw" — under the no-throw rule that can never fail and is not a
    // test. The observable state a second, redundant `dispose()` must leave alone: a fresh
    // `mount()` on the same context afterwards still succeeds, which it would not if the second
    // `dispose()` had double-freed anything the first one already released.
    expect(() => sheet.dispose()).not.toThrow()
    expect(sheet.mount(ctx)).toBeUndefined()
    sheet.dispose()
  })
})
