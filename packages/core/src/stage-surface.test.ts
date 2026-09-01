import { describe, expect, it, vi } from 'vitest'
import { GlError } from './errors.js'
import { createOwnedSurface, hostInjected, type SurfaceEnv } from './stage-surface.js'

/** The smallest object that answers everything `stage-surface.ts` asks of a context. */
function fakeGl(canvas: object, attrs?: Partial<WebGLContextAttributes>) {
  const ext = { loseContext: vi.fn() }
  return {
    canvas,
    getContextAttributes: () => ({
      alpha: true,
      antialias: false,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: false,
      powerPreference: 'high-performance',
      ...attrs,
    }),
    getExtension: (name: string) => (name === 'WEBGL_lose_context' ? ext : null),
    __ext: ext,
  } as unknown as WebGL2RenderingContext & { __ext: { loseContext: ReturnType<typeof vi.fn> } }
}

function env(): SurfaceEnv & { made: Array<{ w: number; h: number; kind: string }> } {
  const made: Array<{ w: number; h: number; kind: string }> = []
  const canvasOf = (kind: string, w: number, h: number) => {
    const c = { width: w, height: h, getContext: (id: string) => (id === 'webgl2' ? gl : null) }
    const gl = fakeGl(c)
    made.push({ w, h, kind })
    return c as unknown as HTMLCanvasElement
  }
  return {
    made,
    makeOffscreen: (w, h) => canvasOf('offscreen', w, h),
    makeElement: (w, h) => canvasOf('element', w, h),
  }
}

describe('the stage-owned surface', () => {
  it('is maxSize square at creation and reports owned: true', () => {
    const e = env()
    const host = createOwnedSurface({ present: 'blit', maxSize: 384, env: e })
    expect(host).not.toBeInstanceOf(Error)
    if (host instanceof Error) return
    expect(host.surface.owned).toBe(true)
    expect(host.surface.width).toBe(384)
    expect(host.surface.height).toBe(384)
    expect(host.surface.presentable).toBe(true)
  })

  it("puts a 'blit' surface offscreen and a 'direct' surface on an element", () => {
    const b = env()
    createOwnedSurface({ present: 'blit', maxSize: 128, env: b })
    expect(b.made[0]?.kind).toBe('offscreen')
    const d = env()
    createOwnedSurface({ present: 'direct', maxSize: 128, env: d })
    expect(d.made[0]?.kind).toBe('element')
  })

  it('grows monotonically and never shrinks', () => {
    const host = createOwnedSurface({ present: 'blit', maxSize: 128, env: env() })
    if (host instanceof Error) return expect.fail('surface refused')
    expect(host.grow(200, 90)).toBeUndefined()
    expect([host.surface.width, host.surface.height]).toEqual([200, 128])
    expect(host.grow(64, 300)).toBeUndefined()
    expect([host.surface.width, host.surface.height]).toEqual([200, 300])
    expect(host.grow(1, 1)).toBeUndefined()
    expect([host.surface.width, host.surface.height]).toEqual([200, 300])
  })

  it('resize() sets both axes and may shrink, because the consumer asked', () => {
    const host = createOwnedSurface({ present: 'direct', maxSize: 256, env: env() })
    if (host instanceof Error) return expect.fail('surface refused')
    expect(host.resize(64, 32)).toBeUndefined()
    expect([host.surface.width, host.surface.height]).toEqual([64, 32])
  })

  it('resize() refuses a non-finite or non-positive size with a GlError', () => {
    const host = createOwnedSurface({ present: 'direct', maxSize: 256, env: env() })
    if (host instanceof Error) return expect.fail('surface refused')
    expect(host.resize(0, 10)).toBeInstanceOf(GlError)
    expect(host.resize(10, Number.NaN)).toBeInstanceOf(GlError)
  })

  it('loses the context on dispose, and only for an owned surface', () => {
    const e = env()
    const owned = createOwnedSurface({ present: 'blit', maxSize: 64, env: e })
    if (owned instanceof Error) return expect.fail('surface refused')
    const ownedExt = (owned.gl as unknown as { __ext: { loseContext: () => void } }).__ext
    owned.dispose()
    owned.dispose() // idempotent
    expect(ownedExt.loseContext).toHaveBeenCalledTimes(1)

    const injected = hostInjected(fakeGl({ width: 10, height: 20 }))
    if (injected instanceof Error) return expect.fail('injection refused')
    const injectedExt = (injected.gl as unknown as { __ext: { loseContext: () => void } }).__ext
    injected.dispose()
    expect(injectedExt.loseContext).not.toHaveBeenCalled()
  })

  it('an injected surface is not owned, reports the context canvas, and has no resize', () => {
    const injected = hostInjected(fakeGl({ width: 10, height: 20 }))
    if (injected instanceof Error) return expect.fail('injection refused')
    expect(injected.surface.owned).toBe(false)
    expect(injected.surface.width).toBe(10)
    expect(injected.surface.height).toBe(20)
    // grow() is a no-op on a surface the stage does not own: it is not the stage's to resize.
    expect(injected.grow(4096, 4096)).toBeUndefined()
    expect(injected.surface.width).toBe(10)
  })

  it('carries the grading warnings and refuses a depth-less injection', () => {
    const warned = hostInjected(fakeGl({ width: 8, height: 8 }, { antialias: true }))
    if (warned instanceof Error) return expect.fail('injection refused')
    expect(warned.warnings.join(' ')).toContain('antialias')
    expect(hostInjected(fakeGl({ width: 8, height: 8 }, { depth: false }))).toBeInstanceOf(GlError)
  })

  it('returns a GlError rather than throwing when getContext answers null', () => {
    const broken: SurfaceEnv = {
      makeOffscreen: () => ({ width: 1, height: 1, getContext: () => null }) as never,
    }
    const host = createOwnedSurface({ present: 'blit', maxSize: 64, env: broken })
    expect(host).toBeInstanceOf(GlError)
  })
})
