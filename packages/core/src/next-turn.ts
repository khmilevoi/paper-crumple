/**
 * The platform yield: resolves on a fresh macrotask, never inside the current microtask
 * checkpoint, so whatever the browser had queued — input, rendering, other tasks — runs first.
 *
 * `scheduler.postTask` at `'user-visible'` where the platform has it (Chromium), a
 * `MessageChannel` message where it does not (a real task, unlike `setTimeout(0)`'s clamped and
 * throttled one), and `setTimeout(0)` last. Shared by every internal wait that has to leave the
 * event loop alone between two looks at something — the deferred program link polls
 * `COMPLETION_STATUS_KHR` once per turn (`gl-context.ts`) — so there is one definition of "later,
 * off the current task" in the library. Exported from `/unstable` (§14) for slot authors who need
 * the same yield.
 *
 * This is not the deferral §7.1 forbids: nothing that starts a run or emits an event waits on
 * it. It lives on the asynchronous ingest path only (`source()`, `add()`, `prepare()`), which is a
 * promise already.
 */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    const scheduler = (
      globalThis as {
        scheduler?: { postTask?: (cb: () => void, o: { priority: 'user-visible' }) => unknown }
      }
    ).scheduler
    if (scheduler !== undefined && typeof scheduler.postTask === 'function') {
      scheduler.postTask(resolve, { priority: 'user-visible' })
      return
    }
    if (typeof MessageChannel !== 'undefined') {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        resolve()
      }
      channel.port2.postMessage(undefined)
      return
    }
    setTimeout(resolve, 0)
  })
}
