import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8')
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T

interface RootManifest {
  private?: boolean
  packageManager?: string
  engines?: Record<string, string>
  devEngines?: { runtime?: { name: string; version: string; onFail: string } }
}

describe('.gitattributes', () => {
  it('marks .bin files binary so a Windows checkout cannot CRLF-mangle a pack', () => {
    expect(read('.gitattributes')).toMatch(/^\*\.bin binary$/m)
  })

  it('normalises text to LF in the working tree as well as in the index', () => {
    expect(read('.gitattributes')).toMatch(/^\* text=auto eol=lf$/m)
  })

  it('marks the image formats the tiles ship in as binary too', () => {
    const attributes = read('.gitattributes')
    expect(attributes).toMatch(/^\*\.png binary$/m)
    expect(attributes).toMatch(/^\*\.webp binary$/m)
  })
})

describe('the root manifest', () => {
  const rootManifest = readJson<RootManifest>('package.json')

  it('is private, so it can never be published by accident', () => {
    expect(rootManifest.private).toBe(true)
  })

  it('pins the package manager with its integrity hash', () => {
    expect(rootManifest.packageManager).toMatch(/^pnpm@10\.14\.0\+sha512\.[0-9a-f]{128}$/)
  })

  it("carries the toolchain's real Node floor in devEngines, not in engines", () => {
    expect(rootManifest.devEngines).toEqual({
      runtime: { name: 'node', version: '^22.18.0 || >=24.11.0', onFail: 'error' },
    })
    expect(rootManifest.engines).toBeUndefined()
  })
})
