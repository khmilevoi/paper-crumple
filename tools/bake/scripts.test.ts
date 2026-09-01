/**
 * `crumple.py` and `smoke.py` need Blender 5.2.1 LTS and 4 m 10 s of single-threaded wall time,
 * so they are never executed by a test (spec 13). They are still Python, and a truncated copy or
 * a bad edit should not wait for a manual bake to surface — `py_compile` parses both without
 * importing `bpy`.
 */
import { describe, expect, it } from 'vitest'

import { runPython } from './python.js'

describe('the Blender-only bake scripts', () => {
  it('compile, which catches a bad copy without needing Blender', { timeout: 60_000 }, () => {
    const run = runPython(['-m', 'py_compile', 'tools/bake/crumple.py', 'tools/bake/smoke.py'])
    expect(run).not.toBeInstanceOf(Error)
    if (run instanceof Error) return
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })
})
