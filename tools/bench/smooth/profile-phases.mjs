/**
 * Where the main thread went during one profiled storm — the phase table the smoothness bench's
 * report is built on, from the `.cpuprofile` `BENCH_PROFILE=1 pnpm bench:smooth` writes.
 *
 *     node tools/bench/smooth/profile-phases.mjs tools/bench/out/profiles/smooth.burst.dpr1.cpuprofile [top]
 *
 * Node only, no dependencies. Busy time is the profile's total minus `(idle)`. A phase's time is
 * inclusive — every sample with a matching frame anywhere on its stack, counted once — so the
 * indented sub-phases nest inside their parent, and the top-level phases are disjoint by
 * construction (a sample is credited to the first top-level phase that matches, top down);
 * `other` is what no phase claimed. The self-time ranking below it is the one
 * `tools/bench/gl/profile-rank.mjs` prints in full, cut to the top N.
 */
import { readFileSync } from 'node:fs'

const [file, topArg] = process.argv.slice(2)
if (file === undefined) {
  process.stderr.write('usage: profile-phases.mjs <file.cpuprofile> [top]\n')
  process.exit(2)
}
const top = Number(topArg ?? 15)
const profile = JSON.parse(readFileSync(file, 'utf8'))

const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)

const shortUrl = (url) =>
  url
    .replace(/\\/g, '/')
    .replace(/^.*\/@fs\//, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\?.*$/, '')
    .replace(/^.*\/(packages|tools)\//, '$1/')
const frameOf = (n) => ({
  name: n.callFrame.functionName || '(anonymous)',
  url: shortUrl(n.callFrame.url ?? ''),
  line: n.callFrame.lineNumber + 1,
})

// Stack per node id, root first, computed once.
const stacks = new Map()
function stackOf(id) {
  let s = stacks.get(id)
  if (s !== undefined) return s
  const p = parent.get(id)
  s = p === undefined ? [frameOf(nodes.get(id))] : [...stackOf(p), frameOf(nodes.get(id))]
  stacks.set(id, s)
  return s
}

const inPaper = (f) => /paper\/dist/.test(f.url)
const inCore = (f) => /core\/dist/.test(f.url)
const inMotion = (f) => /motion\/dist/.test(f.url)
const named = (re, where) => (f) => re.test(f.name) && (where === undefined || where(f))

/**
 * Top-level phases are disjoint: a sample goes to the first one whose matcher hits any frame on
 * its stack. Sub-phases (indented) are counted within their parent only.
 */
// The names are the dist bundles' own (tsdown keeps function names); a native binding shows up
// as a frame with no url (`readPixels`, `getError`, `texSubImage2D`), so the self-time ranking
// below is where a sync GPU-process round trip is visible by name.
const PHASES = [
  {
    name: 'source (sheet.source: upload, resample, JFA, readPixels, contours, hull)',
    match: named(/^source$/, inPaper),
    sub: [
      {
        name: 'upload / resample (createResampler, resample, uploadVia*)',
        match: named(/^(createResampler|resample|uploadVia[A-Za-z]*|uploadBytes)$/, inPaper),
      },
      {
        name: 'field / JFA (computeSdf, signedDistanceField, encode/decodeField)',
        match: named(
          /^(computeSdf|signedDistanceField|cpuSdfFromAlpha|encodeField|decodeField|downsampleField|sampleField|cpuFieldFallback)$/,
          inPaper,
        ),
      },
      { name: 'readBackField (the sync readPixels)', match: named(/^readBackField$/) },
      {
        name: 'contours (extractContours, collectCandidates, simplify*)',
        match: named(/[cC]ontour|collectCandidates|^simplify/, inPaper),
      },
      {
        name: 'hull (buildHull, hullBounds, fillHullMask, rasterizeHull, measureHull)',
        match: named(/[hH]ull/, inPaper),
      },
    ],
  },
  { name: 'build (sheet.build: the front render)', match: named(/^build$/, inPaper), sub: [] },
  {
    name: 'stage add glue (buildSprite, resource, resourceFront, rebuildFront)',
    match: named(/^(buildSprite|resource|resourceFront|rebuildFront)$/, inCore),
    sub: [],
  },
  {
    name: 'decode (urlSource, blobSource, bitmapSource, decodeBitmap)',
    match: named(
      /^(urlSource|blobSource|bitmapSource|elementSource|supplierSource|decodeBitmap|classifySource|normalizeSource)$/,
      inCore,
    ),
    sub: [],
  },
  {
    name: 'draw (motion.draw, drawInto)',
    match: (f) => named(/^draw$/, inMotion)(f) || named(/^drawInto$/, inCore)(f),
    sub: [],
  },
  {
    name: 'blit (blitOut, blitPlan: drawImage, getBoundingClientRect)',
    match: named(/^(blitOut|blitPlan)$/, inCore),
    sub: [],
  },
  {
    name: 'step / scheduler (stepOnce, runSteps, emit, settledRun, adoptImmediately)',
    match: named(/^(stepOnce|runSteps|emit|settledRun|adoptImmediately)$/, inCore),
    sub: [],
  },
]

const self = new Map()
let total = 0
let idle = 0
let gc = 0
let program = 0
const phaseUs = PHASES.map((p) => ({ us: 0, sub: p.sub.map(() => 0) }))
let otherUs = 0
const { samples, timeDeltas } = profile
for (let i = 0; i < samples.length; i++) {
  const d = Math.max(0, timeDeltas[i] ?? 0)
  const id = samples[i]
  total += d
  self.set(id, (self.get(id) ?? 0) + d)
  const leaf = frameOf(nodes.get(id))
  if (leaf.name === '(idle)') {
    idle += d
    continue
  }
  if (leaf.name === '(garbage collector)') gc += d
  if (leaf.name === '(program)') program += d
  const stack = stackOf(id)
  let claimed = false
  for (let p = 0; p < PHASES.length && !claimed; p++) {
    if (!stack.some(PHASES[p].match)) continue
    claimed = true
    phaseUs[p].us += d
    PHASES[p].sub.forEach((s, k) => {
      if (stack.some(s.match)) phaseUs[p].sub[k] += d
    })
  }
  if (!claimed) otherUs += d
}

const busy = total - idle
const line = (label, us, of = busy) =>
  `${(us / 1000).toFixed(1).padStart(9)} ms ${((100 * us) / Math.max(1, of)).toFixed(1).padStart(5)} %  ${label}\n`
process.stdout.write(`profile ${file}\n`)
process.stdout.write(
  `total ${(total / 1000).toFixed(1)} ms, idle ${(idle / 1000).toFixed(1)} ms, busy ${(busy / 1000).toFixed(1)} ms (100 %)\n\n`,
)
process.stdout.write('main-thread phases (inclusive, disjoint at the top level; % of busy)\n')
PHASES.forEach((p, i) => {
  process.stdout.write(line(p.name, phaseUs[i].us))
  p.sub.forEach((s, k) => process.stdout.write(line(`    ${s.name}`, phaseUs[i].sub[k])))
})
process.stdout.write(line('other', otherUs))
process.stdout.write(line('  of which (garbage collector) — self, any phase', gc))
process.stdout.write(line('  of which (program) — self, any phase', program))

const bySelf = new Map()
for (const [id, us] of self) {
  const f = frameOf(nodes.get(id))
  const key = `${f.name}  ${f.url === '' ? '' : `${f.url}:${f.line}`}`
  bySelf.set(key, (bySelf.get(key) ?? 0) + us)
}
process.stdout.write(`\ntop ${top} by self time (% of busy)\n`)
for (const [k, us] of [...bySelf].sort((a, b) => b[1] - a[1]).slice(0, top)) {
  process.stdout.write(line(k, us))
}
