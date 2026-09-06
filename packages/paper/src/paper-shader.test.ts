import { describe, it, expect } from 'vitest'
import {
  CHEW_REACH,
  MID_HIGH_ANGULAR,
  MID_LOW_ANGULAR,
  MID_SCALLOP,
  MID_SMOOTH_COEF,
} from './edge-derive.js'
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
   *
   * The POLARITY is asserted, not just the token: `uEdgeFinish == 1` must be what gates the
   * decoration, and a `!=`, a `< / >` or an `== 0` in the same condition disqualifies it. Matching
   * the identifier alone would pass a block gated exactly the wrong way round — `edgeFinish:
   * 'clean'` drawing the deckle and `'paper'` skipping it — which is the one mistake this case
   * exists to catch.
   */
  it('gates every finish decoration on uEdgeFinish (design 2026-09-05 §6, ruling R14)', () => {
    const POSITIVE = /uEdgeFinish\s*==\s*1(?![0-9.])/
    const WRONG_WAY = /uEdgeFinish\s*(?:!=|<|>)|uEdgeFinish\s*==\s*0(?![0-9.])/
    const gates = (text: string): boolean => POSITIVE.test(text) && !WRONG_WAY.test(text)
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
        const gated = gates(line) || openIfs.some((f) => gates(f.cond))
        expect(gated, `finish decoration not gated on uEdgeFinish == 1: ${trimmed}`).toBe(true)
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
   * Ruling R11 accepted a TS/GLSL duplication of these coefficients as unavoidable, kept in step by
   * a sync note at both ends. It is not unavoidable: `PAPER_FS` is a template literal and already
   * interpolates `MAX_FOLDS`, so `edge-derive.ts` — which is where the CPU budgets the amplitudes
   * this same GLSL spends — is now the ONE declaration and the shader reads it.
   *
   * Asserted against the imported constants rather than against the numbers, which is the whole
   * point: change `MID_SCALLOP` in `edge-derive.ts` and the emitted GLSL changes with it and this
   * still passes; re-inline any of them as a literal and it does not.
   */
  it('interpolates its shared coefficients from edge-derive.ts (was ruling R11)', () => {
    expect(PAPER_FS).toContain(`const float MID_SCALLOP = ${MID_SCALLOP};`)
    expect(PAPER_FS).toContain(`* ${MID_SMOOTH_COEF} * MID_SCALLOP;`)
    expect(PAPER_FS).toContain(
      `float midAng = -bite * ${MID_LOW_ANGULAR}.0 + tab * ${MID_HIGH_ANGULAR};`,
    )
    // `CHEW_REACH` reaches the GLSL at two differently scoped `teeth` declarations.
    expect(PAPER_FS.split(`* ${CHEW_REACH};`).length - 1).toBe(2)
    // And nothing is kept in step by hand any more.
    expect(PAPER_FS).not.toContain('SYNC (ruling R11)')
  })
})
