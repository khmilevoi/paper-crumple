import { KNOB_REFERENCE_PX } from '@paper-crumple/core'
import { describe, expect, it } from 'vitest'

import { FIBRE_TILE_PX, MOTION_KNOBS } from './knobs.js'

describe('the motion knob registry (§6.7)', () => {
  it('declares five look knobs plus a debug view, and nothing else', () => {
    expect(MOTION_KNOBS.map((k) => k.key)).toEqual([
      'ambient',
      'aoStrength',
      'aoGamma',
      'backShade',
      'grain',
      'debug',
    ])
  })

  it('declares no shared knob: paperColor and paperBack are core-declared (§6.2)', () => {
    const keys = MOTION_KNOBS.map((k) => k.key)
    expect(keys).not.toContain('paperColor' as never)
    expect(keys).not.toContain('paperBack' as never)
    expect(MOTION_KNOBS.some((k) => 'binds' in k)).toBe(false)
  })

  it('declares no lightAngle: uLight is read from the manifest, so it is not shareable (§6.2)', () => {
    expect(MOTION_KNOBS.map((k) => k.key)).not.toContain('lightAngle' as never)
  })

  it('is draw-class throughout — none of the six touches a texture or a program (§6.3, §6.5)', () => {
    for (const k of MOTION_KNOBS) expect(k.invalidates).toBe('draw')
  })

  it('carries the spike look defaults and ranges verbatim (crumple.js:33-46)', () => {
    const byKey = Object.fromEntries(MOTION_KNOBS.map((k) => [k.key, k]))
    expect(byKey.ambient).toMatchObject({
      kind: 'number',
      default: 0.86,
      min: 0,
      max: 1,
      step: 0.01,
    })
    expect(byKey.aoStrength).toMatchObject({
      kind: 'number',
      default: 0.48,
      min: 0,
      max: 1,
      step: 0.01,
    })
    expect(byKey.aoGamma).toMatchObject({
      kind: 'number',
      default: 0.3,
      min: 0.1,
      max: 2,
      step: 0.01,
    })
    expect(byKey.backShade).toMatchObject({
      kind: 'number',
      default: 0.94,
      min: 0.3,
      max: 1,
      step: 0.01,
    })
    expect(byKey.grain).toMatchObject({
      kind: 'number',
      default: 0.18,
      min: 0,
      max: 0.6,
      step: 0.01,
    })
  })

  it("keeps motion's grain apart from the sheet's 0.09, which §6.2 says was tuned separately", () => {
    const grain = MOTION_KNOBS.find((k) => k.key === 'grain')
    expect(grain).toMatchObject({ default: 0.18 })
    expect(grain).not.toMatchObject({ default: 0.09 })
  })

  it('is a six-name debug enum, dev-only, defaulting to composite', () => {
    const debug = MOTION_KNOBS.find((k) => k.key === 'debug')
    expect(debug).toMatchObject({ kind: 'enum', default: 'composite', dev: true })
    expect(debug && 'values' in debug ? debug.values : []).toEqual([
      'composite',
      'normals',
      'ao',
      'uv',
      'sheet alpha',
      'facing',
    ])
  })

  it('marks no knob sprite-px: none of the six is a length (§6.4)', () => {
    for (const k of MOTION_KNOBS) expect('reference' in k ? k.reference : undefined).toBeUndefined()
  })

  it('quotes the fibre tile against the same 1000 px reference paper.js uses (§6.4)', () => {
    expect(FIBRE_TILE_PX).toBe(300)
    expect(KNOB_REFERENCE_PX).toBe(1000)
  })
})
