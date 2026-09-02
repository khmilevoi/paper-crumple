import type { BucketName, DemoConfig, PresentMode } from './config'
import { BUCKET_NAMES, DEFAULT_CONFIG } from './config'
import type { KnobValues } from './panel'

/**
 * Every knob param is `k.<type>.<key>`. `<type>` is a one-character tag (`b`/`n`/`s`) so
 * `decodeState` can recover the original value's type without ever calling `JSON.parse` — the
 * banned-throw constraint (spec §10.8, `examples/` is not on `boundaryFiles`) means there is
 * nothing here that can throw in the first place, rather than something wrapped to catch. `<key>`
 * may itself contain dots (`sheet.tearAmp`), so only the first two dots are structural.
 */
const KNOB_PREFIX = 'k.'

function fieldError(key: string, raw: string): Error {
  return new Error(`playground: malformed "${key}" in URL fragment (got "${raw}")`)
}

function encodeKnobParam(key: string, value: string | number | boolean): readonly [string, string] {
  if (typeof value === 'boolean') return [`${KNOB_PREFIX}b.${key}`, value ? '1' : '0']
  if (typeof value === 'number') return [`${KNOB_PREFIX}n.${key}`, String(value)]
  return [`${KNOB_PREFIX}s.${key}`, value]
}

function parseKnobValue(type: string, raw: string, key: string): string | number | boolean | Error {
  if (type === 'b') {
    if (raw === '1') return true
    if (raw === '0') return false
    return fieldError(key, raw)
  }
  if (type === 'n') {
    const n = Number(raw)
    if (!Number.isFinite(n)) return fieldError(key, raw)
    return n
  }
  if (type === 's') return raw
  return fieldError(key, raw)
}

function parseKnobs(params: URLSearchParams): KnobValues | Error {
  const out: Record<string, string | number | boolean> = {}
  for (const [rawKey, rawValue] of params) {
    if (!rawKey.startsWith(KNOB_PREFIX)) continue
    const rest = rawKey.slice(KNOB_PREFIX.length) // "b.sheet.tearAmp"
    const sep = rest.indexOf('.')
    if (sep === -1 || sep === rest.length - 1) return fieldError(rawKey, rawValue)
    const type = rest.slice(0, sep)
    const key = rest.slice(sep + 1)
    const value = parseKnobValue(type, rawValue, key)
    if (value instanceof Error) return value
    out[key] = value
  }
  return out
}

function parseEdgeMode(params: URLSearchParams): DemoConfig['edgeMode'] | Error {
  const raw = params.get('edgeMode')
  if (raw === null) return DEFAULT_CONFIG.edgeMode
  if (raw === 'torn' || raw === 'hull') return raw
  return fieldError('edgeMode', raw)
}

function parseBoolField(params: URLSearchParams, key: string, fallback: boolean): boolean | Error {
  const raw = params.get(key)
  if (raw === null) return fallback
  if (raw === '1') return true
  if (raw === '0') return false
  return fieldError(key, raw)
}

function parsePacks(params: URLSearchParams): readonly BucketName[] | Error {
  const raw = params.get('packs')
  if (raw === null) return DEFAULT_CONFIG.packs
  if (raw === '') return []
  const tokens = raw.split(',')
  const seen = new Set<BucketName>()
  for (const t of tokens) {
    if (!BUCKET_NAMES.includes(t as BucketName)) return fieldError('packs', raw)
    seen.add(t as BucketName)
  }
  // Re-order to the canonical `BUCKET_NAMES` order regardless of how the fragment listed them —
  // `config.ts`'s `PACKS` record and `config-panel.ts`'s `packsRow` both assume that order.
  return BUCKET_NAMES.filter((b) => seen.has(b))
}

function parsePresent(params: URLSearchParams): PresentMode | Error {
  const raw = params.get('present')
  if (raw === null) return DEFAULT_CONFIG.present
  if (raw === 'blit' || raw === 'direct') return raw
  return fieldError('present', raw)
}

function parseNumberField(params: URLSearchParams, key: string, fallback: number): number | Error {
  const raw = params.get(key)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fieldError(key, raw)
  return n
}

/**
 * The `#`-fragment: the seven `DemoConfig` fields first, then one `k.<type>.<key>` param per
 * entry in `changed` — already exactly the knobs that differ from their descriptor default
 * (`panel.ts`'s `PanelHandle.changed()`), so nothing here re-derives that filter.
 */
export function encodeState(config: DemoConfig, changed: KnobValues): string {
  const params = new URLSearchParams()
  params.set('edgeMode', config.edgeMode)
  params.set('tiles', config.tiles ? '1' : '0')
  params.set('packs', config.packs.join(','))
  params.set('present', config.present)
  params.set('cssPx', String(config.cssPx))
  params.set('budgetMb', String(config.budgetMb))
  params.set('overscanHeadroom', String(config.overscanHeadroom))

  for (const [key, value] of Object.entries(changed)) {
    const [paramKey, paramValue] = encodeKnobParam(key, value)
    params.set(paramKey, paramValue)
  }

  return `#${params.toString()}`
}

