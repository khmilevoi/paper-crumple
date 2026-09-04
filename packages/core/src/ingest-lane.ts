import { ABORTED, type Aborted } from './abort.js'
import type { Timers } from './stepper.js'

/**
 * # The ingest lane (spec §8.10)
 *
 * One stage-wide, prioritised, cancellable queue through which every asynchronous sprite path
 * runs — `add()`, `replace()`, `prepare()`'s re-source and §8.5's re-load row. **At most one job
 * runs at a time**, because Pool A holds one artwork slot and one tight-field slot (§8.1): two
 * `source()` calls interleaved at a microtask checkpoint displace each other's artwork and clobber
 * each other's field before either reads it back, and the first caller's `build()` then answers
 * `SourceExpiredError`. The lane makes that single-occupancy invariant explicit instead of
 * leaving it to task boundaries.
 *
 * **Ordering.** At each dequeue the job with the least `(rank(effective), seq)` runs: `held`
 * (a target a live `crumpleTo` is parked on, §4.5's `hold`) before `visible` (a front a shown
 * view needs) before `background`, FIFO within a class. `effective` is the job's class raised to
 * at least `visible` once it has been queued for `INGEST_EXPIRY_MS`, so a stream of promoted work
 * cannot starve a background job forever.
 *
 * **Yielding.** Between a job's phases the job calls `slot.checkpoint()`; it yields to the
 * platform scheduler (`Timers.yield`) once the current turn has spent `INGEST_BUDGET_MS` inside
 * the lane, and the lane itself takes the same checkpoint before starting the next job, so two
 * jobs' phases are not stacked into one task once the budget is gone. `turnStart` is reset after
 * every yield and when the lane starts from idle.
 *
 * **Cancellation is by signal, not by key** (§10.5). A queued job whose signal fires is discarded
 * eagerly — `discard()` once, then `ABORTED` — through an abort listener attached at enqueue and
 * removed at settle. A running job's `slot.signal` is a lane-owned signal that fires with the
 * job's own signal and with `dispose()`; the job passes it into `source()` and `load()`, whose
 * check points return `ABORTED`, and re-reads it after every checkpoint. The lane never rejects:
 * every ticket settles.
 */
export type IngestClass = 'held' | 'visible' | 'background'

/**
 * A checkpoint yields once the current turn has spent this long inside the lane. The longest
 * phase on the reference GPU (upload + pass A ≈ 5 ms) then keeps a turn under the ~8 ms §8.10
 * states. Same figure as `REBUILD_BUDGET_MS` (`rebuild-queue.ts`), for the same reason.
 */
export const INGEST_BUDGET_MS = 4

/** A job queued this long sorts as `visible` whatever its class, so a stream cannot starve it. */
export const INGEST_EXPIRY_MS = 1000

export interface IngestSlot {
  /**
   * The job's signal: the caller's, if one was given, fired ALSO by `dispose()`. Pass it into
   * `source()` / `load()`; re-read `aborted` after every checkpoint.
   */
  readonly signal: AbortSignal
  /**
   * Awaits `timers.yield()` iff `timers.now() - turnStart >= INGEST_BUDGET_MS`, then resets
   * `turnStart`; otherwise an already-resolved promise. `turnStart` is reset after every yield
   * and when the lane starts from idle; a cross-turn `await` inside a phase (the sheet's fence
   * poll) leaves it stale, costing at most one spurious yield per phase — accepted.
   */
  checkpoint(): Promise<void>
}

export interface IngestJob<T> {
  readonly key: string
  readonly cls: IngestClass
  readonly signal?: AbortSignal
  /** Runs alone: no other job's `run` starts between this one's start and its settle. */
  run(slot: IngestSlot): Promise<T | Aborted>
  /**
   * Called once, synchronously, when the job is dropped WITHOUT running — its signal fired while
   * it was queued, or the lane was disposed. Owned bitmaps are closed here (§8.5.4).
   */
  discard?(): void
}

export interface IngestTicket<T> {
  readonly done: Promise<T | Aborted>
  readonly key: string
}

export interface IngestLane {
  /**
   * Queue a job; the first job after idle starts synchronously inside this call, so a lone
   * `add()` keeps today's timing. Never rejects: a `run` that rejects — impossible under §10.8,
   * every fallible call returns its failure — settles its ticket with the reason as an `Error`
   * rather than breaking the lane.
   */
  enqueue<T>(job: IngestJob<T>): IngestTicket<T>
  /**
   * Raise, never lower, a key's class. A key with no job yet REMEMBERS the class for its next
   * enqueue (a `swapTo` promotes before the URL has finished decoding); the memory is consumed by
   * that enqueue and cleared at settle.
   */
  promote(key: string, cls: IngestClass): void
  /**
   * Drop a remembered class whose job will never arrive — the `add()` it was meant for failed
   * before it reached the lane (its `acquire` refused). A no-op for a queued or running key,
   * which holds no memory. Without it a promoted key whose decode failed would remember forever.
   */
  forget(key: string): void
  /**
   * Queued jobs settle `ABORTED` after `discard`; the running one's `slot.signal` fires and it
   * settles at its next check point; later enqueues settle `ABORTED` after `discard`. Idempotent.
   */
  dispose(): void
  /** The running job's key, or `null`. */
  readonly active: string | null
  /** Jobs queued and not yet started; the running one is not counted. */
  readonly size: number
}

const RANK: Record<IngestClass, number> = { held: 0, visible: 1, background: 2 }

function higher(a: IngestClass, b: IngestClass): IngestClass {
  return RANK[a] <= RANK[b] ? a : b
}

