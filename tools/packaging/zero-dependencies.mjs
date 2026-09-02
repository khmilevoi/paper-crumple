import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * @typedef {object} PackageEntry
 * @property {string} dir the directory name under packages/
 * @property {Record<string, unknown>} manifest its parsed package.json
 */

/**
 * The zero-dependency rule of spec 14, as data in and messages out.
 *
 * Two separate rules. Nothing published or private may carry a runtime dependencies entry - the
 * family is zero-dependency by design and a transitive install is how a duplicate core gets into a
 * graph (spec 10.4). And a *published* package must spell the empty object out, because a check
 * that accepts an absent key cannot tell "deliberately none" from "someone deleted the field".
 *
 * @param {PackageEntry[]} entries every workspace package
 * @returns {string[]} one message per violation; empty when clean
 */
export function findDependencyViolations(entries) {
  /** @type {string[]} */
  const failures = []

  for (const { manifest } of [...entries].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const name = typeof manifest.name === 'string' ? manifest.name : '<unnamed>'
    const declared = manifest.dependencies
    const isPrivate = manifest.private === true

    if (declared === undefined) {
      if (!isPrivate) {
        failures.push(
          `${name} has no "dependencies" key; write "dependencies": {} explicitly (spec 14)`,
        )
      }
      continue
    }

    const names = Object.keys(/** @type {Record<string, string>} */ (declared))
    if (names.length > 0) failures.push(`${name} declares dependencies: ${names.join(', ')}`)
  }

  return failures
}

/** Reads every packages/package.json and reports. Never throws (spec 10.8). */
function main() {
  /** @type {PackageEntry[]} */
  const entries = []
  const packages = join(ROOT, 'packages')

  for (const dir of readdirSync(packages, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const path = join(packages, dir.name, 'package.json')
    try {
      entries.push({ dir: dir.name, manifest: JSON.parse(readFileSync(path, 'utf8')) })
    } catch (cause) {
      console.error(`could not read ${path}: ${String(cause)}`)
      process.exitCode = 1
      return
    }
  }

  const failures = findDependencyViolations(entries)
  for (const failure of failures) console.error(`✗ ${failure}`)

  if (failures.length > 0) {
    process.exitCode = 1
    return
  }
  console.log(`✓ ${entries.length} workspace packages, zero runtime dependencies`)
}

main()
