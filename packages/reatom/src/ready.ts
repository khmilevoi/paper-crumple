/** Join a model-owned readiness operation before entering its native async action. */
export function joinReady<T, K>(invokeOwned: () => Promise<T>, identity: () => K) {
  let pending: { key: K; promise: Promise<T> } | null = null
  return (): Promise<T> => {
    const key = identity()
    if (pending !== null && Object.is(pending.key, key)) return pending.promise
    let resolve: (value: T | PromiseLike<T>) => void = () => {}
    let reject: (cause: unknown) => void = () => {}
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    // Reserve before invoking: native hooks and core notifications may synchronously reenter.
    const entry = { key, promise }
    pending = entry
    const clear = (): void => {
      if (pending === entry) pending = null
    }
    void promise.then(clear, clear)
    try {
      resolve(invokeOwned())
    } catch (cause) {
      reject(cause)
    }
    return promise
  }
}