interface Entry {
  readonly key: string
  cls: IngestClass
  readonly queuedAt: number
  readonly job: IngestJob<unknown>
  readonly settle: (value: unknown) => void
  /** Removes the abort listener; idempotent. */
  detach: () => void
  /** The slot signal, once running. */
  controller: AbortController | null
}

/** The §10.8 guard for a `run` that rejects: the reason as an `Error`, so the ticket still settles. */
function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

export function createIngestLane(o: { timers: Timers }): IngestLane {
  const { timers } = o
  /** In enqueue order, so the array index is the FIFO tie-break within a rank. */
  const queue: Entry[] = []
  /** Classes promoted for keys that have no job yet. */
  const memory = new Map<string, IngestClass>()
  const RESOLVED = Promise.resolve()
  let active: Entry | null = null
  /** The lane's own checkpoint between two jobs is in flight: nothing starts until it lands. */
  let yielding = false
  let disposed = false
  let turnStart = 0

  function effective(e: Entry, now: number): IngestClass {
    return e.queuedAt + INGEST_EXPIRY_MS <= now ? higher(e.cls, 'visible') : e.cls
  }

  function dequeue(): Entry | null {
    const first = queue[0]
    if (first === undefined) return null
    const now = timers.now()
    let best = 0
    let bestRank = RANK[effective(first, now)]
    for (let i = 1; i < queue.length; i += 1) {
      const rank = RANK[effective(queue[i] as Entry, now)]
      // Strict: among equal ranks the earliest enqueue wins.
      if (rank < bestRank) {
        best = i
        bestRank = rank
      }
    }
    return queue.splice(best, 1)[0] ?? null
  }

  /** A queued entry dropped without running: `discard` once, then `ABORTED`. */
  function discard(e: Entry): void {
    e.detach()
    e.job.discard?.()
    e.settle(ABORTED)
  }

  function drop(e: Entry): void {
    const at = queue.indexOf(e)
    if (at < 0) return
    queue.splice(at, 1)
    discard(e)
  }

  /** The job's own signal fired: queued → discarded; running → its slot signal fires. */
  function cancel(e: Entry): void {
    if (e.controller !== null) {
      e.controller.abort(e.job.signal?.reason)
      return
    }
    drop(e)
  }

  function slotFor(controller: AbortController): IngestSlot {
    return {
      signal: controller.signal,
      checkpoint: () => {
        // An aborted job wants to bail out, not to wait for a turn it will do nothing with.
        if (controller.signal.aborted) return RESOLVED
        if (timers.now() - turnStart < INGEST_BUDGET_MS) return RESOLVED
        return timers.yield().then(() => {
          turnStart = timers.now()
        })
      },
    }
  }

  function finish(e: Entry, value: unknown): void {
    e.detach()
    active = null
    memory.delete(e.key)
    e.settle(value)
    pump()
  }

  function start(e: Entry): void {
    active = e
    const controller = new AbortController()
    e.controller = controller
    const slot = slotFor(controller)
    let running: Promise<unknown>
    try {
      running = Promise.resolve(e.job.run(slot))
    } catch (cause) {
      running = Promise.reject(asError(cause))
    }
    void running.then(
      (value) => {
        finish(e, value)
      },
      (cause: unknown) => {
        finish(e, asError(cause))
      },
    )
  }

  function pump(): void {
    if (active !== null || yielding || disposed || queue.length === 0) return
    // The lane's own checkpoint between two jobs: a spent turn yields before the next job's
    // first phase, rather than stacking it onto the previous job's last one.
    if (timers.now() - turnStart >= INGEST_BUDGET_MS) {
      yielding = true
      void timers.yield().then(() => {
        yielding = false
        turnStart = timers.now()
        pump()
      })
      return
    }
    const next = dequeue()
    if (next !== null) start(next)
  }

  function enqueue<T>(job: IngestJob<T>): IngestTicket<T> {
    let settle: (value: T | Aborted) => void = () => {}
    const done = new Promise<T | Aborted>((resolve) => {
      settle = resolve
    })
    const ticket: IngestTicket<T> = { done, key: job.key }
    const entry: Entry = {
      key: job.key,
      cls: job.cls,
      queuedAt: timers.now(),
      job: job as IngestJob<unknown>,
      settle: settle as (value: unknown) => void,
      detach: () => {},
      controller: null,
    }
    if (disposed || job.signal?.aborted === true) {
      memory.delete(job.key)
      discard(entry)
      return ticket
    }
    const remembered = memory.get(job.key)
    if (remembered !== undefined) {
      memory.delete(job.key)
      entry.cls = higher(job.cls, remembered)
    }
    if (job.signal !== undefined) {
      const signal = job.signal
      const onAbort = (): void => {
        cancel(entry)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.detach = () => {
        signal.removeEventListener('abort', onAbort)
        entry.detach = () => {}
      }
    }
    // Starting from idle: a fresh turn, whatever the clock read when the last job ended.
    if (active === null && !yielding && queue.length === 0) turnStart = timers.now()
    queue.push(entry)
    pump()
    return ticket
  }

  function promote(key: string, cls: IngestClass): void {
    let found = active?.key === key
    for (const e of queue) {
      if (e.key !== key) continue
      found = true
      e.cls = higher(e.cls, cls)
    }
    if (found) return
    const remembered = memory.get(key)
    memory.set(key, remembered === undefined ? cls : higher(remembered, cls))
  }

  function forget(key: string): void {
    memory.delete(key)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    memory.clear()
    for (const e of queue.splice(0)) discard(e)
    active?.controller?.abort()
  }

  return {
    enqueue,
    promote,
    forget,
    dispose,
    get active() {
      return active?.key ?? null
    },
    get size() {
      return queue.length
    },
  }
}
