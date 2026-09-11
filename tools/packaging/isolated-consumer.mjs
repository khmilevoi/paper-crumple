import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTarEntries } from './tar.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** Import actual packed artifacts in a fresh OS-temp consumer with only its declared peers.
 * No symlinks: Node cannot walk back into the workspace dependency graph.
 * @param {'reatom' | 'react'} adapter
 * @param {string[]} peers
 * @param {string[]} absent
 * @returns {string[]} diagnostics (empty on success)
 */
export function checkIsolatedImport(adapter, peers, absent) {
  const consumer = mkdtempSync(join(tmpdir(), 'paper-crumple-isolation-'))
  const failures = []
  try {
    for (const dir of ['core', adapter]) {
      const packed = spawnSync(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', consumer],
        {
          cwd: join(root, 'packages', dir),
          shell: true,
          encoding: 'utf8',
          timeout: 30_000,
        },
      )
      if (packed.status !== 0) return [`${dir} pack: ${packed.error?.message ?? packed.stderr}`]
      const [{ filename }] = JSON.parse(packed.stdout)
      const destination = join(consumer, 'node_modules', '@paper-crumple', dir)
      for (const entry of readTarEntries(readFileSync(join(consumer, filename)))) {
        const path = resolve(destination, entry.name.replace(/^package\//, ''))
        if (!path.startsWith(destination + sep)) return [`unsafe archive path: ${entry.name}`]
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, entry.data)
      }
    }
    const require = createRequire(join(root, 'packages', adapter, 'package.json'))
    for (const peer of peers) {
      let location = dirname(realpathSync(require.resolve(peer)))
      while (!readManifestName(location, peer)) {
        const parent = dirname(location)
        if (parent === location) return [`cannot locate ${peer} package root`]
        location = parent
      }
      cpSync(location, join(consumer, 'node_modules', peer), {
        recursive: true,
        filter: (path) => !relative(location, path).split(sep).includes('node_modules'),
      })
    }
    writeFileSync(
      join(consumer, 'probe.mjs'),
      `
      import { createRequire } from 'node:module';
      import assert from 'node:assert/strict';
      const require = createRequire(import.meta.url);
      for (const name of ${JSON.stringify(absent)}) {
        assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
        await assert.rejects(import(name), { code: 'ERR_MODULE_NOT_FOUND' });
      }
      const api = await import('@paper-crumple/${adapter}');
      assert.equal(typeof api.${adapter === 'reatom' ? 'reatomScene' : 'Crumple'}, 'function');
      // @reatom/core 1001.3.0 opens its default persistence BroadcastChannel at import.
      // Exit only after resolution and all isolation assertions have completed.
      process.exit(0);
    `,
    )
    const result = spawnSync(process.execPath, [join(consumer, 'probe.mjs')], {
      cwd: consumer,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
    })
    if (result.status !== 0) failures.push(result.error?.message ?? result.stderr)
    return failures
  } finally {
    // mkdtemp owns this exact resolved tree, outside the workspace and all user artifacts.
    rmSync(consumer, { recursive: true, force: true })
  }
}

/** @param {string} path @param {string} name */
function readManifestName(path, name) {
  try {
    return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name === name
  } catch {
    return false
  }
}
