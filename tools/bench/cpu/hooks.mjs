import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const packages = resolvePath(here, '../../../packages')

const BARRELS = new Map([
  ['@paper-crumple/core', resolvePath(packages, 'core/src/index.ts')],
  ['@paper-crumple/core/unstable', resolvePath(packages, 'core/src/unstable.ts')],
  ['@paper-crumple/paper', resolvePath(packages, 'paper/src/index.ts')],
  ['@paper-crumple/paper/tiles', resolvePath(packages, 'paper/src/tiles.ts')],
  ['@paper-crumple/motion', resolvePath(packages, 'motion/src/index.ts')],
])

export function resolve(specifier, context, nextResolve) {
  const barrel = BARRELS.get(specifier)
  if (barrel !== undefined) {
    return { url: pathToFileURL(barrel).href, shortCircuit: true }
  }
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    specifier.endsWith('.js') &&
    context.parentURL !== undefined &&
    context.parentURL.startsWith('file:')
  ) {
    const parentDir = dirname(fileURLToPath(context.parentURL))
    const ts = resolvePath(parentDir, specifier.slice(0, -3) + '.ts')
    if (existsSync(ts)) return { url: pathToFileURL(ts).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
