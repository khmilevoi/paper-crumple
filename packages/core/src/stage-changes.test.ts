import { expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { makeReactiveStage, makeReactiveCanvas } from './testing/reactive-stage.js'
import { createStage } from './stage.js'
import { fakeSheet, fakeMotion, stageEnv } from './testing/fake-slots.js'

it('registration, removal, and loss publish accepted raw changes', async () => {
  let lose = () => {}
  const stage = await createStage(
    { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384 },
    stageEnv({
      onContextLost: (fn) => {
        lose = fn
        return () => {}
      },
    }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  const resources: number[] = []
  stage.changes.subscribe('resources', () => resources.push(stage.usage().handles))
  const sprite = await stage.add('/a.png', { key: 'a' })
  if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
  expect(resources).toEqual([1])
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (view instanceof Error) return expect.fail('view refused')
  expect(resources).toEqual([1, 1])
  stage.remove('a')
  expect(resources).toEqual([1, 1, 0])
  expect(sprite.resident).toBe(false)
  const lost: boolean[] = []
  stage.changes.subscribe('lifecycle', () => lost.push(stage.lost))
  lose()
  lose()
  expect(lost).toEqual([true])
  stage.dispose()
})

it('accepted local settings are observable and stage.batch coalesces callbacks across scopes', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  view.show(sprite)
  const seen: unknown[] = []
  const read = () => seen.push([stage.appliedKnobs, sprite.appliedKnobs, view.appliedKnobs])
  for (const entity of [stage, sprite, view]) entity.changes.subscribe('settings', read)
  stage.batch(() => {
    stage.set({ sheetTint: 0.2 } as never)
    stage.set({ sheetTint: 0.4 } as never)
    sprite.set({ motionTilt: 0.2 } as never)
    view.set({ motionTilt: 0.7 } as never)
    expect(seen).toEqual([])
  })
  expect(seen).toHaveLength(3)
  for (const row of seen)
    expect(row).toEqual([
      { 'sheet.sheetTint': 0.4 },
      { 'motion.motionTilt': 0.2 },
      { 'motion.motionTilt': 0.7 },
    ])
  const revision = view.changes.revision('settings')
  expect(view.set({ sheetHull: 0.8 } as never)).toBeInstanceOf(Error)
  expect(view.changes.revision('settings')).toBe(revision)
  stage.dispose()
  expect(stage.set({ sheetTint: 0.6 } as never)).toBeInstanceOf(Error)
  expect(sprite.set({ motionTilt: 0.1 } as never)).toBeInstanceOf(Error)
  expect(view.set({ motionTilt: 0.1 } as never)).toBeInstanceOf(Error)
})

it('eviction and prepare publish residency, then replacement updates attached geometry and warning together', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  const residency: boolean[] = []
  await stage.add('/b.png', { key: 'b' }) // The LRU deliberately preserves the most recent front.
  sprite.changes.subscribe('resources', () => residency.push(sprite.resident))
  stage.budget({ bytes: 0 })
  expect(residency).toEqual([false])
  stage.budget({ bytes: Infinity })
  await stage.prepare('a')
  expect(residency).toEqual([false, true])
  view.show(sprite)
  const rows: unknown[] = []
  const read = () => rows.push([sprite.rect.w, view.frame?.box.w, stage.warnings.length])
  stage.changes.subscribe('lifecycle', read)
  sprite.changes.subscribe('geometry', read)
  view.changes.subscribe('geometry', read)
  await stage.replace('a', () =>
    Promise.resolve({ width: 80, height: 60, close() {} } as ImageBitmap),
  )
  expect(rows.length).toBeGreaterThanOrEqual(3)
  expect(rows.at(-1)).toEqual([80, 80, 1])
  for (const row of rows.filter((row) => (row as unknown[])[2] === 1))
    expect(row).toEqual([80, 80, 1])
  stage.dispose()
})

it('raw disposal delivers terminal, fully detached getters once', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  if (sprite instanceof Error || isAborted(sprite)) return expect.fail('add refused')
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (view instanceof Error) return expect.fail('view refused')
  view.show(sprite)
  const observed: unknown[] = []
  const read = () =>
    observed.push([
      stage.disposed,
      stage.views.length,
      view.state,
      view.sprite,
      sprite.attachCount,
      sprite.resident,
    ])
  stage.changes.subscribe('lifecycle', read)
  view.changes.subscribe('lifecycle', read)
  sprite.changes.subscribe('resources', read)
  stage.dispose()
  expect(observed.length).toBeGreaterThanOrEqual(3)
  for (const row of observed) expect(row).toEqual([true, 0, 'disposed', null, 0, false])
  const count = observed.length
  stage.dispose()
  expect(observed).toHaveLength(count)
})

it('pinning emits accepted resource state and detached removal is atomic for every entity', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  const pins: boolean[] = []
  const off = sprite.changes.subscribe('resources', () => pins.push(sprite.pinned))
  stage.pin('a')
  stage.pin('a')
  stage.unpin('a')
  expect(pins).toEqual([true, false])
  off()
  view.show(sprite)
  const seen: unknown[] = []
  const read = () =>
    seen.push([stage.get('a'), view.sprite, view.state, sprite.resident, sprite.attachCount])
  sprite.changes.subscribe('resources', read)
  view.changes.subscribe('lifecycle', read)
  stage.changes.subscribe('resources', read)
  stage.remove('a', { detach: true })
  expect(seen.length).toBeGreaterThanOrEqual(3)
  for (const row of seen) expect(row).toEqual([undefined, null, 'disposed', false, 0])
  stage.dispose()
})

it('replacement publishes the released front while pending and removal when replacement fails', async () => {
  const stage = await makeReactiveStage()
  const sprite = await stage.add('/a.png', { key: 'a' })
  const view = stage.view({ canvas: makeReactiveCanvas() })
  if (sprite instanceof Error || isAborted(sprite) || view instanceof Error)
    return expect.fail('setup refused')
  view.show(sprite)
  const seen: unknown[] = []
  const read = () => seen.push([sprite.resident, view.frame, stage.get('a') === sprite])
  sprite.changes.subscribe('resources', read)
  let reject: (reason: Error) => void = () => {}
  const replacement = stage.replace(
    'a',
    () =>
      new Promise((_resolve, refuse) => {
        reject = refuse
      }),
  )
  expect(seen).toEqual([[false, null, true]])
  reject(new Error('source failed'))
  expect(await replacement).toBeInstanceOf(Error)
  expect(seen.at(-1)).toEqual([false, null, false])
  stage.dispose()
})

it('raw resize observes dimensions with stable surface identity and ignores no-ops', async () => {
  const stage = await makeReactiveStage()
  const surface = stage.surface
  const seen: number[] = []
  stage.changes.subscribe('resources', () => seen.push(stage.surface.width))
  expect(stage.resize(192, 128)).toBeUndefined()
  expect(stage.surface).toBe(surface)
  expect(seen).toEqual([192])
  stage.resize(192, 128)
  stage.resize(-1, 128)
  expect(seen).toEqual([192])
  stage.dispose()
})
