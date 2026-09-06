import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * The package-wide identity-stability convention (spec §2.1), applied without exception to
 * instance methods, to `ref`, to every consumer callback the binding invokes, and to
 * `SceneOptions.create`.
 *
 * The latest function is mirrored into a ref and what is handed out is a wrapper whose identity
 * never changes. The mirror is written in a layout effect and **never during render**: a render
 * React discards — concurrent, or StrictMode's second pass — must not publish its closure, and
 * only a commit that actually happened may. The ref's initial value covers the window before the
 * first layout effect runs.
 *
 * For `ref` this is correctness rather than ergonomics: React re-invokes a callback ref whose
 * identity changed, so an unstable one would dispose the view and rebuild it on every render.
 */
export function useEvent<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...a: A) => ref.current(...a), [])
}
