/**
 * `gl.compile.paperFs` — the link of `PAPER_FS`, as the driver compiles it (P7).
 *
 * What the first load of a page pays before the first front can be built: on ANGLE's D3D11
 * backend (`BENCH_GPU=1`) this is the HLSL compile, 42–48 s cold before P7 and seconds after;
 * on SwiftShader it is milliseconds and says nothing about the D3D11 cost (spec 11's caveat).
 *
 * **Cold, by construction.** Chromium keys its GPU program cache (in memory and on disk) on the
 * shader source, so every run links a copy of `PAPER_FS` salted with a comment nobody else has
 * compiled — the warm-up, the timed iterations and the counted run each get their own — and the
 * launch profile is fresh. The row's `callMs` is the wall time from `program()` to `ready()`
 * resolving; with `KHR_parallel_shader_compile` the main thread is free for all but the polls of
 * it (`extra.parallel` says whether the driver offered the extension, `extra.chars` the source
 * length), without it the whole compile sits inside `program()`.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { FULLSCREEN_VS, GlError, PAPER_FS } from './deps.js'
import { flush, measure, openFixture } from './harness.js'

afterAll(flush)

describe('gl.compile', () => {
  it('gl.compile.paperFs', async () => {
    const f = openFixture(8, 8)
    expect(f).not.toBeInstanceOf(Error)
    if (f instanceof Error) return
    const parallel = f.gl.getExtension('KHR_parallel_shader_compile') !== null
    let salt = 0
    let outcome: Error | undefined
    await measure('gl.compile.paperFs', {
      gl: f.gl,
      iterations: 3,
      async run() {
        salt += 1
        const program = f.ctx.program(
          FULLSCREEN_VS,
          `${PAPER_FS}\n// bench salt ${salt}\n`,
          'paper',
        )
        if (GlError.is(program)) {
          outcome = program
          return
        }
        const ready = await program.ready()
        if (ready !== undefined) outcome = ready
        program.dispose()
      },
      extra: () => ({
        parallel: parallel ? 'yes' : 'no',
        chars: PAPER_FS.length,
        cache: 'cold: source salted per run, fresh launch profile',
      }),
      note: 'wall time from program() to ready(); the D3D11 number is the fxc compile',
    })
    expect(outcome).toBeUndefined()
    f.dispose()
  }, 900_000)
})
