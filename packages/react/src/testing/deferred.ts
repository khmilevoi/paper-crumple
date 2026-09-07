/** A promise a test settles by hand. Used wherever `create` or `prepare` must be held open. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

export function deferred<T>(): Deferred<T> {
  let settle: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return {
    promise,
    resolve(value: T): void {
      settle?.(value)
    },
  }
}
