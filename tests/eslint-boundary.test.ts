import { ESLint, type Linter } from 'eslint'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { boundaryFiles } from '../eslint.boundaries.js'
import { makeEslintConfig, NO_THROW_MESSAGE } from '../eslint.config.js'

const cwd = fileURLToPath(new URL('../', import.meta.url))
const THROWING_SOURCE = "export function boom(): void {\n  throw new Error('boom')\n}\n"

async function lint(code: string, filePath: string, overrideConfig?: Linter.Config[]) {
  const eslint =
    overrideConfig === undefined
      ? new ESLint({ cwd })
      : new ESLint({ cwd, overrideConfigFile: true, overrideConfig })
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false })
  return result!
}

describe('the no-throw rule (§10.8)', () => {
  it('reports a throw in package source with the message that names the escape hatch', async () => {
    const result = await lint(THROWING_SOURCE, 'packages/core/src/scratch.ts')
    const throwErrors = result.messages.filter((m) => m.ruleId === 'no-restricted-syntax')
    expect(throwErrors).toHaveLength(1)
    expect(throwErrors[0]!.message).toBe(NO_THROW_MESSAGE)
    expect(throwErrors[0]!.severity).toBe(2)
  })

  it('reports a throw in a test file too — the convention is not relaxed there', async () => {
    const result = await lint(THROWING_SOURCE, 'tests/scratch.test.ts')
    expect(result.messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true)
  })
})

describe('the boundary allowlist', () => {
  it('turns the rule off for a file it names, and only for that file', async () => {
    const config = makeEslintConfig(['packages/core/src/allowed.ts']) as Linter.Config[]
    const allowed = await lint(THROWING_SOURCE, 'packages/core/src/allowed.ts', config)
    const forbidden = await lint(THROWING_SOURCE, 'packages/core/src/other.ts', config)
    expect(allowed.messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(0)
    expect(forbidden.messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(1)
  })

  it('exists as an array P2 can fill without touching the config', () => {
    expect(Array.isArray(boundaryFiles)).toBe(true)
  })
})
