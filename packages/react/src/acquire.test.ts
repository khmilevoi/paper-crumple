import { makeFakeSprite } from './testing/fake-stage.js'
/**
 * @vitest-environment jsdom
 */
import { ABORTED, SheetError } from '@paper-crumple/core'
import type { Sprite } from '@paper-crumple/core'
import { expect, test } from 'vitest'
import { acquire, pendingAcquisition, stageSignal } from './acquire.js'
import { createFakeStage } from './testing/fake-stage.js'
import { deferred } from './testing/deferred.js'

const never = new AbortController().signal

/** The core's own refusal, verbatim from `stage.ts:1798-1806`. */
function liveKeyRefusal(key: string): InstanceType<typeof SheetError> {
  return new SheetError(
    `add() was called with the live key '${key}'. Re-pointing a key is refused rather ` +
      'than silently rebuilt: the hull cache is keyed on (sprite key, sdfRes, hull knobs) ' +
      'and the bitmap is not in that key, so the new sprite would inherit the old hull. ' +
      'Use replace() to re-point a key, or remove() first.',
  )
}

test('an absent key goes through add, not prepare (clause 3)', async () => {
  const fake = createFakeStage()
  const got = await acquire(fake.stage, 'hero', 'hero.png', undefined, never)
  expect(got).not.toBeInstanceOf(Error)
  expect(fake.calls.map((c) => c.method)).toEqual(['get', 'add'])
})

test('a resident key goes through prepare, not the resident sprite (clause 2)', async () => {
  const fake = createFakeStage({ sprites: ['hero'] })
  const got = await acquire(fake.stage, 'hero', 'hero.png', undefined, never)
  expect((got as Sprite).key).toBe('hero')
  expect(fake.calls.map((c) => c.method)).toEqual(['get', 'prepare'])
})

test('two acquisitions of one key in flight together produce exactly one add (clause 1)', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ add: () => gate.promise })
  const first = acquire(fake.stage, 'hero', 'hero.png', undefined, never)
  const second = acquire(fake.stage, 'hero', 'hero.png', undefined, never)
  gate.resolve(makeFakeSprite('hero'))
  expect(await first).toBe(await second)
  expect(fake.calls.filter((c) => c.method === 'add')).toHaveLength(1)
})

test('the in-flight entry is readable while it is open and gone once it settles', async () => {
  const gate = deferred<Sprite>()
  const fake = createFakeStage({ add: () => gate.promise })
  const inFlight = acquire(fake.stage, 'hero', 'hero.png', undefined, never)
  expect(pendingAcquisition(fake.stage, 'hero')).toBeDefined()
  gate.resolve(makeFakeSprite('hero'))
  await inFlight
  expect(pendingAcquisition(fake.stage, 'hero')).toBeUndefined()
})

test('the shared work runs under the stage signal, not the first caller (clause 4)', async () => {
  const fake = createFakeStage()
  await acquire(fake.stage, 'hero', 'hero.png', undefined, never)
  const add = fake.calls.find((c) => c.method === 'add')
  expect((add?.args[1] as { signal?: AbortSignal }).signal).toBe(stageSignal(fake.stage))
})

test('a joiner that has itself unmounted converts the settled value to ABORTED (clause 4)', async () => {
  const fake = createFakeStage()
  const mine = new AbortController()
  const pending = acquire(fake.stage, 'hero', 'hero.png', undefined, mine.signal)
  mine.abort()
  expect(await pending).toBe(ABORTED)
})

test('a live-key SheetError is retried exactly once through prepare (clause 5)', async () => {
  const sprite = makeFakeSprite('hero')
  const fake = createFakeStage({
    add: async () => liveKeyRefusal('hero'),
    prepare: async () => sprite,
  })
  const got = await acquire(fake.stage, 'hero', 'hero.png', undefined, never)
  expect(got).toBe(sprite)
  expect(fake.calls.map((c) => c.method)).toEqual(['get', 'add', 'prepare'])
})

test('a SheetError that is not the live-key refusal is returned as it is', async () => {
  const other = new SheetError('the source decoded to a zero-area bitmap')
  const fake = createFakeStage({ add: async () => other })
  expect(await acquire(fake.stage, 'hero', 'hero.png', undefined, never)).toBe(other)
  expect(fake.calls.filter((c) => c.method === 'prepare')).toHaveLength(0)
})

test('pin is forwarded to add, and omitted when it was not given', async () => {
  const fake = createFakeStage()
  const bitmap = {} as ImageBitmap
  await acquire(fake.stage, 'pinned', bitmap, true, never)
  const add = fake.calls.find((c) => c.method === 'add')
  expect((add?.args[1] as { pin?: true }).pin).toBe(true)

  fake.calls.length = 0
  await acquire(fake.stage, 'unpinned', bitmap, undefined, never)
  const addUnpinned = fake.calls.find((c) => c.method === 'add')
  expect('pin' in ((addUnpinned?.args[1] ?? {}) as object)).toBe(false)
})

test('two stages keep separate registries', () => {
  const a = createFakeStage()
  const b = createFakeStage()
  expect(stageSignal(a.stage)).not.toBe(stageSignal(b.stage))
})

test('when prepare returns "has no sprite" error, the original live-key refusal is returned (clause 5)', async () => {
  const key = 'hero'
  const liveKeyError = liveKeyRefusal(key)
  const noSpriteError = new SheetError(
    `prepare('${key}') has no sprite under that key; add() it first`,
  )
  const fake = createFakeStage({
    add: async () => liveKeyError,
    prepare: async () => noSpriteError,
  })
  const got = await acquire(fake.stage, key, 'hero.png', undefined, never)
  expect(got).toBe(liveKeyError)
  expect(fake.calls.map((c) => c.method)).toEqual(['get', 'add', 'prepare'])
})
