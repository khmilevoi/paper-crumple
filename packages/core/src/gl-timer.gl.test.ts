import { afterEach, describe, expect, it } from 'vitest'
import { createGpuTimer } from './gl-timer.js'
import { createGlFixture, type GlFixture } from './testing/gl-fixture.js'

let fixture: GlFixture | null = null

afterEach(() => {
  // §4.0's cap of roughly sixteen live contexts.
  fixture?.dispose()
  fixture = null
})

function open(): GlFixture {
  fixture = createGlFixture(4, 4)
  expect(fixture.gl, 'no WebGL2 context — check the SwiftShader launch flags (§11)').not.toBeNull()
  return fixture
}

/** Spin the event loop until `ready()` or the budget runs out. */
async function until(ready: () => boolean, attempts = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (ready()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return ready()
}

describe('createGpuTimer (§5.1)', () => {
  it('tracks caps.timer exactly: no extension, no timer, and never a stub that lies', () => {
    const { ctx } = open()
    const timer = createGpuTimer(ctx)
    if (ctx.caps.timer) {
      expect(timer).not.toBeNull()
      timer?.dispose()
    } else {
      // SwiftShader is not required to expose EXT_disjoint_timer_query_webgl2. A null here is
      // the documented answer and not a failure: §11 puts timing in level 3 precisely because
      // SwiftShader numbers are meaningless, so nothing in CI depends on a measurement.
      expect(timer).toBeNull()
    }
  })

  it('measures a real draw when the driver has the extension', async () => {
    const { ctx, gl } = open()
    const timer = createGpuTimer(ctx)
    if (timer === null) {
      expect(ctx.caps.timer).toBe(false)
      return
    }

    timer.begin()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    timer.end()
    gl.flush()

    let measured: number | undefined
    await until(() => {
      measured = timer.poll()
      return measured !== undefined
    })

    // A disjoint result is discarded rather than reported, so `undefined` after the budget is a
    // legitimate outcome and only a number is asserted about.
    if (measured !== undefined) {
      expect(Number.isFinite(measured)).toBe(true)
      expect(measured).toBeGreaterThanOrEqual(0)
    }
    timer.dispose()
  })

  it('reports nothing before a measurement has finished, and nothing twice', async () => {
    const { ctx, gl } = open()
    const timer = createGpuTimer(ctx)
    if (timer === null) {
      expect(ctx.caps.timer).toBe(false)
      return
    }

    expect(timer.poll()).toBeUndefined()
    timer.begin()
    // A second begin while one is open is a no-op, not a nested query: WebGL2 permits exactly
    // one TIME_ELAPSED query at a time and a second beginQuery is an INVALID_OPERATION.
    timer.begin()
    gl.clear(gl.COLOR_BUFFER_BIT)
    timer.end()
    // A second end with nothing open is a no-op too.
    timer.end()
    gl.flush()

    await until(() => timer.poll() !== undefined)
    expect(timer.poll()).toBeUndefined()
    expect(gl.getError()).toBe(gl.NO_ERROR)
    timer.dispose()
  })
})
