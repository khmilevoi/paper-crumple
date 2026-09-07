// The one-time tile encoder (spec 14, 14.1). Its four outputs are committed; this file exists so
// the bytes are reproducible and the recipe is not folklore. See ./README.md for the exact
// invocation that produced the files in packages/paper/src/tiles/.
//
// `sharp` is deliberately NOT a dependency of this repository: tools/ sits outside the workspace
// glob, tools/package.json must never exist (tests/workspace-shape.test.ts asserts it), and the
// published packages declare `"dependencies": {}`. Point --modules at any directory whose
// node_modules holds sharp; the spikes' own checkout has one.
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const TILE_PX = 512
const QUALITY = 84

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

async function main() {
  const modules = arg('modules')
  const crumplePng = arg('crumple')
  const fibrePng = arg('fibre')
  const outDir = arg('out')
  if (!modules || !crumplePng || !fibrePng || !outDir) {
    process.stderr.write(
      'usage: node tools/tiles/encode-tiles.mjs --modules <dir with node_modules/sharp> ' +
        '--crumple <paper-crumple.png> --fibre <paper-fibre.png> --out <dir>\n',
    )
    process.exitCode = 1
    return
  }

  const require = createRequire(pathToFileURL(join(resolve(modules), 'encode-tiles.cjs')))
  const sharp = require('sharp')

  const readRgba = async (file) => {
    const { data, info } = await sharp(file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    if (info.width !== TILE_PX || info.height !== TILE_PX || info.channels !== 4) {
      process.stderr.write(
        `${file}: expected ${TILE_PX}x${TILE_PX} RGBA, got ` +
          `${info.width}x${info.height}x${info.channels}\n`,
      )
      process.exitCode = 1
      return null
    }
    return data
  }

  const crumple = await readRgba(crumplePng)
  const fibre = await readRgba(fibrePng)
  if (crumple === null || fibre === null) return

  const n = TILE_PX * TILE_PX
  const plane = (source, offset, premultiply) => {
    const out = Buffer.allocUnsafe(n)
    for (let i = 0; i < n; i++) {
      const p = i * 4
      const v = source[p + offset]
      // Spec 14.1: the crumple tile is read premultiplied today, so the shipped bytes are the
      // premultiplied product and the render is reproduced exactly. Alpha is unchanged by
      // premultiplication, so the two alpha planes pass through.
      out[i] = premultiply ? Math.round((v * source[p + 3]) / 255) : v
    }
    return out
  }

  const planes = [
    ['crumple-r.webp', plane(crumple, 0, true)],
    ['crumple-g.webp', plane(crumple, 1, true)],
    ['crumple-a.webp', plane(crumple, 3, false)],
    ['fibre-a.webp', plane(fibre, 3, false)],
  ]

  await mkdir(outDir, { recursive: true })
  let total = 0
  for (const [name, data] of planes) {
    const encoded = await sharp(data, { raw: { width: TILE_PX, height: TILE_PX, channels: 1 } })
      // One channel in, one channel out: grayscale coding has no colour transform, which is why
      // four separate files beat one packed RGBA tile at every budget (spec 14).
      .webp({ quality: QUALITY, effort: 6, alphaQuality: 100, lossless: false })
      .toBuffer()
    const file = join(outDir, name)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, encoded)
    total += encoded.byteLength
    process.stdout.write(`${name}: ${encoded.byteLength} B\n`)
  }
  process.stdout.write(`total: ${total} B\n`)
}

await main()
