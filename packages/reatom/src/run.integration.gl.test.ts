import { ABORTED } from '@paper-crumple/core'
import { clearStack, context, isAbort } from '@reatom/core'
import { expect, it } from 'vitest'
import { createPublicCoreRun } from './core-run.fixture.js'
import { reatomRun } from './run.js'

it('wraps a live Run produced through the public core stage API', async () => {
  const fixture = await createPublicCoreRun()
  if (fixture instanceof Error) return expect.fail(fixture.message)
  const owner = context.start()
  try {
    const model = owner.run(() => reatomRun(fixture.raw, 'run.publicCore'))

    expect(model.raw).toBe(fixture.raw)
    expect(fixture.view.run).toBe(fixture.raw)
    expect(owner.run(model.completion.pending)).toBe(1)

    owner.run(model.stop)

    expect(fixture.ends).toEqual([false])
    expect(fixture.view.run).toBeNull()
    expect(fixture.view.state).toBe('idle')
    const [rawResult, completionResult] = await Promise.all([
      fixture.raw.done,
      Promise.allSettled([model.completion.done]),
    ])
    expect(rawResult).toBe(ABORTED)
    expect(completionResult[0]?.status).toBe('rejected')
    if (completionResult[0]?.status === 'rejected') {
      expect(isAbort(completionResult[0].reason)).toBe(true)
    }
    expect(owner.run(model.completion.data)).toBeNull()
    expect(owner.run(model.completion.error)).toBeUndefined()
    expect(owner.run(model.completion.pending)).toBe(0)
    expect(owner.run(model.completion.ready)).toBe(true)
  } finally {
    fixture.dispose()
    owner.run(context.reset)
    clearStack()
  }
})
