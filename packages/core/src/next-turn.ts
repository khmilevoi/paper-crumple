/**
 * # The platform yield (spec §8.10)
 *
 * Resolves in a **later macrotask** — never a microtask. The point is a rendering and input
 * opportunity between two phases of an ingest (and, for the sheet's asynchronous readback, one
 * fence poll per turn), and a microtask checkpoint gives neither: the whole of the current task
 * still runs before the browser paints or dispatches the click.
 *
 * Three routes, in order of preference:
 *
 * 1. `scheduler.postTask(fn, { priority: 'user-visible' })` where the global exists. The
 *    priority is the one rendering runs at, so a yield neither starves paint nor waits behind
 *    idle work.
 * 2. One module-level `MessageChannel` with a FIFO of resolvers, one port message per call: a
 *    macrotask without `setTimeout`'s nesting clamp.
 * 3. `setTimeout(fn, 0)` where neither exists.
 *
 * An optional `{ delay }` (milliseconds) makes it a **back-off** turn instead: still a later task,
 * but not the next one. It has ONE route — `setTimeout(fn, delay)`. The `MessageChannel` has no
 * delay to give, and `postTask`'s own `delay` option is deliberately not used: measured in the
 * level-2 browser, 200 samples each, a `postTask` delayed by 1 ms wakes at a **median of 15.5 ms**
 * headless and 4.6 ms in a visible window — its delayed queue is frame-aligned — while a chained
 * `setTimeout(fn, 1)` wakes at 5.0 ms headless and 5.3 ms visible, the platform's own nesting
 * clamp (~0 ms for the first five nested timers, ~4 ms after). Same cost where it matters, three
 * times cheaper where the benches and CI run.
 *
 * The sheet's fence poll (§8.10, §5.2's `source()`) is the caller: polling a 20–700 ms fence once
 * per undelayed turn spins a core at ~47 µs a turn, so after a short fast phase it backs off to
 * `{ delay: 1 }` and pays the timer clamp instead of the CPU. No delay, or `0`, is the original
 * function to the byte — same route, same options object, no key added.
 *
 * `systemTimers.yield` is this function. A test's `FakeTimers.yield` is a microtask (§11), because
 * every lane guarantee holds by construction of the queue and none by a task boundary; it takes
 * the same `{ delay }` and answers it by advancing its own clock.
 */

interface SchedulerLike {
  postTask(fn: () => void, o: { priority: 'user-visible' }): unknown
}

/** The one option of the platform yield: how long to wait before the later task (spec §8.10). */
export interface YieldOptions {
  /**
   * Milliseconds to wait before the turn. Omitted or `0` is the plain next turn. A positive value
   * goes to `setTimeout` and is subject to its nesting clamp (~4 ms once timers nest past the
   * fifth, which any long poll does), so it is a lower bound, not a promise.
   */
  readonly delay?: number
}

let channel: MessageChannel | null = null
/** One resolver per posted message, taken in FIFO order — the channel carries no payload. */
const waiting: Array<() => void> = []

function viaChannel(resolve: () => void): void {
  if (channel === null) {
    channel = new MessageChannel()
    channel.port1.onmessage = () => {
      waiting.shift()?.()
    }
    // Node keeps its event loop alive for a started port; a library's idle channel must not.
    // Browsers have no `unref`, and there the question does not arise. The price is that a bare
    // Node script whose only pending work is `await nextTurn()` may exit before it resolves;
    // under Vitest, the bench and any browser something else always holds the loop open.
    ;(channel.port1 as MessagePort & { unref?: () => void }).unref?.()
  }
  waiting.push(resolve)
  channel.port2.postMessage(null)
}

/**
 * Resolves in a later macrotask (spec §8.10), or — with `{ delay }` — in a later macrotask no
 * sooner than `delay` milliseconds from now. Never rejects.
 */
export function nextTurn(o?: YieldOptions): Promise<void> {
  const delay = o?.delay ?? 0
  return new Promise<void>((resolve) => {
    // A back-off turn is a timer, and only a timer: neither of the two faster routes can wait
    // for a millisecond without being frame-aligned (`postTask`'s delay) or unable to wait at
    // all (the channel). See the header for the measurement.
    if (delay > 0) {
      setTimeout(resolve, delay)
      return
    }
    const scheduler = (globalThis as { scheduler?: Partial<SchedulerLike> }).scheduler
    if (typeof scheduler?.postTask === 'function') {
      void scheduler.postTask(resolve, { priority: 'user-visible' })
      return
    }
    if (typeof MessageChannel === 'function') {
      viaChannel(resolve)
      return
    }
    setTimeout(resolve, 0)
  })
}
