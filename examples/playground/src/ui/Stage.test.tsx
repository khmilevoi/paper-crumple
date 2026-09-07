// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import type { Crumple } from '@paper-crumple/react'

import { Stage } from './Stage'

/** A crumple whose only live parts are the ones `<Crumple>` reads: `ref`, `shown`, `frameStyle`. */
function fakeCrumple(over: Partial<Crumple> = {}): Crumple {
  return {
    state: 'detached',
    parked: false,
    pose: 0,
    shown: null,
    requested: null,
    error: null,
    frame: null,
    frameStyle: null,
    view: null,
    ref: () => {},
    play: () => null,
    stop: () => {},
    refresh: () => {},
    ...over,
  } as Crumple
}

const teardown: (() => void)[] = []
afterEach(() => {
  for (const fn of teardown.splice(0)) fn()
})

function render(node: ReactNode): HTMLElement {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  teardown.push(() => {
    act(() => {
      root.unmount()
    })
    host.remove()
  })
  return host
}

describe('<Stage>', () => {
  it('sizes the slot from the artwork box and hangs the paper off it out of flow', () => {
    const host = render(
      <Stage
        hero={fakeCrumple()}
        slotStyle={{ width: '240px', height: '360px' }}
        poseChip="pose 0 / 11"
        sampleChip="sweater"
        edgeChip="smooth · clean"
        background="dark"
        onDropImage={() => {}}
      />,
    )
    const slot = host.querySelector('.stage-frame')
    const paper = host.querySelector('.stage-paper')
    expect(slot).not.toBeNull()
    expect(paper).not.toBeNull()
    if (!(slot instanceof HTMLElement) || !(paper instanceof HTMLElement)) return
    expect(slot.style.width).toBe('240px')
    expect(slot.style.height).toBe('360px')
    // `position` is the one of the wrapper's own inline properties a consumer may override; the
    // four `frameStyle` carries are applied after `style` and are not overridable.
    expect(paper.style.position).toBe('absolute')
  })

  it('leaves the slot at its stylesheet size while no front is resident', () => {
    const host = render(
      <Stage
        hero={fakeCrumple()}
        slotStyle={null}
        poseChip="pose 0 / 11"
        sampleChip="sweater"
        edgeChip="smooth · clean"
        background="dark"
        onDropImage={() => {}}
      />,
    )
    const slot = host.querySelector('.stage-frame')
    if (!(slot instanceof HTMLElement)) {
      expect(slot).toBeInstanceOf(HTMLElement)
      return
    }
    expect(slot.style.width).toBe('')
  })

  it('hands the canvas to the instance ref and to nobody else', () => {
    const seen: (HTMLCanvasElement | null)[] = []
    const host = render(
      <Stage
        hero={fakeCrumple({
          ref: (el) => {
            seen.push(el)
          },
        })}
        slotStyle={null}
        poseChip="pose 0 / 11"
        sampleChip="sweater"
        edgeChip="smooth · clean"
        background="dark"
        onDropImage={() => {}}
      />,
    )
    expect(host.querySelector('canvas')).toBeInstanceOf(HTMLCanvasElement)
    expect(seen[0]).toBeInstanceOf(HTMLCanvasElement)
  })
})
