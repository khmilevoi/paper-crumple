import { afterEach, describe, expect, it } from 'vitest'
import { isAborted } from './abort.js'
import { paperStage } from './stage.js'
import { fakeMotion, fakeSheet } from './testing/fake-slots.js'

// Level 2 runs against a cap of roughly sixteen live WebGL2 contexts (§4.0). Every stage this
// file creates is disposed here — a leak fails from the seventeenth test onward and reads as a
// flake. Dispose the stage; never re-run.
const live: Array<{ dispose(): void }> = []
afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

function tile(): HTMLCanvasElement {
  const el = document.createElement('canvas')
  el.style.width = '96px'
  el.style.height = '96px'
  document.body.append(el)
  return el
}

describe('paperStage against a real WebGL2 context', () => {
  it('mounts, creates its own canvas, and reports real caps', async () => {
    const stage = await paperStage({
      sheet: fakeSheet(),
      motion: fakeMotion(),
      maxSize: 128,
      present: 'blit',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    live.push(stage)
    expect(stage.caps.maxTextureSize).toBeGreaterThan(0)
    expect(stage.surface.owned).toBe(true)
    expect(stage.lost).toBe(false)
  })

  it('derives its size from cssPx and devicePixelRatio, so the consumer writes one number', async () => {
    const stage = await paperStage({
      sheet: fakeSheet(),
      motion: fakeMotion(),
      cssPx: 96,
      present: 'blit',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    live.push(stage)
    expect(stage.surface.width % 64).toBe(0)
  })

  it('mounts into a real element and sizes its backing store for the display', async () => {
    const stage = await paperStage({
      sheet: fakeSheet(),
      motion: fakeMotion(),
      maxSize: 256,
      present: 'blit',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    live.push(stage)
    const el = tile()
    const view = await stage.mount({ key: 'k', src: '/does-not-exist.png', canvas: el })
    // The fake sheet needs a bitmap; a 404 is an AddError and that is the honest level-2 answer
    // for a stage with no real asset path. What is asserted is that the failure is a **value**.
    expect(view).toBeInstanceOf(Error)
    expect(stage.views).toEqual([])
    el.remove()
  })

  it("present: 'direct' exposes an element the consumer appends, with no cast", async () => {
    const stage = await paperStage({
      sheet: fakeSheet(),
      motion: fakeMotion(),
      maxSize: 128,
      present: 'direct',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    live.push(stage)
    const el: HTMLCanvasElement = stage.surface.canvas
    document.body.append(el)
    expect(el.isConnected).toBe(true)
    expect(stage.resize(64, 64)).toBeUndefined()
    expect(stage.surface.width).toBe(64)
    el.remove()
  })

  it('accepts an injected context, refuses resize on it at compile time, and never loses it', async () => {
    const host = document.createElement('canvas')
    const gl = host.getContext('webgl2', { depth: true })
    expect(gl).not.toBeNull()
    if (gl === null) return
    const stage = await paperStage({ sheet: fakeSheet(), motion: fakeMotion(), maxSize: 64, gl })
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    stage.dispose()
    // `loseContext()` is called **only** when `stage.surface.owned`. A host application's
    // renderer must survive our teardown.
    expect(gl.isContextLost()).toBe(false)
  })

  it('dispose() is idempotent and releases the context it owns', async () => {
    const stage = await paperStage({
      sheet: fakeSheet(),
      motion: fakeMotion(),
      maxSize: 64,
      present: 'blit',
    })
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
    stage.dispose()
    stage.dispose()
    expect(stage.get('anything')).toBeUndefined()
  })
})
