import { afterEach, describe, expect, it } from 'vitest'
import { GlError } from './errors.js'
import { createOwnedSurface, hostInjected, type SurfaceHost } from './stage-surface.js'
import { createRawGl } from './testing/gl-fixture.js'

// Level 2 runs against a cap of roughly sixteen live WebGL2 contexts (§4.0). Every context this
// file opens is closed here — a leak fails from the seventeenth test onward and reads as a flake.
const live: Array<{ dispose(): void }> = []
afterEach(() => {
  while (live.length > 0) live.pop()?.dispose()
})

function keep(host: SurfaceHost): SurfaceHost {
  live.push(host)
  return host
}

describe('the stage-owned surface, against a real WebGL2 context', () => {
  it('creates its own canvas and its own context and is presentable', () => {
    const host = createOwnedSurface({ present: 'blit', maxSize: 128 })
    expect(host).not.toBeInstanceOf(GlError)
    if (host instanceof GlError) return
    keep(host)
    expect(host.surface.owned).toBe(true)
    expect(host.surface.presentable).toBe(true)
    expect(host.surface.width).toBe(128)
    expect(host.gl.getContextAttributes()?.depth).toBe(true)
  })

  it("present: 'direct' exposes an HTMLCanvasElement that is not in the document", () => {
    const host = createOwnedSurface({ present: 'direct', maxSize: 64 })
    if (host instanceof GlError) return expect.fail(host.message)
    keep(host)
    expect(host.surface.canvas).toBeInstanceOf(HTMLCanvasElement)
    expect((host.surface.canvas as HTMLCanvasElement).isConnected).toBe(false)
  })

  it('grows the real backing store monotonically', () => {
    const host = createOwnedSurface({ present: 'blit', maxSize: 64 })
    if (host instanceof GlError) return expect.fail(host.message)
    keep(host)
    expect(host.grow(100, 40)).toBeUndefined()
    expect(host.surface.width).toBe(100)
    expect(host.surface.height).toBe(64)
  })

  it('accepts an injected context created with the §7.3 bag and marks it unowned', () => {
    const raw = createRawGl(8, 8)
    live.push(raw)
    const host = hostInjected(raw.gl)
    if (host instanceof GlError) return expect.fail(host.message)
    expect(host.surface.owned).toBe(false)
    expect(host.surface.presentable).toBe(true)
  })
})
