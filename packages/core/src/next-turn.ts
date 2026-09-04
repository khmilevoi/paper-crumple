/**
 * The platform yield between two phases of an asynchronous sprite path (spec §8.10).
 *
 * Resolves in a LATER MACROTASK: `scheduler.postTask(fn, { priority: 'user-visible' })` where
 * the global exists, else one module-level `MessageChannel` with a FIFO of resolvers (one port
 * message per call), else `setTimeout(fn, 0)`. Never a microtask — the point is a rendering and
 * input opportunity between two phases, which a microtask checkpoint does not give. Not `rAF`:
 * a hidden tab would never resolve, and thirty sprites × three phases at frame rate is 1.5 s.
 *
 * `postTask` first because it is the one of the three the browser's own scheduler can order
 * against input (`user-blocking`) and rendering; `MessageChannel` is the same macrotask without
 * that ordering, and `setTimeout(0)` is clamped to 4 ms once nested.
 */
export function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => {
    const scheduler = (globalThis as { scheduler?: SchedulerLike }).scheduler
    if (scheduler !== undefined && typeof scheduler.postTask === 'function') {
      void scheduler.postTask(resolve, { priority: 'user-visible' })
      return
    }
    if (typeof MessageChannel === 'function') {
      viaMessageChannel(resolve)
      return
    }
    setTimeout(resolve, 0)
  })
}

interface SchedulerLike {
  readonly postTask?: (fn: () => void, o: { priority: 'user-visible' }) => unknown
}

/** Node's `MessagePort` has these and a browser's does not; a port left referenced would keep a
 *  node process alive after its last turn, so the port is referenced only while a turn is
 *  pending. */
interface RefPort {
  ref?: () => void
  unref?: () => void
}

let channel: MessageChannel | null = null
const waiting: (() => void)[] = []

function viaMessageChannel(resolve: () => void): void {
  if (channel === null) {
    channel = new MessageChannel()
    const port = channel.port1
    port.onmessage = () => {
      waiting.shift()?.()
      if (waiting.length === 0) (port as unknown as RefPort).unref?.()
    }
  }
  waiting.push(resolve)
  ;(channel.port1 as unknown as RefPort).ref?.()
  channel.port2.postMessage(null)
}
