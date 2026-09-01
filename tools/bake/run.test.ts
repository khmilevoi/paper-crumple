/**
 * The Blender launcher's pure parts: which binary, which argv. **No Blender is started here** —
 * a real bake is 4 m 10 s of single-threaded wall time and is never a CI dependency (spec 13).
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { DEFAULT_BLENDER, blenderArgs, blenderPath } from './run.mjs'

const thisFile = fileURLToPath(import.meta.url)

describe('which Blender runs', () => {
  it('takes $BLENDER over the hard-coded Steam path', () => {
    expect(blenderPath({ BLENDER: thisFile })).toBe(thisFile)
  })

  it('returns an Error, never throws, when the named binary is missing', () => {
    const missing = blenderPath({ BLENDER: 'C:/nowhere/blender.exe' })
    expect(missing).toBeInstanceOf(Error)
    if (!(missing instanceof Error)) return
    expect(missing.message).toMatch(/nowhere/)
    expect(missing.message).toMatch(/BLENDER=/)
  })

  it('treats an empty or whitespace $BLENDER as unset', () => {
    const blank = blenderPath({ BLENDER: '   ' })
    // The Steam default almost certainly does not exist on this machine; either way the point is
    // that the empty value was not used as a path.
    if (blank instanceof Error) expect(blank.message).toContain('Steam')
    else expect(blank).toBe(DEFAULT_BLENDER)
  })

  it('defaults to the Steam 5.2 install, never a 4.x path', () => {
    expect(DEFAULT_BLENDER).toMatch(/Steam\/steamapps\/common\/Blender\/blender\.exe$/)
    expect(DEFAULT_BLENDER).not.toMatch(/4\.5/)
  })
})

describe('the argv', () => {
  it('is headless, single-threaded, and turns a Python exception into exit code 1', () => {
    expect(blenderArgs('tools/bake/crumple.py', ['--bucket', '2x3'])).toEqual([
      '-b',
      '-t',
      '1',
      '--python-exit-code',
      '1',
      '-P',
      'tools/bake/crumple.py',
      '--',
      '--bucket',
      '2x3',
    ])
  })

  it('keeps -t 1, which is what makes two bakes byte-identical', () => {
    const argv = blenderArgs('tools/bake/smoke.py')
    expect(argv.slice(0, 5)).toEqual(['-b', '-t', '1', '--python-exit-code', '1'])
    expect(argv.at(-1)).toBe('--')
  })
})
