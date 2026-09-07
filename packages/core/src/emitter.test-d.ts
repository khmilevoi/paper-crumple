import { expectTypeOf, test } from 'vitest'
import { createEventBus, type EventBus } from './emitter.js'
import type { Events } from './events.js'

test('on returns an unsubscribe closure, never an Error union (§7.1)', () => {
  expectTypeOf<EventBus<Events>['on']>().returns.toEqualTypeOf<() => void>()
  expectTypeOf<EventBus<Events>['once']>().returns.toEqualTypeOf<() => void>()
})

test('a handler is typed by the event it is registered for', () => {
  const bus = createEventBus()
  bus.on('step', (e) => {
    expectTypeOf(e).toEqualTypeOf<Events['step']>()
    expectTypeOf(e.pose).toEqualTypeOf<number>()
  })
  bus.on('lost', (e) => {
    expectTypeOf(e).toEqualTypeOf<Events['lost']>()
  })
})

test('emit refuses a payload from the wrong event', () => {
  const bus = createEventBus()
  // @ts-expect-error — an `end` payload is not a `start` payload.
  bus.emit('start', { from: 0, to: 5, completed: true })
})

test('an unknown event name does not exist', () => {
  const bus = createEventBus()
  // @ts-expect-error — 'finished' is not in the Events map.
  bus.on('finished', () => {})
})
