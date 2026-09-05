import { beforeEach, describe, expect, it } from 'vitest'
import { ABORTED, isAborted, type Aborted } from './abort.js'
import {
  createIngestLane,
  INGEST_BUDGET_MS,
  INGEST_EXPIRY_MS,
  type IngestClass,
  type IngestJob,
  type IngestLane,
  type IngestSlot,
} from './ingest-lane.js'
import { createFakeTimers, type FakeTimers } from './testing/fake-timers.js'

let timers: FakeTimers
let lane: IngestLane
let log: string[]

beforeEach(() => {
  timers = createFakeTimers()
  lane = createIngestLane({ timers })
  log = []
})

/** A real macrotask boundary, so every microtask the lane queued has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A gate: `source()`'s suspension, under the test's control. */
function deferred(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/**
 * A job of `phases` phases: pushes `${key}:${i}` then awaits `slot.checkpoint()` between them,
 * then `${key}:end`. Re-reads `slot.signal.aborted` after every checkpoint, exactly as the stage's
 * ingest does, and answers `ABORTED` from there. `gate` suspends the first phase, so a job can be
 * held running while others queue behind it.
 */
function job(
  key: string,
  cls: IngestClass,
  phases: number,
  o: { gate?: Promise<void>; signal?: AbortSignal; discard?: () => void } = {},
): IngestJob<string> {
  return {
    key,
    cls,
    ...(o.signal === undefined ? {} : { signal: o.signal }),
    ...(o.discard === undefined ? {} : { discard: o.discard }),
    async run(slot: IngestSlot): Promise<string | Aborted> {
      for (let i = 0; i < phases; i += 1) {
        log.push(`${key}:${String(i)}`)
        if (i === 0 && o.gate !== undefined) await o.gate
        await slot.checkpoint()
        if (slot.signal.aborted) {
          log.push(`${key}:aborted`)
          return ABORTED
        }
      }
      log.push(`${key}:end`)
      return key
    },
  }
}

describe('the ingest lane (spec §8.10)', () => {
  it('single occupancy: no job starts before the previous one settled', async () => {
    const a = lane.enqueue(job('a', 'background', 3))
    const b = lane.enqueue(job('b', 'background', 3))
    expect(await Promise.all([a.done, b.done])).toEqual(['a', 'b'])
    expect(log).toEqual(['a:0', 'a:1', 'a:2', 'a:end', 'b:0', 'b:1', 'b:2', 'b:end'])
  })

  it('the first job after idle starts synchronously inside enqueue; a queued one does not', () => {
    lane.enqueue(job('a', 'background', 1))
    expect(log).toEqual(['a:0'])
    expect(lane.active).toBe('a')
    lane.enqueue(job('b', 'background', 1))
    expect(log).toEqual(['a:0'])
    expect(lane.size).toBe(1)
  })

  it('ordering: held before visible before background, FIFO within a class', async () => {
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const b = lane.enqueue(job('b', 'background', 1))
    const c = lane.enqueue(job('c', 'visible', 1))
    const d = lane.enqueue(job('d', 'held', 1))
    const e = lane.enqueue(job('e', 'visible', 1))
    expect(lane.size).toBe(4)
    gate.open()
    await Promise.all([a.done, b.done, c.done, d.done, e.done])
    expect(log.filter((l) => l.endsWith(':end'))).toEqual([
      'a:end',
      'd:end',
      'c:end',
      'e:end',
      'b:end',
    ])
    expect(lane.active).toBeNull()
    expect(lane.size).toBe(0)
  })

  it('promotion: promote(key, "held") on a queued key, and on a key enqueued afterwards', async () => {
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const b = lane.enqueue(job('b', 'background', 1))
    const c = lane.enqueue(job('c', 'background', 1))
    lane.promote('c', 'held')
    // `d` has no job yet: the lane remembers the class for its next enqueue.
    lane.promote('d', 'held')
    const d = lane.enqueue(job('d', 'background', 1))
    gate.open()
    await Promise.all([a.done, b.done, c.done, d.done])
    expect(log.filter((l) => l.endsWith(':end'))).toEqual(['a:end', 'c:end', 'd:end', 'b:end'])
  })

  it('promotion memory clears at settle: the next job under the same key starts from its own class', async () => {
    lane.promote('x', 'held')
    const first = lane.enqueue(job('x', 'background', 1))
    await first.done
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const v = lane.enqueue(job('v', 'visible', 1))
    const x = lane.enqueue(job('x', 'background', 1))
    gate.open()
    await Promise.all([a.done, v.done, x.done])
    expect(log.filter((l) => l.endsWith(':end'))).toEqual(['x:end', 'a:end', 'v:end', 'x:end'])
  })

  it('forget(key) drops a remembered class whose job never arrives', async () => {
    lane.promote('x', 'held')
    lane.forget('x')
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const v = lane.enqueue(job('v', 'visible', 1))
    const x = lane.enqueue(job('x', 'background', 1))
    gate.open()
    await Promise.all([a.done, v.done, x.done])
    expect(log.filter((l) => l.endsWith(':end'))).toEqual(['a:end', 'v:end', 'x:end'])
  })

  it('promotion never lowers a class', async () => {
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const b = lane.enqueue(job('b', 'visible', 1))
    const c = lane.enqueue(job('c', 'held', 1))
    lane.promote('c', 'background')
    lane.promote('c', 'visible')
    gate.open()
    await Promise.all([a.done, b.done, c.done])
    expect(log.filter((l) => l.endsWith(':end'))).toEqual(['a:end', 'c:end', 'b:end'])
  })

  it('expiry: a background job queued for INGEST_EXPIRY_MS sorts as visible', async () => {
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const b = lane.enqueue(job('b', 'background', 1))
    timers.freeze(INGEST_EXPIRY_MS)
    const c = lane.enqueue(job('c', 'visible', 1))
    // Still below `held`: an aged background job never outranks a target a run is parked on.
    const d = lane.enqueue(job('d', 'held', 1))
    gate.open()
    await Promise.all([a.done, b.done, c.done, d.done])
    expect(log.filter((l) => l.endsWith(':end'))).toEqual(['a:end', 'd:end', 'b:end', 'c:end'])
  })

  it('budget: a checkpoint yields only once the turn spent INGEST_BUDGET_MS', async () => {
    // A frozen clock: three phases, no yield.
    const idle = lane.enqueue(job('a', 'background', 3))
    await idle.done
    expect(timers.yields).toBe(0)

    // The clock moves INGEST_BUDGET_MS inside one phase: exactly one yield, at that checkpoint.
    const busy = lane.enqueue({
      key: 'b',
      cls: 'background',
      async run(slot) {
        await slot.checkpoint()
        timers.freeze(INGEST_BUDGET_MS)
        await slot.checkpoint()
        await slot.checkpoint()
        return 'b'
      },
    })
    expect(await busy.done).toBe('b')
    expect(timers.yields).toBe(1)
  })

  it('budget: the turn is measured from the last yield, and from the start when the lane leaves idle', async () => {
    const first = lane.enqueue({
      key: 'a',
      cls: 'background',
      async run(slot) {
        timers.freeze(INGEST_BUDGET_MS)
        await slot.checkpoint() // yield 1; turnStart reset
        timers.freeze(INGEST_BUDGET_MS - 1)
        await slot.checkpoint() // under budget since the yield
        timers.freeze(1)
        await slot.checkpoint() // yield 2
        return 'a'
      },
    })
    await first.done
    expect(timers.yields).toBe(2)
    // Idle in between, the clock long past any budget: a fresh turn starts at zero.
    timers.freeze(1000)
    const second = lane.enqueue({
      key: 'b',
      cls: 'background',
      async run(slot) {
        await slot.checkpoint()
        return 'b'
      },
    })
    await second.done
    expect(timers.yields).toBe(2)
  })

  it('budget: a spent turn yields before the next job starts, rather than stacking two jobs in one task', async () => {
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const b = lane.enqueue(job('b', 'background', 1))
    timers.freeze(INGEST_BUDGET_MS)
    gate.open()
    await Promise.all([a.done, b.done])
    // `a`'s own checkpoint yielded (the clock had moved) and reset the turn; `b` then started on
    // a fresh budget with no second yield.
    expect(timers.yields).toBe(1)
    // Now the same with the clock moving AFTER `c`'s last checkpoint: the lane yields before `d`.
    const gate2 = deferred()
    const c = lane.enqueue({
      key: 'c',
      cls: 'background',
      async run(slot) {
        await gate2.promise
        await slot.checkpoint()
        timers.freeze(INGEST_BUDGET_MS)
        return 'c'
      },
    })
    const d = lane.enqueue(job('d', 'background', 1))
    gate2.open()
    await Promise.all([c.done, d.done])
    expect(timers.yields).toBe(2)
    expect(log.filter((l) => l.endsWith(':end'))).toEqual(['a:end', 'b:end', 'd:end'])
  })

  it('cancellation: a queued job whose signal fires is discarded once and settles ABORTED without running', async () => {
    const gate = deferred()
    const a = lane.enqueue(job('a', 'background', 1, { gate: gate.promise }))
    const controller = new AbortController()
    let discards = 0
    const b = lane.enqueue(
      job('b', 'held', 1, {
        signal: controller.signal,
        discard: () => {
          discards += 1
        },
      }),
    )
    controller.abort()
    expect(discards).toBe(1)
    expect(lane.size).toBe(0)
    expect(isAborted(await b.done)).toBe(true)
    gate.open()
    expect(await a.done).toBe('a')
    expect(log).toEqual(['a:0', 'a:end'])
  })

  it('cancellation: a signal already aborted at enqueue discards immediately', async () => {
    const controller = new AbortController()
    controller.abort()
    let discards = 0
    const t = lane.enqueue(
      job('b', 'held', 1, {
        signal: controller.signal,
        discard: () => {
          discards += 1
        },
      }),
    )
    expect(discards).toBe(1)
    expect(isAborted(await t.done)).toBe(true)
    expect(log).toEqual([])
  })

  it("cancellation: the running job's slot.signal fires with its own signal, and it settles at its next checkpoint", async () => {
    const gate = deferred()
    const controller = new AbortController()
    let discards = 0
    const a = lane.enqueue(
      job('a', 'background', 3, {
        gate: gate.promise,
        signal: controller.signal,
        discard: () => {
          discards += 1
        },
      }),
    )
    const b = lane.enqueue(job('b', 'background', 1))
    controller.abort()
    // Running, not queued: no discard — the job owns its resources until it settles.
    expect(discards).toBe(0)
    gate.open()
    expect(isAborted(await a.done)).toBe(true)
    expect(await b.done).toBe('b')
    expect(log).toEqual(['a:0', 'a:aborted', 'b:0', 'b:end'])
  })

  it('termination: dispose settles every queued job ABORTED, discards each exactly once, aborts the running one at its next checkpoint, and later enqueues settle ABORTED', async () => {
    const gate = deferred()
    const discards: string[] = []
    const a = lane.enqueue(job('a', 'background', 3, { gate: gate.promise }))
    const b = lane.enqueue(job('b', 'visible', 1, { discard: () => discards.push('b') }))
    const c = lane.enqueue(job('c', 'held', 1, { discard: () => discards.push('c') }))
    lane.dispose()
    lane.dispose()
    expect(discards).toEqual(['b', 'c'])
    expect(lane.size).toBe(0)
    expect(isAborted(await b.done)).toBe(true)
    expect(isAborted(await c.done)).toBe(true)
    expect(lane.active).toBe('a')
    gate.open()
    expect(isAborted(await a.done)).toBe(true)
    expect(lane.active).toBeNull()
    const d = lane.enqueue(job('d', 'held', 1, { discard: () => discards.push('d') }))
    expect(discards).toEqual(['b', 'c', 'd'])
    expect(isAborted(await d.done)).toBe(true)
    await flush()
    expect(log).toEqual(['a:0', 'a:aborted'])
  })

  it('a job that returns an Error settles to that Error and the next job still runs', async () => {
    const failure = new Error('sheet refused')
    const a = lane.enqueue<string | Error>({
      key: 'a',
      cls: 'background',
      run: async () => failure,
    })
    const b = lane.enqueue(job('b', 'background', 1))
    expect(await a.done).toBe(failure)
    expect(await b.done).toBe('b')
  })

  it('a job whose run rejects — impossible under §10.8, guarded anyway — settles to an Error and the next job still runs', async () => {
    const a = lane.enqueue<string | Error>({
      key: 'a',
      cls: 'background',
      run: () => Promise.reject(new Error('threw')),
    })
    const b = lane.enqueue(job('b', 'background', 1))
    const settled = await a.done
    expect(settled).toBeInstanceOf(Error)
    expect((settled as Error).message).toBe('threw')
    expect(await b.done).toBe('b')
  })

  it('the ticket carries the key', () => {
    expect(lane.enqueue(job('k', 'background', 1)).key).toBe('k')
  })

  it('the budget and expiry constants are what §8.10 states', () => {
    expect(INGEST_BUDGET_MS).toBe(4)
    expect(INGEST_EXPIRY_MS).toBe(1000)
  })
})
