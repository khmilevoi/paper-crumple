import {
  isAborted,
  paperStage,
  type DrawResult,
  type HostedStage,
  type MotionSource,
  type PlayResult,
  type Run,
  type SheetRenderer,
  type View,
} from '@paper-crumple/core'

const sheet: SheetRenderer = {
  knobs: [],
  overscan: 0,
  mount: () => undefined,
  async source(bitmap) {
    const rect = { x: 0, y: 0, w: bitmap.width, h: bitmap.height }
    return { rect, frontRect: rect, bytes: 0 }
  },
  build(_handle, size) {
    const rect = { x: 0, y: 0, w: size.w, h: size.h }
    return {
      texture: {} as WebGLTexture,
      width: size.w,
      height: size.h,
      rect,
      artwork: rect,
      bytes: 0,
    }
  },
  releaseFront: () => {},
  release: () => {},
  dispose: () => {},
}

const motion: MotionSource = {
  knobs: [],
  mount: () => undefined,
  fit(rect) {
    return {
      frontSize: { w: rect.w, h: rect.h },
      sortKey: 'reatom-public-core-integration',
    }
  },
  async load() {
    return {
      frameCount: 6,
      keyFrames: [0, 1, 2, 3, 4, 5],
      dwells: [0, 0, 0, 0, 0, 0],
    }
  },
  draw({ fit, frame }): DrawResult {
    return { sortKey: fit.sortKey, frame }
  },
  release: () => {},
  dispose: () => {},
}

export interface PublicCoreRunFixture {
  readonly stage: HostedStage
  readonly view: View
  readonly raw: Run<PlayResult>
  readonly ends: boolean[]
  dispose(): void
}

export async function createPublicCoreRun(): Promise<PublicCoreRunFixture | Error> {
  const host = document.createElement('canvas')
  host.width = 64
  host.height = 64
  const gl = host.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  })
  if (gl === null) return new Error('WebGL2 unavailable in integration test')

  const stage = await paperStage({ sheet, motion, maxSize: 64, gl })
  if (stage instanceof Error) return stage
  if (isAborted(stage)) return new Error('public core stage creation was aborted')

  const source = document.createElement('canvas')
  source.width = 8
  source.height = 8
  const sprite = await stage.add(source, { key: 'integration', pin: true })
  if (sprite instanceof Error) {
    stage.dispose()
    return sprite
  }
  if (isAborted(sprite)) {
    stage.dispose()
    return new Error('public core sprite creation was aborted')
  }

  const framebuffer = gl.createFramebuffer()
  if (framebuffer === null) {
    stage.dispose()
    return new Error('WebGL2 framebuffer unavailable in integration test')
  }
  const viewport = { x: 0, y: 0, w: 64, h: 64 }
  const view = stage.view({ framebuffer, viewport })
  if (view instanceof Error) {
    stage.dispose()
    gl.deleteFramebuffer(framebuffer)
    return view
  }
  view.show(sprite)
  const ends: boolean[] = []
  view.on('end', ({ completed }) => ends.push(completed))
  const raw = view.play(0, 5, { duration: 60_000 })

  return {
    stage,
    view,
    raw,
    ends,
    dispose() {
      stage.dispose()
      gl.deleteFramebuffer(framebuffer)
    },
  }
}
