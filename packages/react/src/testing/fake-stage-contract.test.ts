/** @vitest-environment jsdom */
import { expect, it } from 'vitest'
import { createFakeStage } from './fake-stage.js'
import { makeReactiveStage, makeReactiveCanvas } from '../../../core/src/testing/reactive-stage.js'
import { isAborted } from '../../../core/src/abort.js'

it('fake stage batches sprite, view, and stage settings with normalized local overrides', () => {
  const fake = createFakeStage()
  const sprite = fake.addSprite('a')
  const view = fake.stage.view({ canvas: document.createElement('canvas') })
  if (view instanceof Error) return expect.fail('view refused')
  const seen: unknown[] = []
  const read = () => seen.push([fake.stage.appliedKnobs, sprite.appliedKnobs, view.appliedKnobs])
  for (const entity of [fake.stage, sprite, view]) entity.changes.subscribe('settings', read)
  fake.stage.batch(() => {
    fake.stage.set({ paperColor: '#123456' } as never)
    sprite.set({ paperColor: '#abcdef' } as never)
    sprite.set({ paperColor: '#fedcba' } as never)
    view.set({ sheetTint: 0.5 } as never)
    expect(seen).toEqual([])
  })
  expect(seen).toHaveLength(3)
  for (const row of seen)
    expect(row).toEqual([
      { 'core.paperColor': '#123456' },
      { 'core.paperColor': '#fedcba' },
      { 'sheet.sheetTint': 0.5 },
    ])
  fake.stage.dispose()
})

it.each(['remove', 'dispose'] as const)(
  'fake %s publishes terminal sprite resources and refuses later settings',
  (operation) => {
    const fake = createFakeStage()
    const sprite = fake.addSprite('a')
    const seen: unknown[] = []
    sprite.changes.subscribe('resources', () =>
      seen.push([sprite.resident, fake.stage.get('a'), fake.stage.disposed]),
    )
    if (operation === 'remove') fake.stage.remove('a')
    else fake.stage.dispose()
    expect(seen).toEqual([[false, undefined, operation === 'dispose']])
    const revision = sprite.changes.revision('settings')
    expect(sprite.set({ paperColor: '#ffffff' } as never)).toBeInstanceOf(Error)
    expect(sprite.changes.revision('settings')).toBe(revision)
    fake.stage.dispose()
  },
)

it('fake declared knob normalization and rejection match real local overrides', async () => {
  const fake = createFakeStage({
    knobs: [
      { key: 'sheetTint', kind: 'number', invalidates: 'draw', default: 0, min: 0, max: 1 },
      { key: 'sheetHull', kind: 'number', invalidates: 'hull', default: 0.5, min: 0, max: 1 },
    ],
  })
  const real = await makeReactiveStage()
  const a = fake.addSprite('a')
  const b = await real.add('/a.png', { key: 'a' })
  const x = fake.stage.view({ canvas: document.createElement('canvas') })
  const y = real.view({ canvas: makeReactiveCanvas() })
  if (b instanceof Error || isAborted(b) || x instanceof Error || y instanceof Error)
    return expect.fail('setup refused')
  for (const entity of [fake.stage, real, a, b, x, y]) {
    const set = entity.set as (patch: Readonly<Record<string, unknown>>) => unknown
    expect(set({ sheetTint: 0.8 })).toBeUndefined()
  }
  expect(fake.stage.appliedKnobs).toEqual(real.appliedKnobs)
  expect(a.appliedKnobs).toEqual(b.appliedKnobs)
  expect(x.appliedKnobs).toEqual(y.appliedKnobs)
  const before = x.changes.revision('settings')
  expect(x.set({ sheetHull: 0.8 } as never)).toBeInstanceOf(Error)
  expect(x.changes.revision('settings')).toBe(before)
  expect(x.appliedKnobs).toEqual(y.appliedKnobs)
  fake.stage.dispose()
  real.dispose()
})
