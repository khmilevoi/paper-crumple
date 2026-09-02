// Dumps the fold lines the bake folds along, so tools/bake/crumple.py never re-implements the 2D
// spike's fold table. Preset A, its first FLAP_COUNT folds, resolved exactly the way paper-fold's
// shader receives them (poses.resolveFolds) for a sheet of height 1 centred at the origin.
//
// KEPT AS PROVENANCE, NOT AS A BUILD STEP. Its two `../../paper-fold/...` imports resolve only
// inside the original spike checkout at C:/Users/Khmil/JsProjects/odeja/spikes/paper-crumple-3d/,
// and `../src/buckets.js` was that spike's bucket table. `folds.json` is vendored here as a
// frozen input (spec 13); regenerating it means running this file there and copying the result
// back. tools/bake/folds.test.ts pins the numbers so an accidental edit fails loudly instead.
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PARAMS } from '../../paper-fold/src/paper.js'
import { getFolds, resolveFolds } from '../../paper-fold/src/poses.js'
import { BUCKETS } from '../src/buckets.js'

export const FLAP_COUNT = 6
export const PRESET = 0 // 'A'

const round = (v) => Math.round(v * 1e6) / 1e6

/**
 * @param {number} aspect sheet width / height
 * @returns {Array<{angle:number, depth:number, nx:number, ny:number, c:number}>}
 */
export function foldLines(aspect, count = FLAP_COUNT, preset = PRESET) {
  // Pose 3 of the 2D spike applies 7 folds (FOLD_STOPS[3]); the first six are the big flaps.
  const folds = getFolds(preset, 3).slice(0, count)
  // halfExtent is in "one unit = texture height" space; the sheet IS the artwork box here.
  const { lines } = resolveFolds(folds, [aspect / 2, 0.5], {
    presetId: preset,
    scrapSize: DEFAULT_PARAMS.scrapSize,
  })
  return folds.map((f, i) => ({
    angle: round(f.angle),
    depth: round(f.depth),
    nx: round(lines[i * 3]),
    ny: round(lines[i * 3 + 1]),
    c: round(lines[i * 3 + 2]),
  }))
}

export function foldTable() {
  return Object.fromEntries(BUCKETS.map((b) => [b.id, foldLines(b.aspect)]))
}

/**
 * Writes the fold table to a JSON file.
 * @param {string} file path to write to
 * @param {object} table the fold table to write
 * @returns {Error|undefined} error if write fails, undefined on success
 */
export function writeFoldTable(file, table) {
  try {
    writeFileSync(file, `${JSON.stringify(table, null, 1)}\n`)
    return undefined
  } catch (cause) {
    return new Error(`writeFoldTable: failed to write ${file}`, { cause })
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'folds.json')
  const err = writeFoldTable(file, foldTable())
  if (err instanceof Error) {
    console.error(err.message)
    process.exit(1)
  }
  console.log(`wrote ${file}`)
}
