import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

/** Every directory in the repository except the ones nothing is ever committed into. */
function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      ['node_modules', '.git', 'dist', '.turbo', '.superpowers', '.claude'].includes(entry.name)
    ) {
      continue
    }
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, found)
    else found.push(relative(root, full).split('\\').join('/'))
  }
  return found
}

describe('the workspace glob', () => {
  it('lists packages/* and nothing else, so tools/ stays outside it', () => {
    const workspace = read('pnpm-workspace.yaml')
    expect(workspace).toMatch(/^ {2}- 'packages\/\*'$/m)
    expect(workspace).not.toMatch(/tools/)
    expect(workspace).not.toMatch(/bundle/)
  })

  it('holds exactly four packages: three published and one private tsconfig', () => {
    const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(dirs).toEqual(['core', 'motion', 'paper', 'tsconfig'])
  })

  it('has no bundle package, because amendment 23 cancelled it', () => {
    expect(existsSync(join(root, 'packages/bundle'))).toBe(false)
  })

  it('never uses .npmignore — files: ["dist"] is the whole story', () => {
    expect(walk(root).filter((path) => path.endsWith('.npmignore'))).toEqual([])
  })

  it('keeps tools/ out of the workspace by not making it a package', () => {
    expect(statSync(join(root, 'tools')).isDirectory()).toBe(true)
    expect(existsSync(join(root, 'tools/package.json'))).toBe(false)
  })
})
