/**
 * The CPU benchmark runner. Kept in the repository, never published (`tools/README.md`).
 *
 *   pnpm bench:cpu                          every scenario, table on stdout, JSON to BENCH_OUT
 *   pnpm bench:cpu -- --filter sdf,hull     scenarios whose name contains any of the terms
 *   pnpm bench:cpu -- --profile             also write a .cpuprofile per scenario (timed loop
 *                                           only) under tools/bench/out/prof/, then summarise
 *                                           one with `node tools/bench/cpu/profile-summary.mjs`
 *   pnpm bench:cpu -- --min-time 3000       longer sampling (ms of timed calls per scenario)
 *   pnpm bench:cpu -- --list                names and notes, nothing runs
 *
 * `BENCH_OUT` (default `tools/bench/out/cpu.json`, gitignored) receives the machine-readable
 * results so two runs can be diffed. Run this with the `bench:cpu` script: it needs the source
 * loader (`--import tools/bench/cpu/loader.mjs`) and `--expose-gc` for the allocation column.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, platform, release } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatTable, runScenario } from './harness.mjs'
import { scenarios } from './scenarios.mjs'
import { callScenarios } from './calls.mjs'
import { TRACKED_CALLS } from './recording-gl.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

function parseArgs(argv) {
  const o = { filter: [], profile: false, list: false, minTimeMs: undefined, out: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--') continue // pnpm forwards its own separator
    if (a === '--filter')
      o.filter = String(argv[++i] ?? '')
        .split(',')
        .filter(Boolean)
    else if (a.startsWith('--filter=')) o.filter = a.slice(9).split(',').filter(Boolean)
    else if (a === '--profile') o.profile = true
    else if (a === '--list') o.list = true
    else if (a === '--min-time') o.minTimeMs = Number(argv[++i])
    else if (a.startsWith('--min-time=')) o.minTimeMs = Number(a.slice(11))
    else if (a === '--out') o.out = String(argv[++i])
    else if (a.startsWith('--out=')) o.out = a.slice(6)
    else {
      process.stderr.write(`bench:cpu: unknown argument ${a}\n`)
      process.exitCode = 2
      return null
    }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
if (args === null) process.exit()

const matches = (s) => args.filter.length === 0 || args.filter.some((f) => s.name.includes(f))
const selected = scenarios.filter(matches)
const selectedCalls = callScenarios.filter(matches)

if (args.list) {
  for (const s of [...selected, ...selectedCalls]) {
    process.stdout.write(`${s.name}\n    ${s.note ?? ''}\n`)
  }
  process.exit()
}
if (selected.length === 0 && selectedCalls.length === 0) {
  process.stderr.write('bench:cpu: no scenario matches the filter\n')
  process.exit(2)
}

const outPath = resolve(repoRoot, args.out ?? process.env.BENCH_OUT ?? 'tools/bench/out/cpu.json')
const profileDir = args.profile ? resolve(repoRoot, 'tools/bench/out/prof') : null
if (typeof globalThis.gc !== 'function') {
  process.stderr.write('bench:cpu: run with --expose-gc for the alloc/op column\n')
}

const results = []
for (const s of selected) {
  process.stderr.write(`  ${s.name} ...\n`)
  const r = await runScenario(s, {
    profileDir,
    ...(args.minTimeMs === undefined ? {} : { minTimeMs: args.minTimeMs }),
  })
  results.push(r)
}

if (results.length > 0) process.stdout.write(`${formatTable(results)}\n`)

// GL call counts per operation (`calls.*`): the real slots against the recording context.
const calls = []
// A slot's `nextTurn()` parks on an unref'd `MessageChannel` under Node (`next-turn.ts`), so a
// scenario whose only pending work is that turn would let the process exit mid-await; an interval
// holds the loop open for exactly as long as the scenarios run.
const keepAlive = setInterval(() => {}, 1_000)
try {
  for (const s of selectedCalls) {
    process.stderr.write(`  ${s.name} ...\n`)
    const counts = await s.run()
    calls.push({ name: s.name, note: s.note ?? null, ...counts })
  }
} finally {
  clearInterval(keepAlive)
}
if (calls.length > 0) {
  const columns = ['captures', 'syncQueries', ...TRACKED_CALLS, 'total', 'ms']
  const short = (c) =>
    c
      .replace('checkFramebufferStatus', 'fbStatus')
      .replace('getShaderParameter', 'shaderParam')
      .replace('getProgramParameter', 'programParam')
      .replace('syncQueries', 'sync')
      .replace('bindFramebuffer', 'bindFb')
      .replace('texSubImage2D', 'texSub')
      .replace('texImage2D', 'texImg')
      .replace('texStorage2D', 'texStore')
      .replace('createTexture', 'newTex')
      .replace('createFramebuffer', 'newFb')
      .replace('drawElements', 'drawEl')
      .replace('drawArrays', 'drawArr')
      .replace('getParameter', 'getParam')
  const rows = []
  for (const c of calls) {
    for (const phase of ['warm', 'cold']) {
      const snap = c[phase]
      if (snap === undefined) continue
      rows.push([
        phase === 'warm' ? c.name : `${c.name}.cold`,
        ...columns.map((k) => (k === 'ms' ? snap.ms.toFixed(1) : String(snap[k] ?? 0))),
      ])
    }
  }
  const head = ['scenario', ...columns.map(short)]
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ')
  process.stdout.write(
    `\nGL calls per operation (recording context; sync = getParameter + isEnabled + getError + ` +
      `fbStatus + shaderParam + programParam + readPixels; captures = captureGlState runs)\n` +
      `${line(head)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n${rows.map(line).join('\n')}\n`,
  )
  for (const c of calls) {
    const sites = c.warm?.sites
    if (sites === undefined) continue
    process.stdout.write(`\ncaptureGlState call sites, ${c.name} (warm):\n`)
    for (const [site, n] of sites) process.stdout.write(`  ${String(n).padStart(4)}  ${site}\n`)
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  options: { filter: args.filter, minTimeMs: args.minTimeMs ?? null, profile: args.profile },
  results,
  calls,
}
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
process.stderr.write(`bench:cpu: wrote ${outPath}\n`)
if (profileDir !== null) process.stderr.write(`bench:cpu: profiles under ${profileDir}\n`)