/**
 * Field by field, with a typed guard per field: an unknown key is ignored (an absent known key
 * falls back to `DEFAULT_CONFIG`'s value for it), a malformed value returns an `Error` naming the
 * key. `URLSearchParams` does the actual parsing, so there is no `JSON.parse` — and nothing here
 * to `throw` or to `catch` around.
 */
export function decodeState(hash: string): { config: DemoConfig; knobs: KnobValues } | Error {
  const params = new URLSearchParams(hash.replace(/^#/, ''))

  const edgeMode = parseEdgeMode(params)
  if (edgeMode instanceof Error) return edgeMode
  const tiles = parseBoolField(params, 'tiles', DEFAULT_CONFIG.tiles)
  if (tiles instanceof Error) return tiles
  const packs = parsePacks(params)
  if (packs instanceof Error) return packs
  const present = parsePresent(params)
  if (present instanceof Error) return present
  const cssPx = parseNumberField(params, 'cssPx', DEFAULT_CONFIG.cssPx)
  if (cssPx instanceof Error) return cssPx
  const budgetMb = parseNumberField(params, 'budgetMb', DEFAULT_CONFIG.budgetMb)
  if (budgetMb instanceof Error) return budgetMb
  const overscanHeadroom = parseNumberField(
    params,
    'overscanHeadroom',
    DEFAULT_CONFIG.overscanHeadroom,
  )
  if (overscanHeadroom instanceof Error) return overscanHeadroom

  const knobs = parseKnobs(params)
  if (knobs instanceof Error) return knobs

  const config: DemoConfig = { edgeMode, tiles, packs, present, cssPx, budgetMb, overscanHeadroom }
  return { config, knobs }
}

const PACK_IMPORT: Readonly<
  Record<BucketName, { readonly varName: string; readonly path: string }>
> = {
  '1x1': { varName: 'pack1x1', path: '@paper-crumple/motion/packs/1x1' },
  '2x3': { varName: 'pack2x3', path: '@paper-crumple/motion/packs/2x3' },
  '3x2': { varName: 'pack3x2', path: '@paper-crumple/motion/packs/3x2' },
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function renderKey(key: string): string {
  return IDENTIFIER.test(key) ? key : `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function renderStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function renderValue(value: string | number | boolean): string {
  if (typeof value === 'string') return renderStringLiteral(value)
  return String(value)
}

/**
 * The pasteable source a reader can drop straight into a scratch file. `tiles` is imported only
 * when `config.tiles` is on — `paperSheet`'s own `tiles` option defaults to `null`, so it is
 * simply omitted otherwise, exactly the way `overscanHeadroom` (default `0`) is omitted below —
 * and each pack import matches one selected bucket, so nothing here imports a module the emitted
 * call never references. The guard pair after `paperStage` is deliberately in the documented
 * order: `=== pc.ABORTED` first, then `instanceof Error`.
 */
export function emitCode(config: DemoConfig, changed: KnobValues): string {
  const lines: string[] = []
  lines.push("import * as pc from '@paper-crumple/core'")
  lines.push("import { paperSheet } from '@paper-crumple/paper'")
  if (config.tiles) lines.push("import { tiles } from '@paper-crumple/paper/tiles'")
  lines.push("import { bakedMotion } from '@paper-crumple/motion'")
  for (const bucket of config.packs) {
    const pack = PACK_IMPORT[bucket]
    lines.push(`import ${pack.varName} from '${pack.path}'`)
  }
  lines.push('')

  const sheetFields = [`edgeMode: '${config.edgeMode}'`]
  if (config.tiles) sheetFields.push('tiles')
  if (config.overscanHeadroom !== 0) {
    sheetFields.push(`overscanHeadroom: ${String(config.overscanHeadroom)}`)
  }

  const packVars = config.packs.map((b) => PACK_IMPORT[b].varName)

  lines.push('const stage = await pc.paperStage({')
  lines.push(`  sheet: paperSheet({ ${sheetFields.join(', ')} }),`)
  lines.push(`  motion: bakedMotion({ packs: [${packVars.join(', ')}] }),`)
  lines.push(`  cssPx: ${String(config.cssPx)},`)
  lines.push(`  budget: ${String(config.budgetMb * 1024 * 1024)},`)
  lines.push(`  present: '${config.present}',`)
  lines.push('})')
  lines.push('if (stage === pc.ABORTED) return')
  lines.push('if (stage instanceof Error) return stage')

  const changedEntries = Object.entries(changed)
  if (changedEntries.length > 0) {
    lines.push('')
    lines.push('stage.set({')
    for (const [key, value] of changedEntries) {
      lines.push(`  ${renderKey(key)}: ${renderValue(value)},`)
    }
    lines.push('})')
  }

  return lines.join('\n')
}
