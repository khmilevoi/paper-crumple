import type { BucketName, DemoConfig } from './config'
import { BUCKET_NAMES, DEFAULT_CONFIG } from './config'
import type { Knobs } from '@paper-crumple/core'
import type { EdgeFinish, EdgeShape, EdgeWidthUnit } from '@paper-crumple/paper'

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

function parseKnobs(params: URLSearchParams): Knobs | Error {
  const out: Record<string, Knobs[string]> = {}
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

/**
 * One helper behind the three literal-union `DemoConfig` fields `parseEdgeMode` used to be alone
 * in being: an absent key falls back to `fallback` (`DEFAULT_CONFIG`'s own value for it), a value
 * outside `allowed` is a named `Error`, and the old three-way `edgeMode` param is simply gone —
 * an old link's `edgeMode=torn` is an unknown key to every parser below and is ignored, so every
 * edge field falls back to its default (design 2026-09-05 §9; there is no compatibility shim).
 */
function parseLiteral<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T | Error {
  const raw = params.get(key)
  if (raw === null) return fallback
  const hit = allowed.find((a) => a === raw)
  return hit ?? fieldError(key, raw)
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

function parseNumberField(params: URLSearchParams, key: string, fallback: number): number | Error {
  const raw = params.get(key)
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fieldError(key, raw)
  return n
}

/**
 * The `#`-fragment: the eight `DemoConfig` fields first, then one `k.<type>.<key>` param per
 * entry in `changed` — already exactly the knobs that differ from their descriptor default
 * (`panel.ts`'s `PanelHandle.changed()`), so nothing here re-derives that filter.
 *
 * `present` was removed with the React migration and is deliberately NOT parsed: an old
 * `&present=direct` link loads at the default rather than reporting an unknown field.
 */
export function encodeState(config: DemoConfig, changed: Knobs): string {
  const params = new URLSearchParams()
  params.set('edgeShape', config.edgeShape)
  params.set('edgeFinish', config.edgeFinish)
  params.set('edgeWidthUnit', config.edgeWidthUnit)
  params.set('tiles', config.tiles ? '1' : '0')
  params.set('packs', config.packs.join(','))
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
export function decodeState(hash: string): { config: DemoConfig; knobs: Knobs } | Error {
  const params = new URLSearchParams(hash.replace(/^#/, ''))

  const edgeShape = parseLiteral<EdgeShape>(
    params,
    'edgeShape',
    ['smooth', 'torn'],
    DEFAULT_CONFIG.edgeShape,
  )
  if (edgeShape instanceof Error) return edgeShape
  const edgeFinish = parseLiteral<EdgeFinish>(
    params,
    'edgeFinish',
    ['clean', 'paper'],
    DEFAULT_CONFIG.edgeFinish,
  )
  if (edgeFinish instanceof Error) return edgeFinish
  const edgeWidthUnit = parseLiteral<EdgeWidthUnit>(
    params,
    'edgeWidthUnit',
    ['px', 'percent'],
    DEFAULT_CONFIG.edgeWidthUnit,
  )
  if (edgeWidthUnit instanceof Error) return edgeWidthUnit
  const tiles = parseBoolField(params, 'tiles', DEFAULT_CONFIG.tiles)
  if (tiles instanceof Error) return tiles
  const packs = parsePacks(params)
  if (packs instanceof Error) return packs
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
    edgeShape,
    edgeFinish,
    edgeWidthUnit,
    tiles,
    packs,
    artworkCssPx,
    budgetMb,
    overscanHeadroom,
  }
  return { config, knobs }
}
