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
import pack1x1 from './packs/1x1.js'
import pack2x3 from './packs/2x3.js'
import pack3x2 from './packs/3x2.js'
import { createIntegrationHost, type HostFront } from './testing/integration-host.js'

const PACKS = [pack1x1, pack2x3, pack3x2]

const live: Array<{ dispose(): void }> = []
afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

/** A flat, opaque, distinguishable front. Raw bytes, never a PNG (§7.4.1). */
function solid(key: string, rgb: [number, number, number]): HostFront {
  const w = 64
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
    const host = await createIntegrationHost({ fronts: [solid('a', [200, 40, 40])], packs: PACKS })
    if (host instanceof Error) return expect.fail(host.message)
    live.push(host)
    expect(host.stage.lost).toBe(false)
    // A HostedStage has no `resize` at the *type* level; a BlitStage and a DirectStage do
    // (§4.0.1). The runtime object built by packages/core/src/stage.ts:1519 carries
    // `resize` unconditionally regardless of surface.owned, so `'resize' in host.stage` cannot
    // distinguish the modes at runtime — that gap is a finding against stage.ts for closeout,
    // not something this fixture papers over. `surface.owned` is the property that actually says
    // the destination is the test's own injected context and not one the stage created.
    expect(host.stage.surface.owned).toBe(false)
  })

  it('draws a shown sprite into the framebuffer the test owns', async () => {
    const front = solid('a', [200, 40, 40])
    const host = await createIntegrationHost({ fronts: [front], packs: PACKS })
    if (host instanceof Error) return expect.fail(host.message)
    live.push(host)
    // Raw bytes, never a PNG (§7.4.1) — an ImageBitmap built straight off the texels via
    // createImageBitmap(ImageData), never an OffscreenCanvas putImageData round trip: Chromium's
    // 2D canvas stores premultiplied, which zeroes RGB under zero alpha before this ever draws
    // (packages/paper/src/artwork.gl.test.ts:42-55). An ImageBitmap is a PinnedSource, so pin: true.
    const bitmap = await createImageBitmap(
      new ImageData(new Uint8ClampedArray(front.texels), front.size.w, front.size.h),
      { premultiplyAlpha: 'none', colorSpaceConversion: 'none' },
    )
    const sprite = await host.stage.add(bitmap, { key: 'a', pin: true })
    // stage.ts's buildSprite() unconditionally passes presetForImageId(key) — an opaque 8-hex-digit
    // fold-preset token, D5 — as motion.fit()'s `override` on every add()/mount(). §4.1's own
    // contract (packages/core/src/preset.ts) is that "a slot maps an unrecognised override
    // deterministically onto one of its own presets and does not error on it", and
    // packages/core/src/preset.test.ts:9 pins the token as "a legal override string anywhere".
    // packages/motion/src/source.ts's fit() now normalises an unrecognised override (anything that
    // is not one of '2x3' | '1x1' | '3x2') onto the aspect-derived bucket instead of forwarding it
    // straight into packages/motion/src/buckets.ts's fitSheet(), so presetForImageId('a') ===
    // 'e40c292c' no longer collides with a literal bucket id and this add() succeeds.
    if (isAborted(sprite)) return expect.fail('add() was unexpectedly ABORTED')
    if (sprite instanceof Error) return expect.fail(sprite.message)
    const view = host.view()
    if (view instanceof Error) return expect.fail(view.message)
    expect(view.show(sprite)).toBeUndefined()
    const got = host.read()
    // Something was actually drawn: the sprite's opaque red must have replaced at least some of
    // the framebuffer's cleared, fully-transparent 0,0,0,0.
    let sawAlpha = false
    for (let i = 3; i < got.length; i += 4) {
      if (got[i] !== 0) {
        sawAlpha = true
        break
      }
    }
    expect(sawAlpha).toBe(true)
  })

  it('releases its context, so a file of these cannot exhaust the ~16-context cap', async () => {
    const host = await createIntegrationHost({ fronts: [solid('a', [10, 20, 30])], packs: PACKS })
    if (host instanceof Error) return expect.fail(host.message)
    host.dispose()
    expect(host.gl.isContextLost()).toBe(true)
  })
})
