import { act, createElement, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * React only permits `act` when this flag is set, and it is a global rather than an option.
 * Setting it at module load covers every test file that imports the harness.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export interface Harness {
  readonly container: HTMLElement
  rerender(ui: ReactNode): Promise<void>
  unmount(): Promise<void>
}

export interface HookHarness<T> {
  readonly result: { current: T }
  rerender(): Promise<void>
  unmount(): Promise<void>
}

/** Settle every pending microtask and let React commit whatever they scheduled. */
export function flush(): Promise<void> {
  return act(async () => {})
}

export async function render(ui: ReactNode, o?: { strict?: boolean }): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const wrap = (node: ReactNode): ReactNode =>
    o?.strict === true ? createElement(StrictMode, null, node) : node

  const rerender = async (node: ReactNode): Promise<void> => {
    await act(async () => {
      root.render(wrap(node))
    })
  }

  await rerender(ui)

  return {
    container,
    rerender,
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/**
 * Renders `hook` inside a component that renders nothing, and mirrors its return value into
 * `result.current`. `rerender()` re-renders the same probe, so a test changes what the hook sees
 * by mutating a variable the closure reads rather than by passing new arguments.
 */
export async function renderHook<T>(
  hook: () => T,
  o?: { strict?: boolean },
): Promise<HookHarness<T>> {
  const result = { current: undefined as T }
  const Probe = (): null => {
    result.current = hook()
    return null
  }
  const harness = await render(createElement(Probe), o)
  return {
    result,
    rerender: () => harness.rerender(createElement(Probe)),
    unmount: () => harness.unmount(),
  }
}
