import { expect, it, vi } from 'vitest'
import { ABORTED, isAborted } from '../index.js'
import type { StageEvent } from '../index.js'
import { createStage } from '../stage.js'
import { fakeSheet, fakeMotion, stageEnv } from '../testing/fake-slots.js'
import { makeReactiveStage } from '../testing/reactive-stage.js'
import { createSceneController } from './scene.js'

it('ensure shares its exact pending promise and publishes each lifecycle transition once', async () => {
  const stage = await makeReactiveStage()
  let land!: (value: typeof stage) => void
  const result = new Promise<typeof stage>((resolve) => {
    land = resolve
  })
  const create = vi.fn(() => result)
  const scene = createSceneController(create)
  const states: string[] = []
  scene.subscribe(() => states.push(scene.status))
  const a = scene.ensure()
  const b = scene.ensure()
  expect(a).toBe(b)
  land(stage)
  expect(await a).toBe(stage)
  expect(await scene.ensure()).toBe(stage)
  expect(create).toHaveBeenCalledTimes(1)
  scene.dispose()
  scene.dispose()
  expect(states).toEqual(['building', 'ready', 'disposed'])
  expect(stage.disposed).toBe(true)
  expect(scene.stage).toBe(null)
})

it('disposal cleans a late stage even when its factory ignored the abort signal', async () => {
  const stage = await makeReactiveStage()
  let land!: (value: typeof stage) => void
  const result = new Promise<typeof stage>((resolve) => {
    land = resolve
  })
  const scene = createSceneController(() => result)
  const pending = scene.ensure()
  scene.dispose()
  expect(scene.signal.aborted).toBe(true)
  land(stage)
  expect(await pending).toBe(ABORTED)
  expect(stage.disposed).toBe(true)
  expect(scene.stage).toBe(null)
  expect(await scene.ensure()).toBe(ABORTED)
})

it('direct raw stage disposal clears the live reference and makes ensure terminal', async () => {
  const stage = await makeReactiveStage()
  const create = vi.fn(async () => stage)
  const scene = createSceneController(create)
  await scene.ensure()
  const states: string[] = []
  scene.subscribe(() => states.push(scene.status))
  stage.dispose()
  expect(scene.status).toBe('disposed')
  expect(scene.stage).toBe(null)
  expect(scene.signal.aborted).toBe(true)
  expect(await scene.ensure()).toBe(ABORTED)
  expect(create).toHaveBeenCalledTimes(1)
  scene.dispose()
  expect(states).toEqual(['disposed'])
})

it('a factory returning an already disposed stage cannot publish readiness', async () => {
  const stage = await makeReactiveStage()
  stage.dispose()
  const scene = createSceneController(async () => stage)
  expect(await scene.ensure()).toBe(ABORTED)
  expect(scene.status).toBe('disposed')
  expect(scene.stage).toBe(null)
})

it('context loss exposes the actual error, invalidates ensure, and retains owner cleanup', async () => {
  let lose = () => {}
  const stage = await createStage(
    { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384, present: 'blit' },
    stageEnv({
      onContextLost: (fn) => {
        lose = fn
        return () => {}
      },
    }),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage setup refused')
  const create = vi.fn(async () => stage)
  const scene = createSceneController(create)
  const errors: StageEvent<'error'>[] = []
  scene.onError((event) => errors.push(event))
  await scene.ensure()
  const states: string[] = []
  scene.subscribe(() => states.push(scene.status))
  lose()
  lose()
  expect(scene.stage).toBe(null)
  expect(scene.status).toBe('failed')
  expect(scene.lost).toBe(true)
  expect(scene.error).toBe(errors[0]?.error)
  expect(await scene.ensure()).toBe(scene.error)
  expect(create).toHaveBeenCalledTimes(1)
  expect(states).toEqual(['failed'])
  expect(errors).toHaveLength(1)
  const originalCause = scene.error
  stage.set({ paperColor: '#ffffff' })
  expect(scene.error).toBe(originalCause)
  expect(states).toEqual(['failed'])
  scene.dispose()
  expect(stage.disposed).toBe(true)
})

it.each(['return', 'reject'] as const)(
  'factory %s Error is a terminal value, not a rejection',
  async (mode) => {
    const error = new Error('factory failed')
    const create = vi.fn(() => (mode === 'return' ? Promise.resolve(error) : Promise.reject(error)))
    const scene = createSceneController(create)
    expect(await scene.ensure()).toBe(error)
    expect(scene.status).toBe('failed')
    expect(scene.error).toBe(error)
    expect(await scene.ensure()).toBe(error)
    expect(create).toHaveBeenCalledTimes(1)
    scene.dispose()
  },
)

it('factory ABORTED settles terminally without inventing an Error', async () => {
  const create = vi.fn(async (): Promise<typeof ABORTED> => ABORTED)
  const scene = createSceneController(create)
  expect(await scene.ensure()).toBe(ABORTED)
  expect(scene.error).toBe(null)
  expect(scene.status).toBe('disposed')
  expect(await scene.ensure()).toBe(ABORTED)
  expect(create).toHaveBeenCalledTimes(1)
})

it('factory error forwarding ends at landing, and disposal releases raw listeners', async () => {
  const stage = await makeReactiveStage()
  let preMount!: (event: StageEvent<'error'>) => void
  const scene = createSceneController(async (_signal, onError) => {
    preMount = onError
    return stage
  })
  const heard = vi.fn()
  scene.onError(heard)
  const pending = scene.ensure()
  await Promise.resolve()
  const event = { error: new Error('warning'), observed: false, view: null }
  preMount(event)
  await pending
  expect(heard).toHaveBeenCalledTimes(1)
  preMount(event)
  expect(heard).toHaveBeenCalledTimes(1)
  scene.dispose()
  preMount(event)
  expect(heard).toHaveBeenCalledTimes(1)
})
