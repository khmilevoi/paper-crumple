import { afterEach, expect, it, vi } from 'vitest'
import { createChanges, createChangeBatch } from './changes.js'

it('unobserved terminal publishers never register delivery or cleanup with the coordinator', () => {
  const group = createChangeBatch()
  const changes = createChanges(group)
  const schedule = vi.spyOn(group, 'schedule')
  const cleanup = vi.spyOn(group, 'after')
  const off = changes.subscribe('settings', () => {})
  off()
  const iterate = vi.spyOn(Set.prototype, Symbol.iterator)
  group.batch(() => {
    changes.emit('lifecycle')
    changes.clearAfterBatch()
  })
  const scans = iterate.mock.calls.length
  iterate.mockRestore()
  expect(scans).toBe(0)
  expect(changes.revision('lifecycle')).toBe(1)
  expect(schedule).not.toHaveBeenCalled()
  expect(cleanup).not.toHaveBeenCalled()
})

it('observed terminal publishers deliver before clearing every remaining subscriber', () => {
  const group = createChangeBatch()
  const changes = createChanges(group)
  const seen: string[] = []
  changes.subscribe('lifecycle', () => seen.push('terminal'))
  changes.subscribe('settings', () => seen.push('settings'))
  group.batch(() => {
    changes.emit('lifecycle')
    changes.clearAfterBatch()
    expect(seen).toEqual([])
  })
  expect(seen).toEqual(['terminal'])
  changes.emit('settings')
  expect(seen).toEqual(['terminal'])
})

it('defers only observed publishers across a shared atomic boundary', () => {
  const group = createChangeBatch()
  const a = createChanges(group)
  const b = createChanges(group)
  const reads: number[] = []
  let value = 0
  a.subscribe('content', () => reads.push(value))
  b.subscribe('resources', () => reads.push(value))
  group.batch(() => {
    a.emit('content')
    b.emit('resources')
    expect(a.revision('content')).toBe(1)
    expect(reads).toEqual([])
    value = 2
  })
  expect(reads).toEqual([2, 2])
})

it('shared delivery handles reentrant batches and clearing another pending publisher', () => {
  const group = createChangeBatch()
  const a = createChanges(group)
  const b = createChanges(group)
  const seen: string[] = []
  a.subscribe('content', () => {
    seen.push('a')
    b.clear()
    group.batch(() => b.emit('resources'))
  })
  b.subscribe('resources', () => seen.push('b'))
  group.batch(() => {
    a.emit('content')
    b.emit('resources')
  })
  expect(seen).toEqual(['a'])
  expect(b.revision('resources')).toBe(2)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it('coalesces one area within an operation and keeps readers consistent', () => {
  const changes = createChanges()
  const reads: number[] = []
  let value = 0
  const off = changes.subscribe('content', () => reads.push(value))
  changes.batch(() => {
    value = 1
    changes.emit('content')
    value = 2
    changes.emit('content')
  })
  expect(reads).toEqual([2])
  off()
  changes.emit('content')
  expect(reads).toEqual([2])
})

it('clear removes the remaining listeners from an in-flight delivery', () => {
  const changes = createChanges()
  const seen: string[] = []
  changes.subscribe('content', () => {
    seen.push('first')
    changes.clear()
  })
  changes.subscribe('content', () => seen.push('second'))

  changes.emit('content')
  changes.emit('content')

  expect(seen).toEqual(['first'])
})

it('batches nested operations and increments revisions for every semantic emit', () => {
  const changes = createChanges()
  const seen: string[] = []
  changes.subscribe('content', () => seen.push(`content:${changes.revision('content')}`))
  changes.subscribe('state', () => seen.push(`state:${changes.revision('state')}`))

  changes.batch(() => {
    changes.emit('content')
    changes.batch(() => {
      changes.emit('content')
      changes.emit('state')
    })
    changes.emit('state')
  })

  expect(seen).toEqual(['content:2', 'state:2'])
  expect(changes.revision('content')).toBe(2)
  expect(changes.revision('state')).toBe(2)
})

it('delivers a reentrant different-area emit after the current listener returns', () => {
  const changes = createChanges()
  const seen: string[] = []
  changes.subscribe('content', () => {
    seen.push('content:first')
    changes.emit('geometry')
  })
  changes.subscribe('content', () => seen.push('content:second'))
  changes.subscribe('geometry', () => seen.push('geometry'))

  changes.emit('content')

  expect(seen).toEqual(['content:first', 'geometry', 'content:second'])
})

it('does not deliver to a listener unsubscribed earlier in the same notification', () => {
  const changes = createChanges()
  const seen: string[] = []
  let offSecond = (): void => {}
  changes.subscribe('content', () => {
    seen.push('first')
    offSecond()
  })
  offSecond = changes.subscribe('content', () => seen.push('second'))

  changes.emit('content')

  expect(seen).toEqual(['first'])
})

it('keeps terminal revisions after clear and makes unsubscribe idempotent', () => {
  const changes = createChanges()
  const listener = vi.fn()
  const off = changes.subscribe('content', listener)
  changes.emit('content')
  changes.clear()
  off()
  off()
  changes.emit('content')

  expect(listener).toHaveBeenCalledTimes(1)
  expect(changes.revision('content')).toBe(2)
})

it('does not allocate listener storage when emitting without subscribers', () => {
  let constructions = 0
  const OriginalSet = Set
  class TrackingSet<T> extends OriginalSet<T> {
    constructor() {
      super()
      constructions += 1
    }
  }
  vi.stubGlobal('Set', TrackingSet)

  const changes = createChanges()
  changes.emit('content')

  expect(constructions).toBe(0)
  expect(changes.revision('content')).toBe(1)
})

it('keeps notifying after a listener throws and schedules the existing rethrow policy', () => {
  const scheduled: Array<() => void> = []
  vi.stubGlobal('queueMicrotask', (fn: () => void) => scheduled.push(fn))
  const changes = createChanges()
  const after = vi.fn()
  changes.subscribe('content', () => {
    JSON.parse('{') as never
  })
  changes.subscribe('content', after)

  expect(() => changes.emit('content')).not.toThrow()
  expect(after).toHaveBeenCalledTimes(1)
  expect(scheduled).toHaveLength(1)
  expect(() => scheduled[0]()).toThrow(SyntaxError)
})

it('flushes a pending batch in finally while preserving an operation exception', () => {
  const changes = createChanges()
  const delivered = vi.fn()
  changes.subscribe('content', delivered)

  expect(() =>
    changes.batch(() => {
      changes.emit('content')
      JSON.parse('{') as never
    }),
  ).toThrow(SyntaxError)
  expect(delivered).toHaveBeenCalledTimes(1)
})

it('does not deliver a later pending area after clear and resubscription', () => {
  const changes = createChanges()
  const seen: string[] = []
  changes.subscribe('content', () => {
    seen.push('content')
    changes.clear()
    changes.subscribe('state', () => seen.push('state-new'))
  })
  changes.subscribe('state', () => seen.push('state-old'))

  changes.batch(() => {
    changes.emit('content')
    changes.emit('state')
  })

  expect(seen).toEqual(['content'])
})
