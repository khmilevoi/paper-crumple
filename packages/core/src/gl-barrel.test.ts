import { describe, expect, it } from 'vitest'
import * as root from './index.js'
import * as unstable from './unstable.js'

/**
 * A subset check and never an exact-set check: both barrels are append-only surfaces at sync 3
 * and P6, P7, P8 and P15 all land there. Asserting the exact set would turn a neighbour's append
 * into a P6 failure.
 */
describe('the slot-authoring surface, after P6', () => {
  it('exports the GL foundation a slot author needs, and nothing they would have to reinvent', () => {
    for (const name of [
      'GL_ATTRIBUTES',
      'createGlContext',
      'createGpuTimer',
      'createScratchPools',
      'POOL_B_IDLE_MS',
      'drawTargetFor',
      'textureBytes',
      'uploadBytes',
      'TEXTURE_FORMAT_BYTES',
      'TEXTURE_FORMAT_GL',
      'INTEGER_FORMATS',
      'FLOAT_FORMATS',
      'FULLSCREEN_VS',
      'RESAMPLE_FS',
      'RESAMPLE_UNIFORMS',
      'probeExactByteFetch',
    ]) {
      expect(Object.hasOwn(unstable, name), `P6 did not export ${name}`).toBe(true)
    }
  })

  it('still exports what P2, P3 and P5 put there, so the append did not rewrite the file', () => {
    for (const name of [
      'taggedError',
      'hexToRgb',
      'identityResample',
      'axisPlan',
      'scratchBytes',
      'sdfResFor',
    ]) {
      expect(Object.hasOwn(unstable, name), `P6 clobbered ${name}`).toBe(true)
    }
  })

  it('adds nothing to the stable root, because none of this is a consumer surface (§14)', () => {
    for (const name of [
      'createGlContext',
      'GL_ATTRIBUTES',
      'createScratchPools',
      'createGpuTimer',
      'RESAMPLE_FS',
      'probeExactByteFetch',
      'captureGlState',
      'restoreGlState',
      'pinAmbientState',
    ]) {
      expect(Object.hasOwn(root, name), `leaked onto the root: ${name}`).toBe(false)
    }
  })

  it('keeps the state machinery and the test harness off both barrels', () => {
    // captureGlState / restoreGlState / pinAmbientState are how scope() is implemented, not a
    // surface: a slot that saves state by hand is a slot that will forget an item of §5.1's list.
    // The fixtures and the corpus are test-only and must reach no tarball.
    for (const name of [
      'captureGlState',
      'restoreGlState',
      'pinAmbientState',
      'createGlFixture',
      'createRawGl',
      'resampleOnGpu',
      'makeSource',
    ]) {
      expect(Object.hasOwn(unstable, name), `leaked internal: ${name}`).toBe(false)
    }
  })
})
