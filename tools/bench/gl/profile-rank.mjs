/**
 * Ranks a Chromium `.cpuprofile` (what `BENCH_PROFILE=1 pnpm bench:gl` writes under
 * `tools/bench/out/profiles/`) by self time, then by inclusive time, then by file.
 *
 *     node tools/bench/gl/profile-rank.mjs tools/bench/out/profiles/gl.e2e.add.1024.cpuprofile [top]
 *
 * Node only, no dependencies. Self time is the sum of the sampling intervals whose sample landed on
 * the node; inclusive time adds every descendant's. `(program)`, `(idle)` and
 * `(garbage collector)` are kept so the reader sees how much of the profile is not JS at all.
 */
import { readFileSync } from 'node:fs'

const [file, topArg] = process.argv.slice(2)
if (file === undefined) {
  process.stderr.write('usage: profile-rank.mjs <file.cpuprofile> [top]\n')
  process.exit(2)
}
const top = Number(topArg ?? 40)
const profile = JSON.parse(readFileSync(file, 'utf8'))

const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

const self = new Map()
const { samples, timeDeltas } = profile
let total = 0
for (let i = 0; i < samples.length; i++) {
  const d = Math.max(0, timeDeltas[i] ?? 0)
  total += d
  self.set(samples[i], (self.get(samples[i]) ?? 0) + d)
}

function location(n) {
  const cf = n.callFrame
  const url = cf.url
    .replace(/^.*\/@fs\//, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\?.*$/, '')
  const name = cf.functionName || '(anonymous)'
  return { name, url, key: `${name} ${url}:${cf.lineNumber + 1}` }
}

const bySelf = new Map()
const byFile = new Map()
const byInclusive = new Map()
for (const [id, us] of self) {
  const n = nodes.get(id)
  const loc = location(n)
  bySelf.set(loc.key, (bySelf.get(loc.key) ?? 0) + us)
  const fkey = loc.url === '' ? `(no url) ${loc.name}` : loc.url
  byFile.set(fkey, (byFile.get(fkey) ?? 0) + us)
  // Inclusive: walk to the root, crediting each distinct frame key once per sample.
  const seen = new Set()
  let cur = id
  while (cur !== undefined) {
    const k = location(nodes.get(cur)).key
    if (!seen.has(k)) {
      seen.add(k)
      byInclusive.set(k, (byInclusive.get(k) ?? 0) + us)
    }
    cur = parent.get(cur)
  }
}

function print(title, map, n) {
  process.stdout.write(`\n${title} (total ${(total / 1000).toFixed(1)} ms)\n`)
  const rows = [...map].sort((a, b) => b[1] - a[1]).slice(0, n)
  for (const [k, us] of rows) {
    process.stdout.write(
      `${(us / 1000).toFixed(2).padStart(9)} ms ${((100 * us) / total).toFixed(1).padStart(5)} %  ${k}\n`,
    )
  }
}

print('self time by function', bySelf, top)
print('inclusive time by function', byInclusive, Math.min(top, 30))
print('self time by file', byFile, 20)
