import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('keeps adapter imports out of the CPU and browser observer registries', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./loader.mjs', import.meta.url).href,
      '--input-type=module',
      '--eval',
      `
      import { registerHooks } from 'node:module'
      const imports = []
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.includes('@reatom/core') || specifier.includes('@paper-crumple/reatom') ||
            specifier.includes('packages/reatom/')) imports.push(specifier)
        return next(specifier, context)
      } })
      const Native = globalThis.BroadcastChannel
      const channels = []
      globalThis.BroadcastChannel = class extends Native {
        constructor(...args) { super(...args); channels.push(this) }
      }
      try {
        await import('./tools/bench/cpu/reactivity.mjs')
        await import('./tools/bench/smooth/reactivity.ts')
        console.log(JSON.stringify(imports))
      } finally {
        globalThis.BroadcastChannel = Native
        for (const channel of channels) channel.close()
      }
    `,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 },
  )
  expect(probe.status, probe.stderr || String(probe.error)).toBe(0)
  expect(JSON.parse(probe.stdout)).toEqual([])
})

it('measures identical draws with opt-in subscriptions and disconnects every observer', () => {
  const probe = spawnSync(
    process.execPath,
    [
      '--import',
      new URL('./loader.mjs', import.meta.url).href,
      '--input-type=module',
      '--eval',
      `
      import { reactivityScenarios } from './tools/bench/cpu/reactivity.mjs'
      const rows = []
      for (const scenario of reactivityScenarios) {
        const c = await scenario.setup()
        scenario.prepare(c)
        const before = c.observation.snapshot()
        await scenario.op(c)
        const after = c.observation.snapshot()
        const poses = c.views.map(view => view.pose)
        const draws = c.motion.calls.draw.length
        c.observation.disconnect()
        const sharedAliveAfterDisconnect = !c.motion.disposed && !c.sheet.disposed
        scenario.teardown(c)
        rows.push({ name: scenario.name, before, after, poses, draws,
          sharedAliveAfterDisconnect,
          cleanup: c.observation.snapshot(), disposed: c.motion.disposed && c.sheet.disposed })
      }
      console.log(JSON.stringify(rows))
    `,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 20000 },
  )
  expect(probe.status, probe.stderr || String(probe.error)).toBe(0)
  const rows = JSON.parse(probe.stdout)
  expect(rows.map((row: { name: string }) => row.name)).toEqual([
    'reactivity-raw',
    'reactivity-semantic',
    'reactivity-progress',
  ])
  for (const [index, row] of rows.entries()) {
    expect(row.after.activeStepSubscriptions).toBe(index === 2 ? 64 : 0)
    expect(row.after.activeSemanticSubscriptions).toBe(index === 0 ? 0 : 64 * 3)
    expect(row.after.semanticPublications - row.before.semanticPublications).toBe(0)
    expect(row.after.frameReads - row.before.frameReads).toBe(0)
    expect(row.after.progressPublications - row.before.progressPublications).toBe(
      index === 2 ? 64 : 0,
    )
    expect(row.poses).toEqual(rows[0].poses)
    expect(row.draws).toBe(rows[0].draws)
    expect(row.cleanup.activeStepSubscriptions).toBe(0)
    expect(row.cleanup.activeSemanticSubscriptions).toBe(0)
    expect(row.disposed).toBe(true)
    expect(row.sharedAliveAfterDisconnect).toBe(true)
  }
})
