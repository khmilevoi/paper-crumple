import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = join(root, 'node_modules', 'typescript-5.0', 'lib', 'tsc.js')
const project = join(root, 'tsconfig.ts50.json')

describe('the TypeScript 5.0 floor (§6.8)', () => {
  it('has the pinned compiler installed', () => {
    expect(
      existsSync(compiler),
      'run `pnpm install` — typescript-5.0 is a root devDependency',
    ).toBe(true)
  })

  it('type-checks and emits declarations for every published package on 5.0 exactly', () => {
    // The failure this guards is consumer-visible rather than author-visible: `const` type
    // parameters are emitted verbatim into `.d.ts`, and on a compiler below the floor that is
    // TS1139, which kills the whole declaration file — a consumer who never calls `knobs()`
    // still gets nothing. `peerDependencies` already declares `"typescript": ">=5.0"`; this is
    // the assertion that the claim is true.
    const out = mkdtempSync(join(tmpdir(), 'paper-crumple-ts50-'))
    const result = spawnSync(process.execPath, [compiler, '-p', project, '--outDir', out], {
      cwd: root,
      encoding: 'utf8',
    })
    rmSync(out, { recursive: true, force: true })
    expect(`${result.stdout}${result.stderr}`).toBe('')
    expect(result.status).toBe(0)
  }, 120_000)
})
