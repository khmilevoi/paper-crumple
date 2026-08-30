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
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
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

  it('maps each test tier to its own script, so level 2 cannot be silently dropped', () => {
    const scripts = rootManifest.scripts ?? {}
    // Level 1 pulls no browser; the type tier runs beside it (spec 11.1).
    expect(scripts.test).toBe('vitest run --project unit --project types')
    expect(scripts['test:types']).toBe('vitest run --project types')
    // Vitest never installs a browser, so the level-2 script installs one first.
    expect(scripts['test:gl']).toBe(
      'playwright install --no-shell chromium && vitest run --project gl',
    )
    // `check` is everything CI runs, level 2 included. Build is deliberately not in it.
    expect(scripts.check).toBe(
      'pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm test:gl',
    )
    expect(scripts.check).not.toMatch(/pnpm build/)
  })

  it('pins the whole level-2 toolchain exactly, because this tier asserts byte identity', () => {
    const dev = rootManifest.devDependencies ?? {}
    // A floating browser is an unpinned input to a byte comparison (spec 11.1).
    expect(dev.vitest).toBe('4.1.11')
    expect(dev['@vitest/browser-playwright']).toBe('4.1.11')
    expect(dev.playwright).toBe('1.62.1')
  })
})
