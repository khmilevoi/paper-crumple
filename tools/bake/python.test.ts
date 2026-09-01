import { describe, expect, it } from 'vitest'

import { pythonExecutable, runPython } from './python.js'

describe('the Python interpreter the bake tools need', () => {
  it('is on PATH as python3 or python, or named by $PYTHON', () => {
    const exe = pythonExecutable()
    // A skip here would mean the cross-language check silently never runs (spec 11).
    expect(exe).not.toBeInstanceOf(Error)
    expect(typeof exe).toBe('string')
  })
})

describe('pack.py', () => {
  it('passes its own unit tests, run outside Blender', { timeout: 120_000 }, () => {
    const run = runPython([
      '-m',
      'unittest',
      'discover',
      '-s',
      'tools/bake',
      '-p',
      'test_*.py',
      '-v',
    ])
    expect(run).not.toBeInstanceOf(Error)
    if (run instanceof Error) return
    // unittest reports on stderr; the count is asserted so a silently un-discovered module fails.
    expect(run.stderr).toMatch(/Ran 10 tests/)
    expect(run.stderr).toMatch(/\nOK\b/)
    expect(run.status).toBe(0)
  })
})
