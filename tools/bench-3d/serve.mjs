/**
 * A dependency-free static server for the level-3 harness.
 *
 * Its whole job is two headers: without `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` the page is not cross-origin isolated,
 * `performance.now()` is clamped to 100 microseconds, and every CPU figure the harness reports is
 * quantisation noise (spec 17.1).
 *
 * Not in CI, and never imported by any package. Node only, no dependencies.
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const PORT = Number(process.env.PORT ?? 8317)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.webp': 'image/webp',
  '.map': 'application/json; charset=utf-8',
}

/** Resolves a URL path inside ROOT, or null if it escapes. */
function resolveInRoot(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const candidate = resolve(join(ROOT, normalize(decoded)))
  if (
    candidate !== ROOT &&
    !candidate.startsWith(ROOT + '/') &&
    !candidate.startsWith(ROOT + '\\')
  ) {
    return null
  }
  return candidate
}

const server = createServer((req, res) => {
  // The two headers this file exists for, on every response including errors.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')

  const target = resolveInRoot(req.url ?? '/')
  if (target === null) {
    res.writeHead(403).end('outside the repository root')
    return
  }

  let file = target
  const stat = ((path) => {
    try {
      return statSync(path)
    } catch {
      return null
    }
  })(file)
  if (stat !== null && stat.isDirectory()) file = join(file, 'index.html')

  const stream = createReadStream(file)
  stream.on('error', () => {
    res.writeHead(404).end(`not found: ${file}`)
  })
  stream.on('open', () => {
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
    stream.pipe(res)
  })
})

server.listen(PORT, () => {
  process.stdout.write(`level-3 harness: http://localhost:${String(PORT)}/tools/bench-3d/\n`)
})
