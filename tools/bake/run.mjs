// Launches Blender headless on one bake script. Harness, not part of the effect, and never a CI
// dependency: a real bake is 4 m 10 s of single-threaded wall time (spec 13).
//
//   node tools/bake/run.mjs <script.py> [args passed to the script after "--"]
//
// The binary path lives HERE and nowhere else: BLENDER=<path> overrides it, so the Windows Steam
// path is a convenience default and not a requirement. -t 1 keeps the cloth solver and collision
// loops single-threaded so two bakes sum in the same order and come out byte-identical;
// --python-exit-code 1 makes an uncaught Python exception a non-zero exit.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_BLENDER = 'C:/Program Files (x86)/Steam/steamapps/common/Blender/blender.exe'

/** The binary to run: $BLENDER when set, else the Steam install. Error when the file is missing. */
export function blenderPath(env = process.env) {
  const path = env.BLENDER && env.BLENDER.trim() ? env.BLENDER.trim() : DEFAULT_BLENDER
  if (!existsSync(path)) {
    return new Error(`blender not found at ${path} (set BLENDER=<path to blender.exe>)`)
  }
  return path
}

/** Blender argv for a headless, single-threaded run of `script`; `args` land after "--". */
export function blenderArgs(script, args = []) {
  return ['-b', '-t', '1', '--python-exit-code', '1', '-P', script, '--', ...args]
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [script, ...args] = process.argv.slice(2)
  if (!script) {
    console.error('usage: node tools/bake/run.mjs <script.py> [args]')
    process.exit(2)
  }
  const bin = blenderPath()
  if (bin instanceof Error) {
    console.error(bin.message)
    process.exit(2)
  }
  const argv = blenderArgs(script, args)
  console.log(`> "${bin}" ${argv.join(' ')}`)
  const result = spawnSync(bin, argv, { stdio: 'inherit' })
  // status is null when the process never ran (EACCES, EPERM, a killing signal). Exiting 1 with a
  // silent console makes that indistinguishable from Blender itself failing, so say what happened.
  if (result.error) console.error(`blender did not run: ${result.error.message}`)
  else if (result.status == null && result.signal)
    console.error(`blender was killed by ${result.signal}`)
  process.exit(result.status ?? 1)
}
