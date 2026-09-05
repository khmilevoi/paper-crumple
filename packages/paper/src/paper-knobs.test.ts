import { describe, expect, it } from 'vitest'
import type { EdgeFinish, EdgeShape, EdgeSpec, EdgeWidthUnit } from '@paper-crumple/core/unstable'
import {
  descriptorsFor,
  defaultsFor,
  edgeParamsFrom,
  resolveSdfRes,
  SDF_RES_KNOB,
} from './paper-knobs.js'

const spec = (shape: EdgeShape, finish: EdgeFinish, widthUnit: EdgeWidthUnit = 'px'): EdgeSpec => ({
  shape,
  finish,
  widthUnit,
})

describe('descriptorsFor (design 2026-09-05 §2.4)', () => {
  it('lands the four cells counts', () => {
    expect(descriptorsFor(spec('smooth', 'clean')).length).toBe(24)
    expect(descriptorsFor(spec('smooth', 'paper')).length).toBe(30)
    expect(descriptorsFor(spec('torn', 'clean')).length).toBe(28)
    expect(descriptorsFor(spec('torn', 'paper')).length).toBe(34)
  })

  it('carries exactly one edgeWidth descriptor, chosen by the unit', () => {
    for (const shape of ['smooth', 'torn'] as const) {
      for (const unit of ['px', 'percent'] as const) {
        const width = descriptorsFor(spec(shape, 'clean', unit)).filter(
          (d) => d.key === 'edgeWidth',
        )
        expect(width).toHaveLength(1)
        expect(width[0].kind === 'number' && width[0].reference).toBe(
          unit === 'px' ? 'sprite-px' : 'artwork-pct',
        )
      }
    }
  })

  it('invalidates the hull under smooth and only the front under torn', () => {
    const of = (s: EdgeSpec, key: string) => descriptorsFor(s).find((d) => d.key === key)
    for (const key of ['edgeWidth', 'edgeVariance']) {
      expect(of(spec('smooth', 'clean'), key)?.invalidates).toBe('hull')
      expect(of(spec('torn', 'clean'), key)?.invalidates).toBe('front')
    }
  })

  it('drops every deleted knob', () => {
    for (const shape of ['smooth', 'torn'] as const) {
      for (const finish of ['clean', 'paper'] as const) {
        const keys = descriptorsFor(spec(shape, finish)).map((d) => d.key)
        for (const gone of ['minDist', 'maxDist', 'tearAmp', 'midAmp', 'thickness']) {
          expect(keys, `${shape}/${finish}`).not.toContain(gone)
        }
      }
    }
  })

  it('hides the finish knobs under clean and shows six under paper', () => {
    const clean = descriptorsFor(spec('torn', 'clean')).map((d) => d.key)
    const paper = descriptorsFor(spec('torn', 'paper')).map((d) => d.key)
    const finishKeys = [
      'deckleWidth',
      'deckleLight',
      'deckleTex',
      'fibers',
      'fiberLen',
      'tearShadow',
    ]
    for (const k of finishKeys) {
      expect(clean).not.toContain(k)
      expect(paper).toContain(k)
    }
  })

  it('gives torn its five shape knobs and smooth its one', () => {
    const torn = descriptorsFor(spec('torn', 'clean')).map((d) => d.key)
    expect(torn).toEqual(
      expect.arrayContaining(['tearFreq', 'tearAngular', 'looseness', 'chew', 'tearMix']),
    )
    expect(descriptorsFor(spec('smooth', 'clean')).map((d) => d.key)).toContain('angularity')
    expect(descriptorsFor(spec('smooth', 'clean')).map((d) => d.key)).not.toContain('tearMix')
  })
})

describe('defaultsFor (design 2026-09-05 §2.4)', () => {
  it('is total over descriptorsFor(spec): every key that spec exposes has a default', () => {
    for (const shape of ['smooth', 'torn'] as const) {
      for (const finish of ['clean', 'paper'] as const) {
        const s = spec(shape, finish)
        const d = defaultsFor(s)
        for (const descriptor of descriptorsFor(s)) {
          expect(d).toHaveProperty(descriptor.key, descriptor.default)
        }
      }
    }
  })

  it('carries the percent default, 5.9, not the px one, when widthUnit is percent', () => {
    expect(defaultsFor(spec('smooth', 'clean', 'percent')).edgeWidth).toBe(5.9)
    expect(defaultsFor(spec('smooth', 'clean', 'px')).edgeWidth).toBe(47)
  })
})

describe('edgeParamsFrom (design 2026-09-05 §4.1)', () => {
  it('zeroes the finish terms under clean, whatever the bag holds', () => {
    const p = edgeParamsFrom(
      spec('torn', 'clean'),
      { edgeVariance: 0.53, fiberLen: 4, deckleWidth: 7 },
      47,
    )
    expect(p).toEqual({ widthRef: 47, variance: 0.53, fiberLen: 0, deckleWidth: 0 })
  })

  it('reads the finish terms under paper', () => {
    const p = edgeParamsFrom(
      spec('torn', 'paper'),
      { edgeVariance: 0.53, fiberLen: 4, deckleWidth: 7 },
      47,
    )
    expect(p.fiberLen).toBe(4)
    expect(p.deckleWidth).toBe(7)
  })

  it('never reads edgeWidth from the bag: the caller resolves the unit', () => {
    const p = edgeParamsFrom(spec('torn', 'clean'), { edgeWidth: 999 }, 47)
    expect(p.widthRef).toBe(47)
  })

  it('resolves a missing edgeVariance from defaultsFor(spec), never a literal 0 (ruling R3)', () => {
    const s = spec('torn', 'clean')
    const p = edgeParamsFrom(s, {}, 47)
    expect(p.variance).toBe(defaultsFor(s).edgeVariance)
    expect(p.variance).toBe(0.53)
  })
})

// The following behaviour belongs to `resolveSdfRes` and `SDF_RES_KNOB`, neither of which this
// task touches (design 2026-09-05 §2.4: "`SDF_RES_KNOB` untouched"). Kept here because it is
// this file's only coverage of that function.
describe('resolveSdfRes (spec 7.4.3)', () => {
  it('derives from the front long side when the knob is 0', () => {
    expect(resolveSdfRes(0, 384)).toBe(192)
    expect(resolveSdfRes(0, 998)).toBe(512)
    expect(resolveSdfRes(0, 64)).toBe(128)
  })

  it('quantises and clamps an explicit override', () => {
    expect(resolveSdfRes(300, 384)).toBe(320)
    expect(resolveSdfRes(64, 384)).toBe(128)
    expect(resolveSdfRes(9999, 384)).toBe(512)
  })

  it('is still a knob at the field invalidation level', () => {
    expect(SDF_RES_KNOB.invalidates).toBe('field')
  })
})
