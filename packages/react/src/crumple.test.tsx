/**
 * @vitest-environment jsdom
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { Crumple } from './crumple.js'
import type { Crumple as CrumpleValue } from './crumple.js'
import { render } from './testing/render.js'

function instance(o?: Partial<CrumpleValue>): CrumpleValue {
  return {
    state: 'detached',
    parked: false,
    pose: 0,
    shown: null,
    sprite: null,
    requested: null,
    error: null,
    frame: null,
    frameStyle: null,
    artworkStyle: null,
    view: null,
    ref: () => {},
    play: () => null,
    stop: () => {},
    refresh: () => {},
    ...o,
  }
}

test('a positioned wrapper, a canvas inside it, and the ref on the canvas (§6)', async () => {
  const ref = vi.fn()
  const harness = await render(createElement(Crumple, { value: instance({ ref }) }))
  const wrapper = harness.container.firstElementChild as HTMLElement
  expect(wrapper.tagName).toBe('DIV')
  expect(wrapper.style.position).toBe('relative')
  const canvas = wrapper.querySelector('canvas')
  expect(canvas).not.toBeNull()
  expect(ref).toHaveBeenCalledWith(canvas)
  await harness.unmount()
})

test('DOM props land on the wrapper', async () => {
  const onClick = vi.fn()
  const harness = await render(
    createElement(Crumple, { value: instance(), className: 'tile', onClick }),
  )
  const wrapper = harness.container.firstElementChild as HTMLElement
  expect(wrapper.className).toBe('tile')
  wrapper.click()
  expect(onClick).toHaveBeenCalledTimes(1)
  await harness.unmount()
})

test('children are layered over the canvas while shown is null, and go when it is not (§6)', async () => {
  const harness = await render(
    createElement(Crumple, { value: instance() }, createElement('span', null, 'loading')),
  )
  expect(harness.container.textContent).toBe('loading')
  await harness.rerender(
    createElement(
      Crumple,
      { value: instance({ shown: 'hero' }) },
      createElement('span', null, 'loading'),
    ),
  )
  expect(harness.container.textContent).toBe('')
  await harness.unmount()
})

test('frameStyle is spread onto the wrapper and beats the consumer s own style (§6)', async () => {
  const harness = await render(
    createElement(Crumple, {
      value: instance({
        frameStyle: { width: '230.4px', height: '230.4px', left: '-19.2px', top: '-19.2px' },
      }),
      style: { width: '10px', background: 'red' },
    }),
  )
  const wrapper = harness.container.firstElementChild as HTMLElement
  expect(wrapper.style.width).toBe('230.4px')
  expect(wrapper.style.left).toBe('-19.2px')
  // Everything the frame does not speak for is the consumer's.
  expect(wrapper.style.background).toBe('red')
  await harness.unmount()
})

test('a null frameStyle leaves the consumer s size alone', async () => {
  const harness = await render(
    createElement(Crumple, { value: instance(), style: { width: '10px' } }),
  )
  const wrapper = harness.container.firstElementChild as HTMLElement
  expect(wrapper.style.width).toBe('10px')
  await harness.unmount()
})

test('canvasProps reach the canvas and never the wrapper', async () => {
  const harness = await render(
    createElement(Crumple, {
      value: instance(),
      className: 'tile',
      canvasProps: { className: 'inner', 'aria-hidden': true },
    }),
  )
  const wrapper = harness.container.firstElementChild as HTMLElement
  const canvas = wrapper.querySelector('canvas')
  expect(wrapper.className).toBe('tile')
  expect(canvas?.className).toBe('inner')
  expect(canvas?.getAttribute('aria-hidden')).toBe('true')
  await harness.unmount()
})

test('the canvas takes the wrapper s box in CSS, and nobody writes width or height (§6)', async () => {
  const harness = await render(createElement(Crumple, { value: instance() }))
  const canvas = harness.container.querySelector('canvas')
  expect(canvas?.style.width).toBe('100%')
  expect(canvas?.style.height).toBe('100%')
  expect(canvas?.style.display).toBe('block')
  expect(canvas?.hasAttribute('width')).toBe(false)
  expect(canvas?.hasAttribute('height')).toBe(false)
  await harness.unmount()
})

test('the server render is the placeholder branch, so hydration agrees (§8)', () => {
  // `renderToStaticMarkup` runs the real server code path — no DOM, no effects, no refs invoked
  // (a ref callback is a client-only concept). The detached instance's `shown` is `null`, so the
  // server markup must carry the placeholder's text and must not claim a sprite via `shown`.
  const markup = renderToStaticMarkup(
    createElement(Crumple, { value: instance() }, createElement('span', null, 'skeleton')),
  )
  expect(markup).toContain('skeleton')
  expect(markup).toContain('<canvas')
  // The canvas element in the server markup carries neither a width nor a height attribute: the
  // stage, not React, ever writes those, and the server has no stage to consult.
  expect(markup).not.toMatch(/<canvas[^>]*\swidth=/)
  expect(markup).not.toMatch(/<canvas[^>]*\sheight=/)
})
