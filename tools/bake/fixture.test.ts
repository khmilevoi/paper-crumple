/**
 * The Python half of the cross-language contract (spec 9.2, 11).
 *
 * `pack.py --fixture` re-writes `tiny.json` / `tiny.bin` into a temporary directory, and both
 * files must come out byte-identical to the pair committed under `packages/motion/test/fixtures/`
 * — the same pair `parsePack` is tested against. The twin's half of the check is in
 * `packWriter.test.ts`; between them, three producers agree on one set of bytes.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  TINY_BIN_BYTES,
  TINY_JSON_BYTES,
  readTinyBin,
  readTinyJsonBytes,
} from '../../packages/motion/test/fixture.js'
import { firstDifference } from './bytes.js'
import { runPython } from './python.js'

describe('pack.py --fixture reproduces the committed fixture', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'crmp-fixture-'))
    const run = runPython(['tools/bake/pack.py', '--fixture', dir])
    expect(run).not.toBeInstanceOf(Error)
    if (run instanceof Error) return
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('writes a 320-byte binary identical to packages/motion/test/fixtures/tiny.bin', () => {
    const written = new Uint8Array(readFileSync(join(dir, 'tiny.bin')))
    const committed = new Uint8Array(readTinyBin())
    expect(written.length).toBe(TINY_BIN_BYTES)
    expect(written.length).toBe(320)
    expect(firstDifference(written, committed)).toBe(-1)
  })

  it('writes a 653-byte manifest identical to packages/motion/test/fixtures/tiny.json', () => {
    const written = new Uint8Array(readFileSync(join(dir, 'tiny.json')))
    const committed = readTinyJsonBytes()
    // Spec 9.2 says 709 B; the committed manifest is 653 B and this run is what produced it.
    expect(written.length).toBe(TINY_JSON_BYTES)
    expect(written.length).toBe(653)
    expect(firstDifference(written, committed)).toBe(-1)
  })

  it('writes LF only, so a Windows checkout cannot make the check fail as a codec bug', () => {
    const written = new Uint8Array(readFileSync(join(dir, 'tiny.json')))
    expect(written.includes(0x0d)).toBe(false)
    // json.dumps(...) + '\n' — the trailing newline is part of the contract.
    expect(written[written.length - 1]).toBe(0x0a)
  })

  it('is deterministic: a second run produces the same bytes', () => {
    const second = mkdtempSync(join(tmpdir(), 'crmp-fixture-'))
    try {
      const run = runPython(['tools/bake/pack.py', '--fixture', second])
      expect(run).not.toBeInstanceOf(Error)
      if (run instanceof Error) return
      expect(run.status).toBe(0)
      const a = new Uint8Array(readFileSync(join(dir, 'tiny.bin')))
      const b = new Uint8Array(readFileSync(join(second, 'tiny.bin')))
      expect(firstDifference(a, b)).toBe(-1)
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  })
})
