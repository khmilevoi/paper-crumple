import { afterEach, describe, expect, it } from 'vitest'
import fixtureUrl from './testing/fixtures/resample-24x18.bin?url'
import { GlError, SheetError } from './errors.js'
import { identityResample, resampleAreaExact, type ResampleSource } from './resample.js'
import { fixtureSource, makeSource } from './testing/resample-corpus.js'
import { resampleOnGpu } from './testing/gl-resample.js'
import { createGlFixture, type GlFixture } from './testing/gl-fixture.js'

let fixture: GlFixture | null = null

afterEach(() => {
  // §4.0's cap of roughly sixteen live contexts. Dispose, never re-run.
  fixture?.dispose()
  fixture = null
})

function open(): GlFixture {
  fixture = createGlFixture(4, 4)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

function reference(source: ResampleSource, dstW: number, dstH: number): Uint8ClampedArray {
  const result = resampleAreaExact(
    source,
    { x: 0, y: 0, w: source.width, h: source.height },
    dstW,
    dstH,
  )
  expect(SheetError.is(result)).toBe(false)
  return result as Uint8ClampedArray
}

function onGpu(
  ctx: GlFixture['ctx'],
  source: ResampleSource,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  const result = resampleOnGpu(
    ctx,
    source,
    { x: 0, y: 0, w: source.width, h: source.height },
    dstW,
    dstH,
  )
  expect(GlError.is(result)).toBe(false)
  return result as Uint8ClampedArray
}

/** The first index where two buffers differ, or -1. Named so a failure reads as a texel. */
function firstDifference(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number): string {
  if (a.length !== b.length) {
    return `length mismatch: gpu ${a.length} bytes vs reference ${b.length} bytes`
  }
  if (a.length === 0) {
    return 'both buffers are empty: no bytes were compared'
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const texel = Math.floor(i / 4)
      const channel = 'rgba'[i % 4]
      return `texel (${texel % width}, ${Math.floor(texel / width)}) channel ${channel}: gpu ${a[i]} vs reference ${b[i]}`
    }
  }
  return 'identical'
}

describe('the GLSL twin is byte-identical to the reference (§7.4.1, §7.4.2)', () => {
  it('agrees on 998x951 -> 384x384, which is both size pairs §7.4.1 names by hand', () => {
    const { ctx } = open()
    const source = makeSource(998, 951, 1)
    const gpu = onGpu(ctx, source, 384, 384)
    const cpu = reference(source, 384, 384)
    expect(firstDifference(gpu, cpu, 384)).toBe('identical')
  }, 180_000)

  it('agrees on 4096x64 -> 64x64: an extreme reduction on one axis, ratio 1 on the other', () => {
    const { ctx } = open()
    expect(ctx.caps.maxTextureSize).toBeGreaterThanOrEqual(4096)
    const source = makeSource(4096, 64, 2)
    const gpu = onGpu(ctx, source, 64, 64)
    const cpu = reference(source, 64, 64)
    expect(firstDifference(gpu, cpu, 64)).toBe('identical')
  }, 180_000)

  it('agrees on 3x3 -> 2x2, the smallest pair with a shared source texel', () => {
    const { ctx } = open()
    const source = makeSource(3, 3, 3)
    expect(firstDifference(onGpu(ctx, source, 2, 2), reference(source, 2, 2), 2)).toBe('identical')
  })

  it('agrees on 8x8 -> 4x4, where the exact 2x average falls out as a special case', () => {
    const { ctx } = open()
    const source = makeSource(8, 8, 4)
    expect(firstDifference(onGpu(ctx, source, 4, 4), reference(source, 4, 4), 4)).toBe('identical')
  })

  it('agrees on 7x5 -> 11x3, so magnification is not a separate path either', () => {
    const { ctx } = open()
    const source = makeSource(7, 5, 5)
    expect(firstDifference(onGpu(ctx, source, 11, 3), reference(source, 11, 3), 11)).toBe(
      'identical',
    )
  })

  it('is a bitwise copy at ratio 1, including RGB under zero alpha (§7.4.2)', () => {
    const { ctx } = open()
    const source = makeSource(96, 72, 6)
    const gpu = onGpu(ctx, source, 96, 72)
    // Structural, not a fast path: the shader has no short-circuit at all, and it still lands
    // on the source byte for byte.
    expect(firstDifference(gpu, source.data, 96)).toBe('identical')
    // And it agrees with the shipped entry point, whose short-circuit P5 proved equivalent.
    const shipped = identityResample(source, { x: 0, y: 0, w: 96, h: 72 }, 96, 72)
    expect(firstDifference(gpu, shipped as Uint8ClampedArray, 96)).toBe('identical')
  })

  it('reads a sub-rect at its offset rather than from the origin', () => {
    const { ctx } = open()
    const source = makeSource(64, 48, 7)
    const gpu = resampleOnGpu(ctx, source, { x: 5, y: 7, w: 16, h: 16 }, 8, 8)
    expect(GlError.is(gpu)).toBe(false)
    const cpu = resampleAreaExact(source, { x: 5, y: 7, w: 16, h: 16 }, 8, 8)
    expect(firstDifference(gpu as Uint8ClampedArray, cpu as Uint8ClampedArray, 8)).toBe('identical')
  })
})

describe('the committed raw-byte fixture, through §11.1 fixture path', () => {
  it('loads as bytes over ?url + fetch and resamples identically to the reference', async () => {
    const { ctx } = open()
    const response = await fetch(fixtureUrl)
    const loaded = new Uint8ClampedArray(await response.arrayBuffer())
    expect(loaded.byteLength).toBe(1728)

    // The served bytes are the generated bytes: the transport did not decode, convert or
    // colour-manage anything, which is the whole reason this tier does not use a PNG.
    const generated = fixtureSource()
    expect(firstDifference(loaded, generated.data, 24)).toBe('identical')

    const source: ResampleSource = { data: loaded, width: 24, height: 18 }
    const gpu = onGpu(ctx, source, 8, 6)
    const cpu = reference(source, 8, 6)
    expect(firstDifference(gpu, cpu, 8)).toBe('identical')
  })
})
