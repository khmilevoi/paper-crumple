// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { paperSheet } from '@paper-crumple/paper'
import type { EdgeSpec } from '@paper-crumple/paper'
import { EdgeSection } from './EdgeSection'
import { decodeState, encodeState } from '../app/state'
import { DEFAULT_CONFIG } from '../scene/config'

const container = document.createElement('div')
let root: ReturnType<typeof createRoot> | undefined
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
})

function render(spec: EdgeSpec) {
  const onSpecChange = vi.fn()
  // Keep the old descriptors during a rebuild: hidden controls must follow the selected shape.
  const entries = paperSheet({ edgeShape: 'torn', edgeFinish: 'paper' }).knobs.map((k) => ({
    key: `sheet.${k.key}`,
    k,
  }))
  root = createRoot(container)
  act(() =>
    root?.render(
      <EdgeSection
        entries={entries}
        knobs={{ 'sheet.edgeWidth': 0 }}
        spec={spec}
        onSpecChange={onSpecChange}
        onSet={vi.fn()}
        overscanHeadroom={0.3}
      />,
    ),
  )
  return onSpecChange
}

it('offers none and preserves the selected finish when disabling the edge', () => {
  const onChange = render({ shape: 'torn', finish: 'paper', widthUnit: 'px' })
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'None')
  expect(button).toBeDefined()
  act(() => button?.click())
  expect(onChange).toHaveBeenCalledWith({ shape: 'none', finish: 'paper', widthUnit: 'px' })
  expect(container.textContent).toContain('torn edge starts at the artwork')
})

it('hides edge-only controls under none while keeping sheet relief', () => {
  render({ shape: 'none', finish: 'paper', widthUnit: 'px' })
  expect(container.querySelector('[aria-label="edge finish"]')).toBeNull()
  expect(container.querySelector('[aria-label="edge width unit"]')).toBeNull()
  expect(container.textContent).not.toContain('edge width')
  expect(container.textContent).not.toContain('Finish — paper')
  expect(container.textContent).not.toContain('Shape — torn')
  expect(container.textContent).toContain('sheet relief')
})

it('round-trips none in a shared playground URL', () => {
  const config = { ...DEFAULT_CONFIG, edgeShape: 'none' as const }
  expect(decodeState(encodeState(config, {}))).toEqual({ config, knobs: {} })
})
