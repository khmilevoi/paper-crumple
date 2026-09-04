import type { BucketName, DemoConfig, PresentMode } from './config'
import { BUCKET_NAMES, DEFAULT_CONFIG } from './config'
import type { KnobValues } from './knobs'

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
  if (raw === 'torn' || raw === 'hull' || raw === 'both') return raw
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
  params.set('artworkCssPx', String(config.artworkCssPx))
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
  const artworkCssPx = parseNumberField(params, 'artworkCssPx', DEFAULT_CONFIG.artworkCssPx)
  if (artworkCssPx instanceof Error) return artworkCssPx
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

  const config: DemoConfig = {
    edgeMode,
    tiles,
    packs,
    present,
    artworkCssPx,
    budgetMb,
    overscanHeadroom,
  }
  return { config, knobs }
}
