/**
 * The node half of the GL bench: two vitest browser commands.
 *
 * - `benchWrite` merges one file's scenarios into `BENCH_OUT` (one JSON per run, keyed by
 *   scenario name; a stale file from an earlier run is replaced, not merged) and prints the table.
 * - `benchProfile` starts and stops Chromium's sampling CPU profiler through Playwright's CDP
 *   session and writes the `.cpuprofile` beside the results. `profile-rank.mjs` ranks it.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CDPSession } from 'playwright'
import type { BrowserCommand } from 'vitest/node'
import type { BenchFile, BenchMeta, ScenarioResult } from './types.js'

function ms(x: number | undefined): string {
  return x !== undefined && Number.isFinite(x) ? x.toFixed(2).padStart(9) : '        -'
}

function table(scenarios: readonly ScenarioResult[]): string {
  const lines = [
    '',
    `${'scenario'.padEnd(28)} ${'call med'.padStart(9)} ${'call min'.padStart(9)} ${'finish'.padStart(9)} ${'gpu'.padStart(9)}  extra`,
  ]
  for (const s of scenarios) {
    const extra = Object.entries(s.extra ?? {})
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
      .join(' ')
    lines.push(
      `${s.name.padEnd(28)} ${ms(s.callMs.median)} ${ms(s.callMs.min)} ${ms(s.finishMs.median)} ${ms(s.gpuMs?.median)}  ${extra}`,
    )
  }
  return lines.join('\n') + '\n\n'
}

export function benchCommands(o: { outPath: string; profileDir: string; runId: string }): {
  benchWrite: BrowserCommand<[ScenarioResult[], BenchMeta]>
  benchProfile: BrowserCommand<['start' | 'stop', string]>
} {
  const sessions = new Map<string, CDPSession>()

  const benchWrite: BrowserCommand<[ScenarioResult[], BenchMeta]> = (_ctx, scenarios, meta) => {
    mkdirSync(dirname(o.outPath), { recursive: true })
    let previous: readonly ScenarioResult[] = []
    try {
      const file = JSON.parse(readFileSync(o.outPath, 'utf8')) as BenchFile
      if (file.runId === o.runId) previous = file.scenarios
    } catch {
      // First write of this run, or no file yet.
    }
    const byName = new Map(previous.map((s) => [s.name, s] as const))
    for (const s of scenarios) byName.set(s.name, s)
    const file: BenchFile = { runId: o.runId, meta, scenarios: [...byName.values()] }
    writeFileSync(o.outPath, JSON.stringify(file, null, 2) + '\n')
    process.stdout.write(table(scenarios))
    return o.outPath
  }

  const benchProfile: BrowserCommand<['start' | 'stop', string]> = async (ctx, action, label) => {
    if (action === 'start') {
      const session = await ctx.context.newCDPSession(ctx.page)
      await session.send('Profiler.enable')
      await session.send('Profiler.setSamplingInterval', { interval: 100 })
      await session.send('Profiler.start')
      sessions.set(label, session)
      return undefined
    }
    const session = sessions.get(label)
    if (session === undefined) return undefined
    const { profile } = await session.send('Profiler.stop')
    await session.detach()
    sessions.delete(label)
    mkdirSync(o.profileDir, { recursive: true })
    const path = join(o.profileDir, `${label}.cpuprofile`)
    writeFileSync(path, JSON.stringify(profile))
    return path
  }

  return { benchWrite, benchProfile }
}
