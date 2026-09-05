/**
 * Ranks a `.cpuprofile` (V8 / Chrome DevTools format, as `run.mjs --profile` writes it) by self
 * time per function, with the inclusive ("total") time beside it.
 *
 *   node tools/bench/cpu/profile-summary.mjs tools/bench/out/prof/cpu.hull.1024.cpuprofile [--top 30]
 *
 * Paths are shortened to `packages/...` or `tools/...`; V8's own frames ("(garbage collector)",
 * "(program)") are kept, since a large "(garbage collector)" row IS a finding.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const topAt = args.indexOf('--top')
const top = topAt >= 0 ? Number(args[topAt + 1]) : 25
if (file === undefined) {
  process.stderr.write('usage: profile-summary.mjs <file.cpuprofile> [--top N]\n')
  process.exit(2)
}

const profile = JSON.parse(readFileSync(file, 'utf8'))
const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const parentOf = new Map()
for (const n of profile.nodes) for (const child of n.children ?? []) parentOf.set(child, n.id)

function shortUrl(url) {
  if (!url) return ''
  const s = url.replace(/\\/g, '/')
  const at = s.search(/\/(packages|tools)\//)
  return at >= 0 ? s.slice(at + 1) : s.replace(/^file:\/\/\/?/, '')
}

function keyOf(node) {
  const f = node.callFrame
  const name = f.functionName || '(anonymous)'
  const url = shortUrl(f.url)
  return url ? `${name}  ${url}:${f.lineNumber + 1}` : name
}

const selfUs = new Map()
const totalUs = new Map()
let sumUs = 0
const samples = profile.samples ?? []
const deltas = profile.timeDeltas ?? []
for (let i = 0; i < samples.length; i++) {
  const dt = Math.max(0, deltas[i] ?? 0)
  sumUs += dt
  const node = nodes.get(samples[i])
  if (node === undefined) continue
  const k = keyOf(node)
  selfUs.set(k, (selfUs.get(k) ?? 0) + dt)
  // Inclusive: credit each distinct function on the stack once.
  const seen = new Set()
  for (let id = node.id; id !== undefined; id = parentOf.get(id)) {
    const n = nodes.get(id)
    if (n === undefined) break
    const kk = keyOf(n)
    if (seen.has(kk)) continue
    seen.add(kk)
    totalUs.set(kk, (totalUs.get(kk) ?? 0) + dt)
  }
}

const rows = [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
const pct = (us) => `${((100 * us) / Math.max(1, sumUs)).toFixed(1)}%`.padStart(6)
const ms = (us) => `${(us / 1000).toFixed(1)}`.padStart(9)
process.stdout.write(
  `total sampled: ${(sumUs / 1000).toFixed(1)} ms over ${samples.length} samples\n`,
)
process.stdout.write(
  `${'self ms'.padStart(9)} ${'self%'.padStart(6)} ${'total ms'.padStart(9)} ${'total%'.padStart(6)}  function  file:line\n`,
)
for (const [k, us] of rows) {
  const t = totalUs.get(k) ?? us
  process.stdout.write(`${ms(us)} ${pct(us)} ${ms(t)} ${pct(t)}  ${k}\n`)
}
