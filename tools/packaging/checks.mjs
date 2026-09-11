/**
 * The pure half of the packaging gate: data in, failure messages out. Everything that touches the
 * filesystem or spawns a process lives in `verify-packaging.mjs`, so every rule here is unit-
 * testable without a build.
 */

/** The one docs URL all three manifests and all three READMEs point at (spec 14, amendment 26). */
export const DOCS_URL =
  'https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme'

/** Spec 14's settled tile budget. P10 shipped 333 344 B against it. */
export const TILE_BUDGET_BYTES = 397_478

/** The three buckets, each one module and one export subpath (spec 3.2, 14). */
export const BUCKETS = /** @type {const} */ (['2x3', '1x1', '3x2'])

/** Always in a tarball on top of `files: ["dist"]`, because npm adds them. */
const ALWAYS = ['package/package.json', 'package/LICENSE', 'package/README.md']

/**
 * tsdown emits shared chunks with a content hash in the name. The hash changes on every rebuild,
 * so the check allows the shape and never the spelling.
 */
const CHUNK = /^package\/dist\/[\w-]+-[A-Za-z0-9_-]{8}\.(?:js|js\.map|d\.ts)$/

/**
 * @typedef {object} PackageSpec
 * @property {string} dir directory under `packages/`
 * @property {string} name published name
 * @property {readonly string[]} required entries that must be present, verbatim
 * @property {readonly string[]} subpaths the exports map's keys, in order
 */

const entryTriple = (/** @type {string} */ base) => [
  `package/dist/${base}.js`,
  `package/dist/${base}.js.map`,
  `package/dist/${base}.d.ts`,
]

/**
 * The four published packages. The fourth is `@paper-crumple/react`, the React binding; there is
 * still no bundle package, because amendment 23 cancelled it.
 */
export const PACKAGES = /** @type {readonly PackageSpec[]} */ ([
  {
    dir: 'core',
    name: '@paper-crumple/core',
    subpaths: ['.', './unstable', './bindings'],
    required: [
      ...ALWAYS,
      ...entryTriple('index'),
      ...entryTriple('unstable'),
      ...entryTriple('bindings'),
    ],
  },
  {
    dir: 'paper',
    name: '@paper-crumple/paper',
    subpaths: ['.', './tiles'],
    required: [
      ...ALWAYS,
      ...entryTriple('index'),
      ...entryTriple('tiles'),
      'package/dist/tiles/crumple-r.webp',
      'package/dist/tiles/crumple-g.webp',
      'package/dist/tiles/crumple-a.webp',
      'package/dist/tiles/fibre-a.webp',
    ],
  },
  {
    dir: 'motion',
    name: '@paper-crumple/motion',
    subpaths: ['.', './packs/2x3', './packs/1x1', './packs/3x2'],
    required: [
      ...ALWAYS,
      ...entryTriple('index'),
      ...BUCKETS.flatMap((b) => [...entryTriple(`packs/${b}`), `package/dist/packs/${b}.bin`]),
    ],
  },
  {
    dir: 'react',
    name: '@paper-crumple/react',
    subpaths: ['.', './testing'],
    required: [...ALWAYS, ...entryTriple('index'), ...entryTriple('testing')],
  },
])

/**
 * Spec 14: "Review `pnpm pack --dry-run` output in CI so tarball contents are inspected rather
 * than assumed." Inspection means a list that is asserted, not a list that is printed.
 *
 * @param {PackageSpec} spec
 * @param {readonly string[]} names every entry name in the tarball
 * @returns {string[]}
 */
export function checkEntries(spec, names) {
  /** @type {string[]} */
  const failures = []
  const present = new Set(names)

  for (const required of spec.required) {
    if (!present.has(required)) failures.push(`${spec.name}: missing ${required}`)
  }
  for (const name of names) {
    if (spec.required.includes(name)) continue
    if (CHUNK.test(name)) continue
    failures.push(`${spec.name}: unexpected entry ${name}`)
  }

  return failures
}

/**
 * The major of a plain `x.y.z`, or `undefined` if it is not one. Deliberately not a semver parser:
 * every version and range this gate sees is written by changesets or by pnpm's `workspace:^`
 * expansion, and both emit exactly `x.y.z`.
 *
 * @param {unknown} version
 * @returns {number | undefined}
 */
function majorOf(version) {
  if (typeof version !== 'string') return undefined
  const match = /^(\d+)\.\d+\.\d+$/.exec(version)
  return match === null ? undefined : Number(match[1])
}

/**
 * The published metadata, read out of the packed tarball rather than the source tree — which is
 * the only place `workspace:^` has already become the range a consumer will actually resolve.
 *
 * @param {PackageSpec} spec
 * @param {Record<string, unknown>} manifest the packed `package.json`
 * @returns {string[]}
 */
