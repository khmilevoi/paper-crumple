import { describe, expect, it } from 'vitest'

import { ATTR, DEBUG_VIEWS, SHEET_FS, SHEET_VS } from './shaders.js'

describe('the attribute layout (§3.1, §8.8)', () => {
  it('is position 0, normal 1, ao 2, uv 3 — the VAO is the layout binding', () => {
    expect(ATTR).toEqual({ position: 0, normal: 1, ao: 2, uv: 3 })
  })

  it('matches the layout(location = N) declarations in the vertex shader', () => {
    expect(SHEET_VS).toContain(`layout(location = ${ATTR.position}) in vec3 aPos;`)
    expect(SHEET_VS).toContain(`layout(location = ${ATTR.normal}) in vec2 aOct;`)
    expect(SHEET_VS).toContain(`layout(location = ${ATTR.ao}) in float aAo;`)
    expect(SHEET_VS).toContain(`layout(location = ${ATTR.uv}) in vec2 aUv;`)
  })
})

describe('the sheet program (§5.1, §7.3)', () => {
  it('is GLSL ES 3.00 on both stages', () => {
    expect(SHEET_VS.startsWith('#version 300 es')).toBe(true)
    expect(SHEET_FS.startsWith('#version 300 es')).toBe(true)
  })

  it('binds exactly two textures, uFront and uFibre', () => {
    const samplers = [...SHEET_FS.matchAll(/uniform sampler2D (\w+);/g)].map((m) => m[1])
    expect(samplers).toEqual(['uFront', 'uFibre'])
  })

  it('names every uniform the draw sets, and no other', () => {
    const uniforms = [...SHEET_VS.matchAll(/^uniform \w+ (\w+);/gm)]
      .concat([...SHEET_FS.matchAll(/^uniform \w+ (\w+);/gm)])
      .map((m) => m[1])
      .sort()
    expect(uniforms).toEqual(
      [
        'uAlphaFloor',
        'uAmbient',
        'uAoGamma',
        'uAoStrength',
        'uBackShade',
        'uDebug',
        'uDepthPx',
        'uFibre',
        'uFibreScale',
        'uFront',
        'uGrain',
        'uIdentity',
        'uLight',
        'uPaperBack',
        'uPaperColor',
        'uSheetPx',
        'uUvRect',
        'uViewPx',
      ].sort(),
    )
  })
})

describe('the compaction ramp — the property §4.2 depends on (§9.1)', () => {
  it('raises alpha to the floor', () => {
    expect(SHEET_FS).toContain('float alpha = max(front.a, uAlphaFloor);')
  })

  it('fades the whole front composite to paper by the same floor, not alpha alone', () => {
    // At floor 1 this is pure paper on both sides: the ball carries no sprite identity at all.
    expect(SHEET_FS).toContain('paper, uAlphaFloor)')
    expect(SHEET_FS).toContain('rgb = mix(')
  })

  it('reads the light from the manifest and not from a knob (§6.2, §9.3)', () => {
    expect(SHEET_FS).toContain('uniform vec3 uLight;')
    expect(SHEET_FS).not.toContain('lightAngle')
  })
})

describe('the six debug views', () => {
  it('has one branch per name, and the names are the enum values', () => {
    expect(DEBUG_VIEWS).toHaveLength(6)
    expect(DEBUG_VIEWS[0]).toBe('composite')
    // 'composite' is index 0 and is the fall-through; the other five are explicit branches.
    expect(SHEET_FS).toContain('if (uDebug == 1)')
    expect(SHEET_FS).toContain('if (uDebug == 2)')
    expect(SHEET_FS).toContain('if (uDebug == 3)')
    expect(SHEET_FS).toContain('if (uDebug == 4)')
    expect(SHEET_FS).toContain('if (uDebug == 5)')
  })
})
