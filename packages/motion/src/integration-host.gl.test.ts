/**
 * # The minimal level-2 host (§3.4)
 *
 * §3.4 splits the original "demo" in two: the **showcase application is deferred**, and a **minimal
 * level-2 test host is kept, and specified as a test fixture rather than an application** —
 * "coupling a pixel-comparison harness to a demo app means a change to the showcase turns the test
 * suite red". This file is that host's own test. There is no application anywhere in this plan.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { isAborted } from '@paper-crumple/core'
import { createIntegrationHost, type HostFront } from './testing/integration-host.js'

const live: Array<{ dispose(): void }> = []
afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

/** A flat, opaque, distinguishable front. Raw bytes, never a PNG (§7.4.1). */
function solid(key: string, rgb: [number, number, number]): HostFront {
  const w = 96
  const h = 64
  const texels = new Uint8Array(w * h * 4)
  for (let p = 0; p < texels.length; p += 4) {
    texels[p] = rgb[0]
    texels[p + 1] = rgb[1]
    texels[p + 2] = rgb[2]
    texels[p + 3] = 255
  }
  return { key, texels, size: { w, h }, rect: { x: 0, y: 0, w, h } }
}

describe('the minimal level-2 host', () => {
  it("is a HostedStage over the test's own context, so no destination canvas is in the case", async () => {
    const host = await createIntegrationHost({ fronts: [solid('a', [200, 40, 40])] })
    if (host instanceof Error) return expect.fail(host.message)
    live.push(host)
    expect(host.stage.lost).toBe(false)
    // A HostedStage has no `resize`; a BlitStage and a DirectStage do (§4.0.1). This is the
    // property that says the destination is the test's and not the stage's.
    expect('resize' in host.stage).toBe(false)
  })

  it('draws a shown sprite into the framebuffer the test owns', async () => {
    const front = solid('a', [200, 40, 40])
    const host = await createIntegrationHost({ fronts: [front] })
    if (host instanceof Error) return expect.fail(host.message)
    live.push(host)
    // Create a proper image Blob from raw bytes using canvas
    const canvas = new OffscreenCanvas(front.size.w, front.size.h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return expect.fail('could not get 2d context')
    const imageData = new ImageData(new Uint8ClampedArray(front.texels), front.size.w, front.size.h)
    ctx.putImageData(imageData, 0, 0)
    const blob = await canvas.convertToBlob()
    const sprite = await host.stage.add(blob, { key: 'a' })
    if (sprite instanceof Error || isAborted(sprite))
      return expect.fail(`add() failed: ${sprite instanceof Error ? sprite.message : 'ABORTED'}`)
    const view = host.view()
    if (view instanceof Error) return expect.fail(view.message)
    host.clear()
    expect(view.show(sprite)).toBeUndefined()
    const got = host.read()
    // Something was drawn: the cleared target was fully transparent and no longer is.
    expect(got.some((byte) => byte !== 0)).toBe(true)
  })

  it('releases its context, so a file of these cannot exhaust the ~16-context cap', async () => {
    const host = await createIntegrationHost({ fronts: [solid('a', [10, 20, 30])] })
    if (host instanceof Error) return expect.fail(host.message)
    host.dispose()
    expect(host.gl.isContextLost()).toBe(true)
  })
})
