import { describe, expect, it } from 'vitest'
import type { KnobDescriptor } from './knobs.js'
import { SHARED_KNOBS } from './shared-knobs.js'
import { isHex } from './color.js'

describe('the core-declared shared knobs (§6.2, §6.7)', () => {
  // Viewed as a KnobDescriptor — which is how `stage.knobs` hands these to a panel — `ui` and
  // `binds` are declared and optional, so the two assertions below read the same property a
  // consumer reads. The annotation is an assignability proof, not a cast.
  const descriptors: readonly KnobDescriptor[] = SHARED_KNOBS

  it('declares exactly paperColor and paperBack', () => {
    expect(SHARED_KNOBS.map((d) => d.key)).toEqual(['paperColor', 'paperBack'])
  })

  it('never declares lightAngle, which is baked into the pack and is paper-only', () => {
    // material.js:167 sets uLight from the manifest's light vector, which §9.3 lists as baked
    // into the pack. A shared lightAngle would promise two slots a value only one of them owns.
    expect(SHARED_KNOBS.map((d) => d.key)).not.toContain('lightAngle')
  })

  it('declares both as colours with valid hex defaults', () => {
    for (const d of SHARED_KNOBS) {
      expect(d.kind).toBe('color')
      expect(isHex(d.default)).toBe(true)
    }
  })

  it('declares both at front, because the sheet bakes the colour into the front texture', () => {
    // Front implies draw, so material.js's per-draw uniforms are covered too; and neither colour
    // reaches the hull or the SDF, so putting them at 'hull' would bust the hull cache on a
    // colour change. 'front' is the only level that is neither too weak nor too strong — and it
    // is what keeps paperColor off view.set, which §6.6 requires of a front-class knob.
    expect(SHARED_KNOBS.map((d) => d.invalidates)).toEqual(['front', 'front'])
  })

  it('carries no ui labels, so a consumer bundle pays nothing for a UI core does not own', () => {
    for (const d of descriptors) expect(d.ui).toBeUndefined()
  })

  it('binds nothing itself — core is the declarer, slots are the binders', () => {
    for (const d of descriptors) expect(d.binds).toBeUndefined()
  })
})
