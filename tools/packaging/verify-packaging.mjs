import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PACKAGES,
  checkEntries,
  checkPackUrls,
  checkPackedManifest,
  checkTiles,
} from './checks.mjs'
import { readTarEntries } from './tar.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** Inside `node_modules/`, which is already gitignored, so no ignore file needs an entry. */
const OUT = join(ROOT, 'node_modules', '.paper-crumple-packaging')

/** `pnpm` is a shell script on POSIX and a `.cmd` shim on Windows; `shell: true` covers both. */
const run = (
  /** @type {string} */ command,
  /** @type {string[]} */ args,
  /** @type {string} */ cwd,
) => spawnSync(command, args, { cwd, shell: true, encoding: 'utf8', stdio: 'pipe' })

/** @type {string[]} */
const failures = []

function packAll() {
  try {
    rmSync(OUT, { recursive: true, force: true })
    mkdirSync(OUT, { recursive: true })
  } catch (error) {
    failures.push(
      `could not prepare ${OUT}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  for (const spec of PACKAGES) {
    /** @type {ReturnType<typeof run> | undefined} */
    let result
    try {
      result = run('pnpm', ['pack', '--pack-destination', OUT], join(ROOT, 'packages', spec.dir))
    } catch (error) {
      failures.push(
        `${spec.name}: pnpm pack --pack-destination ${OUT} threw: ${error instanceof Error ? error.message : String(error)}`,
      )
      continue
    }
    if (result.status !== 0) {
      failures.push(`pnpm pack failed for ${spec.name}:\n${result.stderr ?? ''}`)
    }
  }
}

/**
 * `pnpm pack` names the tarball after the manifest, deterministically, so the file is found by
 * construction rather than by parsing stdout.
 *
 * @param {import('./checks.mjs').PackageSpec} spec
 * @returns {string | undefined}
 */
function tarballFor(spec) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'packages', spec.dir, 'package.json'), 'utf8'),
    )
    const flat = `${spec.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
    return readdirSync(OUT).includes(flat) ? join(OUT, flat) : undefined
  } catch (error) {
    failures.push(
      `${spec.name}: could not locate its tarball: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

/** The four committed tiles, keyed by bare name, for the byte-identity check. */
function sourceTiles() {
  try {
    const dir = join(ROOT, 'packages', 'paper', 'src', 'tiles')
    return new Map(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name))]))
  } catch (error) {
    failures.push(
      `could not read packages/paper/src/tiles: ${error instanceof Error ? error.message : String(error)}`,
    )
    return new Map()
  }
}

/**
 * Reading and gunzip-ing a tarball can throw on truncated or corrupt bytes; a caller must not
 * crash CI with a bare stack trace over that.
 *
 * @param {string} tarball
 * @returns {import('./tar.mjs').TarEntry[] | undefined}
 */
function readEntries(tarball) {
  try {
    return readTarEntries(readFileSync(tarball))
  } catch (error) {
    failures.push(
      `${tarball}: could not read as a tarball: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

/**
 * @param {Buffer} data
 * @returns {Record<string, unknown> | undefined}
 */
function parseManifest(data) {
  try {
    return JSON.parse(data.toString('utf8'))
  } catch (error) {
    failures.push(
      `could not parse packed package.json: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

function main() {
  packAll()
  if (failures.length > 0) return report()

  const tiles = sourceTiles()

  for (const spec of PACKAGES) {
    const tarball = tarballFor(spec)
    if (tarball === undefined) {
      failures.push(`${spec.name}: no tarball was produced in ${OUT}`)
      continue
    }

    const entries = readEntries(tarball)
    if (entries === undefined) continue
    const names = entries.map((e) => e.name).sort()

    // Spec 14 asks for the pack output to be *reviewed*. Printing it puts it in the CI log; the
    // checks below are what make the review binding.
    console.log(`\n${spec.name} — ${names.length} entries`)
    for (const name of names) console.log(`  ${name}`)

    const packed = entries.find((e) => e.name === 'package/package.json')
    if (packed === undefined) {
      failures.push(`${spec.name}: the tarball has no package.json`)
      continue
    }

    const manifest = parseManifest(packed.data)
    if (manifest === undefined) continue

    failures.push(...checkEntries(spec, names))
    failures.push(...checkPackedManifest(spec, manifest))
    if (spec.dir === 'motion') failures.push(...checkPackUrls(entries))
    if (spec.dir === 'paper') failures.push(...checkTiles(entries, tiles))

    for (const [tool, args] of [
      ['publint', [tarball]],
      ['attw', [tarball, '--profile', 'esm-only']],
    ]) {
      /** @type {ReturnType<typeof spawnSync> | undefined} */
      let result
      try {
        result = spawnSync('pnpm', ['exec', tool, ...args], {
          cwd: ROOT,
          shell: true,
          encoding: 'utf8',
          stdio: 'inherit',
        })
      } catch (error) {
        failures.push(
          `${spec.name}: pnpm exec ${tool} ${args.join(' ')} threw: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      if (result.status !== 0) failures.push(`${spec.name}: ${tool} exited ${result.status}`)
    }
  }

  report()
}

function report() {
  if (failures.length === 0) {
    console.log(`\n✓ ${PACKAGES.length} tarballs verified: entries, manifest, publint, attw`)
    return
  }
  console.error('')
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exitCode = 1
}

main()