export function checkPackedManifest(spec, manifest) {
  /** @type {string[]} */
  const failures = []

  const files = manifest.files
  if (JSON.stringify(files) !== '["dist"]') {
    failures.push(`${spec.name}: files is ${JSON.stringify(files)}; expected ["dist"]`)
  }

  if (JSON.stringify(manifest.engines) !== '{"node":">=22"}') {
    failures.push(
      `${spec.name}: engines is ${JSON.stringify(manifest.engines)}; expected {"node":">=22"}`,
    )
  }

  if (manifest.homepage !== DOCS_URL) {
    failures.push(
      `${spec.name}: homepage is ${JSON.stringify(manifest.homepage)}; all three must point at the one docs URL`,
    )
  }

  const deps = Object.keys(/** @type {Record<string, string>} */ (manifest.dependencies ?? {}))
  if (deps.length > 0) {
    failures.push(`${spec.name}: packed dependencies is not empty: ${deps.join(', ')}`)
  }

  const subpaths = Object.keys(/** @type {Record<string, unknown>} */ (manifest.exports ?? {}))
  if (JSON.stringify(subpaths) !== JSON.stringify(spec.subpaths)) {
    failures.push(
      `${spec.name}: exports subpaths are ${JSON.stringify(subpaths)}; expected ${JSON.stringify(spec.subpaths)}`,
    )
  }

  const peers = /** @type {Record<string, string>} */ (manifest.peerDependencies ?? {})
  const corePeer = peers['@paper-crumple/core']
  if (spec.dir === 'core') {
    if (corePeer !== undefined) failures.push(`${spec.name}: must not peer-depend on itself`)
  } else if (corePeer === undefined) {
    failures.push(`${spec.name}: no peerDependencies["@paper-crumple/core"] (spec 10.4)`)
  } else {
    // `fixed` keeps all three on one version, so the major this tarball ships *is* core's major.
    // A caret is not enough on its own: `^0.1.0` is a caret that pins the minor, and a caret on
    // some other major would let a consumer resolve a core the family never released together.
    const shipped = majorOf(/** @type {string} */ (manifest.version))
    const peerMajor = corePeer.startsWith('^') ? majorOf(corePeer.slice(1)) : undefined
    if (shipped === undefined) {
      failures.push(
        `${spec.name}: version is ${JSON.stringify(manifest.version)}; expected a semver version`,
      )
    } else if (peerMajor !== shipped) {
      failures.push(
        `${spec.name}: peerDependencies["@paper-crumple/core"] is ${JSON.stringify(corePeer)}; ` +
          `expected ^${shipped}.x, a caret on the major this tarball ships — ` +
          'spec 14 amendment 24 requires a caret, because minors are additive',
      )
    }
  }

  return failures
}

/**
 * Spec 14.1: "Assert in CI that the built output still literally contains
 * `new URL("./2x3.bin", import.meta.url)`" — rolldown is known to transform the construct, so it
 * can regress on a toolchain upgrade. Checked in the tarball, which is the only artefact a
 * consumer ever runs.
 *
 * @param {readonly {name: string, data: Buffer}[]} entries
 * @returns {string[]}
 */
export function checkPackUrls(entries) {
  /** @type {string[]} */
  const failures = []

  for (const bucket of BUCKETS) {
    const path = `package/dist/packs/${bucket}.js`
    const found = entries.find((e) => e.name === path)
    if (found === undefined) {
      failures.push(`${path} is not in the tarball`)
      continue
    }
    const literal = `new URL("./${bucket}.bin", import.meta.url)`
    if (!found.data.toString('utf8').includes(literal)) {
      failures.push(`${path} no longer contains ${literal}; rolldown rewrote it`)
    }
  }

  return failures
}

/**
 * The tarball side of the tile budget. `tests/tile-budget.test.ts` gates the committed source; this
 * gates what actually ships, and that the two agree — a broken tsdown `copy:` step is exactly how
 * they would stop agreeing.
 *
 * @param {readonly {name: string, size: number, data: Buffer}[]} entries
 * @param {ReadonlyMap<string, Buffer>} sourceBytes keyed by bare file name
 * @returns {string[]}
 */
export function checkTiles(entries, sourceBytes) {
  /** @type {string[]} */
  const failures = []
  const tiles = entries.filter((e) => e.name.startsWith('package/dist/tiles/'))
  let total = 0

  for (const tile of tiles) {
    total += tile.size
    const base = tile.name.slice('package/dist/tiles/'.length)
    const source = sourceBytes.get(base)
    if (source === undefined) {
      failures.push(`${tile.name} has no counterpart in packages/paper/src/tiles/`)
      continue
    }
    if (!source.equals(tile.data)) {
      failures.push(`${tile.name} differs from packages/paper/src/tiles/${base}`)
    }
  }

  if (total > TILE_BUDGET_BYTES) {
    failures.push(`the packed tiles total ${total} B, over spec 14’s ${TILE_BUDGET_BYTES} B budget`)
  }

  return failures
}
