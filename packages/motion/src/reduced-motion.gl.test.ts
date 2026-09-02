/**
 * # `prefers-reduced-motion` (§4.2, §18)
 *
 * The library's two stated jobs are a transition and a loading indicator, so a consumer honouring
 * the setting is not an edge case — and the preference appeared nowhere in the design before the
 * third pass. No API is needed, because `show()` **is** the degraded swap: instant, pose 0, no run.
 *
 * The accommodation is therefore only as good as the claim that both branches end in the same
 * place, and this file is where that claim is a test rather than a sentence. The prose lands
 * elsewhere and is named here so neither half is missed at sync 5: `crumpleTo`'s reference
 * documentation is P9's and is already on `develop` (`packages/core/src/view.ts`), and the
 * getting-started branch is P13's README.
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

/** Raw bytes, never a PNG (§7.4.1). A varying interior, so a constant would not pass. */
function front(key: string, seed: number): HostFront {
  const w = 64
  const h = 64
  const texels = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4
      texels[p] = (x * 3 + seed) % 256
      texels[p + 1] = (y * 5 + seed * 7) % 256
      texels[p + 2] = (x * y + seed * 11) % 256
      texels[p + 3] = 255
    }
  }
  return { key, texels, size: { w, h }, rect: { x: 0, y: 0, w, h } }
}

/**
 * Raw bytes, never a PNG (§7.4.1) — an ImageBitmap built straight off the texels via
 * createImageBitmap(ImageData), never an OffscreenCanvas putImageData round trip: Chromium's 2D
 * canvas stores premultiplied, which zeroes RGB under zero alpha before this ever draws
 * (packages/paper/src/artwork.gl.test.ts:42-55).
 */
function bitmapOf(f: HostFront): Promise<ImageBitmap> {
  return createImageBitmap(new ImageData(new Uint8ClampedArray(f.texels), f.size.w, f.size.h), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

describe('the degraded swap settles where the animated one does', () => {
  it('show(b) and a completed crumpleTo(b) leave the same framebuffer', async () => {
    const a = front('a', 1)
    const b = front('b', 128)
    const host = await createIntegrationHost({ fronts: [a, b], packs: PACKS })
    if (host instanceof Error) return expect.fail(host.message)
    live.push(host)

    const bitmapA = await bitmapOf(a)
    const bitmapB = await bitmapOf(b)
    const spriteA = await host.stage.add(bitmapA, { key: 'a', pin: true })
    const spriteB = await host.stage.add(bitmapB, { key: 'b', pin: true })
    if (spriteA instanceof Error || isAborted(spriteA)) return expect.fail('add(a) refused')
    if (spriteB instanceof Error || isAborted(spriteB)) return expect.fail('add(b) refused')

    const view = host.view()
    if (view instanceof Error) return expect.fail(view.message)

    // The degraded branch: `matchMedia('(prefers-reduced-motion: reduce)').matches` is true.
    host.clear()
    expect(view.show(spriteB)).toBeUndefined()
    const degraded = host.read()

    // The animated branch: start from A, crumple to B, and let the run finish.
    host.clear()
    expect(view.show(spriteA)).toBeUndefined()
    const result = await view.crumpleTo(spriteB)
    expect(result).toBeUndefined()
    const animated = host.read()

    expect(view.sprite).toBe(spriteB)
    expect(view.pose).toBe(0)
    expect(Array.from(animated)).toEqual(Array.from(degraded))
  })

  it('is the exact expression the documentation gives, and both arms are legal calls', async () => {
    const a = front('a', 1)
    const b = front('b', 128)
    const host = await createIntegrationHost({ fronts: [a, b], packs: PACKS })
    if (host instanceof Error) return expect.fail(host.message)
    live.push(host)
    const bitmapB = await bitmapOf(b)
    const spriteB = await host.stage.add(bitmapB, { key: 'b', pin: true })
    if (spriteB instanceof Error || isAborted(spriteB)) return expect.fail('add(b) refused')
    const view = host.view()
    if (view instanceof Error) return expect.fail(view.message)

    // The branch as §4.2 writes it. `matches` is false in the headless page, so this exercises the
    // animated arm; the degraded arm is exercised above. What is asserted here is that the
    // documented expression type-checks and runs as written, with no adapter and no API of its own.
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    const outcome = reduce ? view.show(spriteB) : await view.crumpleTo(spriteB)
    expect(outcome).toBeUndefined()
    expect(view.sprite).toBe(spriteB)
  })
})
