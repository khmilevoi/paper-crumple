import { describe, it, expect } from 'vitest'
import { DEBUG_MODES, PAPER_FS, PAPER_UNIFORMS } from './paper-shader.js'

describe('DEBUG_MODES', () => {
  it('has the expected length', () => {
    expect(DEBUG_MODES.length).toBe(8)
  })

  it('matches the spike array verbatim', () => {
    const expected = [
      'composite',
      'raw SDF',
      'loose SDF',
      'paper mask',
      'fold regions',
      'fold depth',
      'artwork only',
      'paper field',
    ]
    expect(DEBUG_MODES).toEqual(expected)
  })
})

/**
 * The edge redesign's shader surface (design 2026-09-05 §6, §6.1, §7).
 *
 * `uThickness` did four jobs; three of them are the master ramp (which must read `W` in every
 * cell) and the fourth is an outward bias (which must be `0` under a polygon contour). They are
 * now two uniforms, `uEdgeWidth` and `uBaseBias`, and the three-valued `uEdgeMode` is gone
 * entirely — the contour is expressed by which textures the renderer binds, never by a mode int.
 */
describe('PAPER_FS — the edge uniforms (design 2026-09-05 §6)', () => {
  it('carries no edge-mode int and no thickness uniform (design 2026-09-05 §6)', () => {
    expect(PAPER_FS).not.toMatch(/uEdgeMode/)
    expect(PAPER_FS).not.toMatch(/uThickness/)
    expect(PAPER_FS).not.toMatch(/uLoosePush/)
    expect(PAPER_FS).not.toMatch(/uLooseness/)
    expect(PAPER_FS).toMatch(/uniform float uEdgeWidth;/)
    expect(PAPER_FS).toMatch(/uniform float uBaseBias;/)
    expect(PAPER_FS).toMatch(/uniform int uEdgeFinish;/)
  })

  /**
   * Ruling R14 re-points the brief's version of this case. As written it scanned the same lines
   * for `uEdgeMode`, which the case above has already proved appears nowhere — vacuous. What it
   * MEANT to say is asserted here instead: every line that applies a finish decoration sits
   * under a condition that tests `uEdgeFinish`, so `edgeFinish: 'clean'` provably switches all
   * three decorations off whatever contour the renderer bound.
   *
   * Exempt, by shape rather than by name: comments, the uniform declarations themselves, and
   * `fringeTerm`'s own definition (a definition is not an application).
   */
  it('gates every finish decoration on uEdgeFinish (design 2026-09-05 §6, ruling R14)', () => {
    const lines = PAPER_FS.split('\n')
    // Stack of the enclosing `if (...)` conditions, keyed by the brace depth each opened at.
    const openIfs: { depth: number; cond: string }[] = []
    let depth = 0
    let checked = 0
    for (const line of lines) {
      const trimmed = line.trim()
      const isComment =
        trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
      const isDeclaration = trimmed.startsWith('uniform ')
      const isDefinition = /^float fringeTerm\(/.test(trimmed)
      if (
        !isComment &&
        !isDeclaration &&
        !isDefinition &&
        /uDeckleWidth|uTearShadow|fringeTerm/.test(line)
      ) {
        checked++
        const gated = /uEdgeFinish/.test(line) || openIfs.some((f) => /uEdgeFinish/.test(f.cond))
        expect(gated, `ungated finish decoration: ${trimmed}`).toBe(true)
      }
      const opens = (line.match(/\{/g) ?? []).length
      const closes = (line.match(/\}/g) ?? []).length
      if (!isComment && /^\s*(\}\s*else\s*)?if\s*\(/.test(line) && opens > closes) {
        openIfs.push({ depth, cond: line })
      }
      depth += opens - closes
      while (openIfs.length > 0 && (openIfs[openIfs.length - 1]?.depth ?? -1) >= depth) {
        openIfs.pop()
      }
    }
    // The scan is worthless if it found nothing to check.
    expect(checked).toBeGreaterThanOrEqual(4)
  })

  it('maps the three new uniforms and drops the four old ones', () => {
    expect(PAPER_UNIFORMS).toMatchObject({
      edgeWidth: 'uEdgeWidth',
      baseBias: 'uBaseBias',
      edgeFinish: 'uEdgeFinish',
    })
    expect(PAPER_UNIFORMS).not.toHaveProperty('thickness')
    expect(PAPER_UNIFORMS).not.toHaveProperty('edgeMode')
    expect(PAPER_UNIFORMS).not.toHaveProperty('looseness')
    expect(PAPER_UNIFORMS).not.toHaveProperty('loosePush')
  })

  /**
   * §6.1 item 3: the low octave's `* uLooseness` factor is gone. Until it is, no GL measurement
   * of "the inward reach is `W(1 - v)`" means anything — the amplitude Task 3's `tearAmpsFor`
   * budgets for would still be scaled by a knob it knows nothing about.
   */
  it('has no looseness multiplier left anywhere (design 2026-09-05 §6.1 item 3)', () => {
    expect(PAPER_FS.split('uLooseness').length - 1).toBe(0)
  })

  /**
   * Ruling R11: the three constants that exist once as a TS constant in `edge-derive.ts` and
   * once as a GLSL literal here each carry a sync note at BOTH sites, naming the other by
   * identifier. `CHEW_REACH` has two GLSL sites.
   */
  it('carries the ruling R11 sync notes at every mirrored GLSL constant', () => {
    const notes = PAPER_FS.split('\n').filter((l) => l.includes('edge-derive.ts'))
    expect(notes.length).toBeGreaterThanOrEqual(4)
    for (const name of ['MID_LOW_SMOOTH', 'MID_LOW_ANGULAR', 'MID_HIGH_ANGULAR', 'CHEW_REACH']) {
      expect(
        notes.some((l) => l.includes(name)),
        name,
      ).toBe(true)
    }
  })
})
