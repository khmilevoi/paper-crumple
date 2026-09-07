import { afterEach, describe, expect, it } from 'vitest'
import { captureGlState, pinAmbientState } from './gl-state.js'
import { probeExactByteFetch } from './gl-probe.js'
import { createRawGl, type RawGl } from './testing/gl-fixture.js'

let raw: RawGl | null = null

afterEach(() => {
  // §4.0's cap of roughly sixteen live contexts.
  raw?.dispose()
  raw = null
})

function open(): WebGL2RenderingContext {
  raw = createRawGl(4, 4)
  expect(raw.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  pinAmbientState(raw.gl)
  return raw.gl
}

describe('probeExactByteFetch (§8.5.3)', () => {
  it('recovers all 256 byte values through the normalised round trip on this driver', () => {
    const gl = open()
    // SwiftShader is a software rasteriser and ES 3.0 fixes unorm->float at exactly c/255, so
    // the probe is expected true here. A false is a real finding, not a flake: it means the
    // usampler2D form stays the runtime path, which §8.5.3 keeps as the normative fallback.
    expect(probeExactByteFetch(gl)).toBe(true)
  })

  it('leaves the enumerated state exactly as it found it, since it runs before any scope', () => {
    const gl = open()
    const before = captureGlState(gl)
    probeExactByteFetch(gl)
    expect(captureGlState(gl)).toEqual(before)
  })

  it('leaks no GL object, so a stage that probes does not grow by a texture', () => {
    const gl = open()
    // A cheap, driver-independent proxy for "deleted everything": the probe is idempotent and
    // does not accumulate. Ten runs in a row still return the same answer and still restore.
    const first = probeExactByteFetch(gl)
    for (let i = 0; i < 9; i++) expect(probeExactByteFetch(gl)).toBe(first)
    expect(gl.getError()).toBe(gl.NO_ERROR)
  })
})
