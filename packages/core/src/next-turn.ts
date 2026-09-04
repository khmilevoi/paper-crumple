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
 * `systemTimers.yield` is this function. A test's `FakeTimers.yield` is a microtask (§11), because
 * every lane guarantee holds by construction of the queue and none by a task boundary.
 */

interface SchedulerLike {
  postTask(fn: () => void, o: { priority: 'user-visible' }): unknown
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
    // Browsers have no `unref`, and there the question does not arise.
    ;(channel.port1 as MessagePort & { unref?: () => void }).unref?.()
  }
  waiting.push(resolve)
  channel.port2.postMessage(null)
}

/** Resolves in a later macrotask (spec §8.10). Never rejects. */
export function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
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
