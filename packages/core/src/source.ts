import type { Aborted } from './abort.js'
import { ABORTED, isAborted } from './abort.js'
import { AssetError } from './errors.js'

/**
 * A supplier the consumer writes. It mints a **fresh** bitmap per call and must never hand back
 * one it also gave to `add()` (§8.5.4): the stage closes what a supplier returns, exactly once, as
 * soon as `source()` returns — on success, on error and on abort.
 */
export type BitmapSupplier = () => Promise<ImageBitmap | Error>

/**
 * The three arms from which **no re-supplier can be derived**, so a sprite made from one can never
 * be evicted and `pin: true` is required by the type (§4.1, §8.5.1, amendment 9).
 */
export type PinnedSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement

/**
 * What `stage.add`, `stage.addAll`, `stage.replace`, `stage.mount` and `view.swapTo` accept
 * (§4.1, amendment 9).
 *
 * **Reclaimability is the point of the union, not a side effect of it.** For `string | URL | Blob`
 * the library derives the re-supplier itself — it is the fetch it already performed — so the
 * sprite is LRU-reclaimable by construction and §8.8's byte budget actually bounds it. A supplier
 * function is reclaimable for the same reason, by the consumer's own promise. **Deriving a
 * re-supplier is exactly what makes a sprite reclaimable, and reclaimability is what lets the byte
 * budget bound anything at all: a sprite whose bytes cannot be re-fetched cannot be evicted, so
 * the budget is a ceiling only over the arms a re-supplier can be derived from.** The other three
 * arms — a bare `ImageBitmap`, `HTMLImageElement` or `HTMLCanvasElement` — reach §8.5.1's
 * unreclaimable sprite, and there the type requires `pin: true`, so an unbounded front is a signed
 * decision rather than an omission. `usage()` still reports `unreclaimable`, because a consumer
 * may pin a great deal of it.
 *
 * **A supplier must return the same image the key was registered with** (§8.5.1), because the hull
 * cache is keyed on `(sprite key, sdfRes, hull knobs)` and the bitmap is not in that key. A caller
 * whose image may have changed uses `replace()`.
 *
 * **That rule is detected rather than merely stated** (amendment 10). A URL-derived re-supplier
 * cannot promise the remote bytes are unchanged, and the consumer who never wrote a supplier
 * cannot be blamed for its staleness. Detection is HTTP, never hashing — a hash costs a full
 * decode of the very bytes the re-supply exists to avoid holding. The first response's `ETag` /
 * `Last-Modified` is recorded and a conditional request is issued on re-supply: `304` means
 * unchanged and the rebuild proceeds as a rebuild; `200` means the bytes moved, and the rebuild is
 * upgraded to `replace()` semantics — the hull entry is invalidated so the new artwork gets its
 * own torn edge instead of the previous sprite's — with a warning naming the key.
 *
 * **The limit, stated honestly rather than papered over.** A cross-origin response without
 * `Access-Control-Expose-Headers: ETag` exposes neither header, and there the same-image contract
 * is **documented and unenforced**: the re-supply proceeds and a changed image keeps the old hull.
 * `Blob` sources are immutable and need no check at all, and a function supplier remains the
 * caller's promise, as it always was.
 */
export type SpriteSource = string | URL | Blob | PinnedSource | BitmapSupplier

/**
 * The `pin: true` requirement, as a type (§4.1, §11, amendment 9). P9 composes it into `add`'s
 * options bag — `o: { key: string; signal?: AbortSignal; exact?: boolean } & PinFor<S>` — so a
 * bare `ImageBitmap` without `pin: true` does not typecheck. The name deliberately matches
 * `stage.pin(key)`: the same semantics, fixed at creation rather than asserted afterwards.
 *
 * The tuple wrapper is load-bearing. It stops `S` distributing, so a union of unreclaimable arms
 * still requires the flag. It also means a source **widened to the whole union** — read out of a
 * data model rather than written at the call site — does not require it; that is the same hole
 * §6.8 documents for a `Partial` knob patch built in a variable, and the runtime check P9 owns is
 * what catches it.
 */
export type PinFor<S> = [S] extends [PinnedSource] ? { pin: true } : { pin?: true }

/**
 * One arm of the union, resolved. `string` and `URL` collapse into a single `'url'` kind — that
 * collapse is the first half of "nothing downstream branches on the union a second time".
 */
export type ClassifiedSource =
  | { readonly kind: 'url'; readonly src: string | URL }
  | { readonly kind: 'blob'; readonly src: Blob }
  | { readonly kind: 'bitmap'; readonly src: ImageBitmap }
  | { readonly kind: 'image'; readonly src: HTMLImageElement }
  | { readonly kind: 'canvas'; readonly src: HTMLCanvasElement }
  | { readonly kind: 'supplier'; readonly src: BitmapSupplier }

export type SourceKind = ClassifiedSource['kind']

const NOT_A_SOURCE =
  'is not a SpriteSource: expected a string, a URL, a Blob, an ImageBitmap, an HTMLImageElement, ' +
  'an HTMLCanvasElement, or a () => Promise<ImageBitmap | Error> supplier'

/**
 * `[object Blob]`, `[object ImageBitmap]`, `[object HTMLCanvasElement]` and the rest. Web IDL puts
 * `Symbol.toStringTag` on every interface prototype, so this answers correctly for an object from
 * another realm — an iframe's canvas — where `instanceof` answers `false`. It is also the only
 * mechanism available in Node, where none of these constructors exists to test against.
 */
function tagOf(x: object): string {
  return Object.prototype.toString.call(x).slice(8, -1)
}

function isBitmapLike(x: object): x is ImageBitmap {
  const o = x as Partial<ImageBitmap>
  return (
    typeof o.close === 'function' && typeof o.width === 'number' && typeof o.height === 'number'
  )
}

function isElementLike(x: object, tagName: string): boolean {
  const o = x as { nodeType?: unknown; tagName?: unknown }
  return o.nodeType === 1 && typeof o.tagName === 'string' && o.tagName.toUpperCase() === tagName
}

/**
 * Total over the seven arms, and over everything else. Returns an `AssetError` rather than
 * throwing, because §10.8 holds here as everywhere: `add(undefined)` from untyped JavaScript is a
 * value the library returns, not an exception it raises.
 */
export function classifySource(src: unknown): ClassifiedSource | InstanceType<typeof AssetError> {
  if (typeof src === 'string') return { kind: 'url', src }
  if (typeof src === 'function') return { kind: 'supplier', src: src as BitmapSupplier }
  if (typeof src !== 'object' || src === null) {
    return new AssetError(`${typeof src} ${NOT_A_SOURCE}`)
  }

  switch (tagOf(src)) {
    case 'URL':
      return { kind: 'url', src: src as URL }
    // A File is a Blob, and an upload from <input type="file"> is the real case.
    case 'Blob':
    case 'File':
      return { kind: 'blob', src: src as Blob }
    case 'ImageBitmap':
      return { kind: 'bitmap', src: src as ImageBitmap }
    case 'HTMLImageElement':
      return { kind: 'image', src: src as HTMLImageElement }
    case 'HTMLCanvasElement':
      return { kind: 'canvas', src: src as HTMLCanvasElement }
  }

  // No tag: an exotic host object, or a double. Shape decides, and `instanceof` closes the two
  // cases where a real constructor is guaranteed to be in scope in every environment.
  if (src instanceof URL) return { kind: 'url', src }
  if (src instanceof Blob) return { kind: 'blob', src }
  if (isBitmapLike(src)) return { kind: 'bitmap', src }
  if (isElementLike(src, 'IMG')) return { kind: 'image', src: src as HTMLImageElement }
  if (isElementLike(src, 'CANVAS')) return { kind: 'canvas', src: src as HTMLCanvasElement }

  return new AssetError(`${tagOf(src)} ${NOT_A_SOURCE}`)
}

/**
 * The decode boundary, injected. `createImageBitmap` throws, so it is wrapped rather than called
 * (§10.8) — and it does not exist in Node at all, which is what makes this module level-1 testable
 * (§11) instead of needing a browser to assert a URL was fetched.
 */
export type SourceDecode = (
  src: Blob | HTMLImageElement | HTMLCanvasElement,
) => Promise<ImageBitmap>

/** The part of a `Response` this module reads. Structural, so a level-1 stub is a literal. */
export interface SourceResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  blob(): Promise<Blob>
}

/**
 * The network boundary, injected. `fetch` throws, so it is wrapped rather than called (§10.8).
 * Typed structurally rather than as `typeof globalThis.fetch` so that a level-1 stub is an object
 * literal instead of a constructed `Response`; the global is assignable to it.
 */
export type SourceFetch = (
  input: string | URL,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<SourceResponse>

export interface SourceEnv {
  readonly fetch?: SourceFetch
  readonly createImageBitmap?: SourceDecode
}

/**
 * A bitmap, and who closes it. **The stage closes every bitmap it obtained and never closes one it
 * was given** (§8.5.4), so ownership is carried with the bitmap rather than re-derived from the
 * arm — it is the one two-valued fact downstream still has to branch on, and it is a fact about
 * ownership rather than about the union.
 */
export interface AcquiredBitmap {
  readonly bitmap: ImageBitmap
  readonly owned: boolean
}

/** A bitmap this module obtained. Every path but the `bitmap` arm produces one. */
export interface OwnedBitmap extends AcquiredBitmap {
  readonly owned: true
}

/**
 * What the conditional request decided (§8.5.1, amendment 10).
 *
 * - `unchanged` — a `304`, or a `Blob`, which is immutable, or a supplier, which is the caller's
 *   promise. The rebuild proceeds as a rebuild.
 * - `changed` — a `200`. The bytes moved under a key §8.5.1 promised would not move.
 * - `unverified` — neither validator was exposed, so nothing was asked and nothing was learned.
 *   The re-supply proceeds and the same-image contract is documented and unenforced.
 */
export type SourceFreshness = 'unchanged' | 'changed' | 'unverified'

export interface ResupplyReport extends OwnedBitmap {
  readonly freshness: SourceFreshness
  /** Set iff `freshness === 'changed'`. The sentence, not the channel: emitting is P9's. */
  readonly warning: string | undefined
}

export interface AcquireOptions {
  readonly signal?: AbortSignal
}

export interface ResupplyOptions extends AcquireOptions {
  /** Names the sprite in the warning sentence, and is used for nothing else. */
  readonly key: string
}

export type AcquireResult = AcquiredBitmap | InstanceType<typeof AssetError> | Aborted
export type ResupplyResult = ResupplyReport | InstanceType<typeof AssetError> | Aborted

/**
 * The one internal shape the registry consumes, so nothing downstream branches on the seven-arm
 * union a second time (§4.1, amendment 9).
 *
 * The record **holds no bitmap it would have to close**: the `url` and `blob` arms retain
 * compressed bytes (§8.5.3), the supplier arm retains a function, and `borrowed` is the consumer's
 * own and must never be closed. That is why `stage.dispose()` closes nothing — it owns nothing —
 * and why this interface has no `close` and no `dispose` (§8.5.4).
 */
export interface NormalizedSource {
  readonly kind: SourceKind
  /**
   * `true` iff a re-supplier was derived, which is exactly `resupply !== undefined`. It is the
   * value `FrontLruEntry.reclaimable` takes, and therefore the value §8.8's budget is a ceiling
   * over: a sprite whose bytes cannot be re-fetched cannot be evicted.
   */
  readonly reclaimable: boolean
  /**
   * The consumer's own bitmap — set only for the `bitmap` arm, `undefined` for every other.
   *
   * **Read it before the first suspension point.** §8.5.4 makes `stage.add(b, { key, pin: true });
   * b.close()` in the same turn legal and recommended, and that is only true if nothing awaits
   * between `add()`'s entry and the `sheet.source()` call. `acquire()` returns the same bitmap for
   * uniformity, but awaiting it has already yielded the turn.
   */
  readonly borrowed: ImageBitmap | undefined
  readonly acquire: (o?: AcquireOptions) => Promise<AcquireResult>
  /** `undefined` for the three arms no re-supplier can be derived from. */
  readonly resupply: ((o: ResupplyOptions) => Promise<ResupplyResult>) | undefined
}

/** A detached bitmap reports zero dimensions; `createImageBitmap` never produces one that does. */
function isDetached(bitmap: ImageBitmap): boolean {
  return bitmap.width === 0 || bitmap.height === 0
}

function abortedNow(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}

/**
 * `close()` on an already-detached bitmap is a no-op by specification. The wrapper exists so that a
 * host object which disagrees turns a cleanup into nothing rather than into an unhandled rejection
 * on a path that is already unwinding.
 */
function closeQuietly(bitmap: ImageBitmap): void {
  try {
    bitmap.close()
  } catch {
    // Already gone. Nothing above this line can act on it.
  }
}

/**
 * The acquisition-to-report mapping for the two arms whose freshness is a property of the arm
 * rather than the answer to a question: a `Blob`, which is immutable, and a supplier, which is the
 * caller's own promise (§8.5.1). `urlSource` deliberately does not use this — its freshness is
 * whatever the conditional request decided.
 */
function unchangedReport(
  got: OwnedBitmap | InstanceType<typeof AssetError> | Aborted,
): ResupplyResult {
  if (isAborted(got)) return ABORTED
  if (got instanceof Error) return got
  return { ...got, freshness: 'unchanged', warning: undefined }
}

/**
 * The decode boundary, wrapped. A bitmap obtained after the signal fired is closed here: the caller
 * is not receiving it and therefore cannot close it, and §8.5.4 wants it closed on abort exactly as
 * on success.
 */
async function decodeBitmap(
  injected: SourceDecode | undefined,
  src: Blob | HTMLImageElement | HTMLCanvasElement,
  signal: AbortSignal | undefined,
  what: string,
): Promise<ImageBitmap | InstanceType<typeof AssetError> | Aborted> {
  // Resolved into an annotated `const` rather than called as `(a ?? b)(src)`: a call on a union of
  // two function types is a place TypeScript can refuse for reasons that have nothing to do with
  // this module, and the annotation is where the global is checked against the seam once.
  const decoder: SourceDecode = injected ?? globalThis.createImageBitmap
  let bitmap: ImageBitmap
  try {
    // `createImageBitmap` is absent in Node and in a worker without it, so `decoder` may be
    // `undefined` at runtime while typed here; calling it is a TypeError, which this catch turns
    // into the same AssetError a decode failure produces.
    bitmap = await decoder(src)
  } catch (cause) {
    if (isAborted(cause)) return ABORTED
    return new AssetError(`could not decode ${what}`, { cause })
  }
  if (abortedNow(signal)) {
    closeQuietly(bitmap)
    return ABORTED
  }
  return bitmap
}

/**
 * The `ImageBitmap` arm. Unreclaimable — no re-supplier can be derived from a decoded bitmap — and
 * **borrowed on every path**: success, `AddError` and abort alike leave it the caller's.
 */
export function bitmapSource(
  bitmap: ImageBitmap,
): NormalizedSource | InstanceType<typeof AssetError> {
  if (isDetached(bitmap)) {
    return new AssetError('the ImageBitmap given to add() is closed or detached')
  }
  return {
    kind: 'bitmap',
    reclaimable: false,
    borrowed: bitmap,
    acquire: async (o = {}) => {
      if (abortedNow(o.signal)) return ABORTED
      if (isDetached(bitmap)) {
        return new AssetError('the ImageBitmap given to add() was closed before it could be read')
      }
      return { bitmap, owned: false }
    },
    resupply: undefined,
  }
}

/**
 * The `HTMLImageElement` and `HTMLCanvasElement` arms. The element stays the consumer's; the bitmap
 * minted from it was obtained here, so it is owned. Unreclaimable, because a canvas the consumer
 * repaints is not the image the key was registered with and the library cannot know when it moved.
 */
export function elementSource(
  kind: 'image' | 'canvas',
  el: HTMLImageElement | HTMLCanvasElement,
  env: SourceEnv,
): NormalizedSource {
  const what =
    kind === 'image'
      ? 'the HTMLImageElement given to add()'
      : 'the HTMLCanvasElement given to add()'
  return {
    kind,
    reclaimable: false,
    borrowed: undefined,
    acquire: async (o = {}) => {
      if (abortedNow(o.signal)) return ABORTED
      const bitmap = await decodeBitmap(env.createImageBitmap, el, o.signal, what)
      if (isAborted(bitmap)) return ABORTED
      if (bitmap instanceof Error) return bitmap
      return { bitmap, owned: true }
    },
    resupply: undefined,
  }
}

/**
 * The `Blob` arm. Reclaimable, because the bytes are already in hand and re-supplying is a second
 * decode of them — and **immutable, so §8.5.1's staleness protocol has no subject here**: there is
 * nothing to ask a server about and the freshness is `unchanged` by construction rather than by a
 * request. A `File` from an upload takes this path.
 */
export function blobSource(blob: Blob, env: SourceEnv): NormalizedSource {
  const load = async (
    signal: AbortSignal | undefined,
  ): Promise<OwnedBitmap | InstanceType<typeof AssetError> | Aborted> => {
    if (abortedNow(signal)) return ABORTED
    const bitmap = await decodeBitmap(
      env.createImageBitmap,
      blob,
      signal,
      'the Blob given to add()',
    )
    if (isAborted(bitmap)) return ABORTED
    if (bitmap instanceof Error) return bitmap
    return { bitmap, owned: true }
  }

  return {
    kind: 'blob',
    reclaimable: true,
    borrowed: undefined,
    acquire: (o = {}) => load(o.signal),
    resupply: async (o) => unchangedReport(await load(o.signal)),
  }
}

/**
 * The supplier arm. Reclaimable by the caller's own promise, which is what it always was: a
 * function supplier is not something the library can verify, and §8.5.1 leaves it as the caller's
 * undertaking rather than pretending otherwise.
 *
 * **The bitmap belongs to the stage** (§8.5.4), which is why a supplier must mint a fresh one per
 * call and must never hand back one it also gave to `add()` — the stage will close it. When the
 * signal fires while the supplier is in flight, the bitmap that arrives is closed here: the caller
 * is not receiving it and cannot close it.
 */
export function supplierSource(supply: BitmapSupplier): NormalizedSource {
  const call = async (
    signal: AbortSignal | undefined,
  ): Promise<OwnedBitmap | InstanceType<typeof AssetError> | Aborted> => {
    if (abortedNow(signal)) return ABORTED

    let produced: ImageBitmap | Error
    try {
      // A consumer's function is not bound by §10.8, so a rejection is an ordinary outcome here.
      produced = await supply()
    } catch (cause) {
      if (isAborted(cause)) return ABORTED
      return new AssetError('the sprite source supplier failed', { cause })
    }

    if (isAborted(produced)) return ABORTED
    if (produced instanceof Error) {
      // Wrapped rather than forwarded: `AddError` is a closed union and an arbitrary Error is not
      // a member of it. `findCause` recovers the original.
      return new AssetError('the sprite source supplier returned an error', { cause: produced })
    }
    if (isDetached(produced)) {
      return new AssetError(
        'the sprite source supplier returned a closed or detached ImageBitmap; a supplier must ' +
          'mint a fresh bitmap per call and must never hand back one it also gave to add()',
      )
    }
    if (abortedNow(signal)) {
      closeQuietly(produced)
      return ABORTED
    }
    return { bitmap: produced, owned: true }
  }

  return {
    kind: 'supplier',
    reclaimable: true,
    borrowed: undefined,
    acquire: (o = {}) => call(o.signal),
    resupply: async (o) => unchangedReport(await call(o.signal)),
  }
}

/**
 * What the first response said about its own identity (§8.5.1, amendment 10). `undefined` where
 * neither header was exposed.
 */
export interface SourceValidator {
  readonly etag: string | undefined
  readonly lastModified: string | undefined
}

/**
 * **Detection is HTTP, never hashing.** A hash would cost a full decode of the very bytes the
 * re-supply exists to avoid holding (§8.5.3), so the same-image contract is checked with the two
 * headers HTTP already defines for it.
 *
 * Returns `undefined` when neither is exposed — which is the ordinary cross-origin case, since a
 * response without `Access-Control-Expose-Headers: ETag` exposes neither to script even when both
 * are on the wire.
 */
export function readValidator(headers: {
  get(name: string): string | null
}): SourceValidator | undefined {
  const etag = headers.get('ETag') ?? undefined
  const lastModified = headers.get('Last-Modified') ?? undefined
  if (etag === undefined && lastModified === undefined) return undefined
  return { etag, lastModified }
}

/**
 * The sentence a `200` on a conditional re-supply produces (§8.5.1, amendment 10).
 *
 * **This module reports; it does not emit.** There is no stage at this level and therefore no
 * channel: P9 decides whether this goes out on `stage.warnings` or on an event, and P9 turns the
 * same report into `replace()` semantics — the hull entry invalidated through the by-key entry
 * point P8 exposes, so the new artwork gets its own torn edge instead of the previous sprite's.
 */
export function staleSourceWarning(key: string, href: string): string {
  return (
    `sprite "${key}": the bytes at ${href} changed since it was added. The re-supply is treated ` +
    'as a replace — the hull entry is invalidated, so the new artwork gets its own torn edge ' +
    'rather than the one traced from the image this key was registered with.'
  )
}

/**
 * The `string` and `URL` arms, which normalise to one path: **the re-supplier is the fetch the
 * library already performed**, so the sprite is reclaimable by construction and §8.8's byte budget
 * bounds it. That is the whole of amendment 9's inversion — a sprite whose bytes cannot be
 * re-fetched cannot be evicted, so the budget is a ceiling only over the arms reached from here
 * and from `blobSource`.
 */
export function urlSource(src: string | URL, env: SourceEnv): NormalizedSource {
  // The input is handed to `fetch` unchanged. `new URL('/sweater.png')` throws without a base and
  // there is no base in Node, so the one place a relative path is resolved stays `fetch`'s.
  const href = typeof src === 'string' ? src : src.href

  // Retained across calls: the compressed bytes as the re-load source (§8.5.3, ~200–800 KB, and
  // arguably the consumer's memory rather than the library's), and the validator the next
  // conditional request is built from. Both are assigned in `take` and used by the `resupply`
  // function implemented below.
  let bytes: Blob | undefined
  let validator: SourceValidator | undefined

  // Annotated once, for the reason `decodeBitmap` gives: not a call on a union of two function
  // types. `typeof globalThis.fetch` is assignable to `SourceFetch` — narrower parameters, and a
  // `Response` satisfies `SourceResponse` structurally.
  const doFetch: SourceFetch = env.fetch ?? globalThis.fetch

  const request = async (
    signal: AbortSignal | undefined,
    headers: Record<string, string>,
  ): Promise<SourceResponse | InstanceType<typeof AssetError> | Aborted> => {
    try {
      // `fetch` throws, so it is wrapped rather than called (§10.8).
      return await doFetch(src, { signal, headers })
    } catch (cause) {
      if (isAborted(cause)) return ABORTED
      return new AssetError(`could not fetch ${href}`, { cause })
    }
  }

  /** Reads a response into a bitmap, retaining the bytes and re-recording the validator. */
  const take = async (
    res: SourceResponse,
    signal: AbortSignal | undefined,
  ): Promise<OwnedBitmap | InstanceType<typeof AssetError> | Aborted> => {
    let blob: Blob
    try {
      blob = await res.blob()
    } catch (cause) {
      if (isAborted(cause)) return ABORTED
      return new AssetError(`could not read the body of ${href}`, { cause })
    }
    if (abortedNow(signal)) return ABORTED
    bytes = blob
    validator = readValidator(res.headers)
    const bitmap = await decodeBitmap(env.createImageBitmap, blob, signal, href)
    if (isAborted(bitmap)) return ABORTED
    if (bitmap instanceof Error) return bitmap
    return { bitmap, owned: true }
  }

  /**
   * Reads an ok response into a re-supply report. The two call sites differ only in what the
   * conditional decided — `unverified` where neither validator was exposed and nothing could be
   * asked, `changed` where a `200` said the bytes moved — so the freshness and its warning are
   * what they pass in.
   */
  const takeAsReport = async (
    res: SourceResponse,
    o: ResupplyOptions,
    freshness: SourceFreshness,
    warning: string | undefined,
  ): Promise<ResupplyResult> => {
    if (!res.ok) return new AssetError(`re-supply of ${href} returned ${res.status}`)
    const got = await take(res, o.signal)
    if (isAborted(got)) return ABORTED
    if (got instanceof Error) return got
    return { ...got, freshness, warning }
  }

  const acquire = async (o: AcquireOptions = {}): Promise<AcquireResult> => {
    if (abortedNow(o.signal)) return ABORTED
    const res = await request(o.signal, {})
    if (isAborted(res)) return ABORTED
    if (res instanceof Error) return res
    if (!res.ok) return new AssetError(`fetch of ${href} returned ${res.status}`)
    return take(res, o.signal)
  }

  const resupply = async (o: ResupplyOptions): Promise<ResupplyResult> => {
    if (abortedNow(o.signal)) return ABORTED

    // Neither validator was exposed — the ordinary cross-origin case, and any server that sends
    // neither header. Nothing can be asked, so nothing is: the re-supply proceeds unconditionally
    // and the same-image contract is documented and unenforced. Reported as `unverified` rather
    // than as `unchanged`, because saying so is more honest than papering over it.
    if (validator === undefined) {
      const res = await request(o.signal, {})
      if (isAborted(res)) return ABORTED
      if (res instanceof Error) return res
      return takeAsReport(res, o, 'unverified', undefined)
    }

    const headers: Record<string, string> = {}
    if (validator.etag !== undefined) headers['If-None-Match'] = validator.etag
    if (validator.lastModified !== undefined) headers['If-Modified-Since'] = validator.lastModified

    // No `cache` option is passed. Under the Fetch standard a request carrying `If-None-Match` or
    // `If-Modified-Since` under the default cache mode is treated as `no-store`, so the conditional
    // reaches the origin instead of being answered out of the HTTP cache — which is the only way
    // the `304` / `200` distinction is visible to script at all. Do not "fix" this by adding
    // `cache: 'no-cache'`.
    const res = await request(o.signal, headers)
    if (isAborted(res)) return ABORTED
    if (res instanceof Error) return res

    // 304 first: a 304 is not `ok`, and it is the success case here. Its body is empty by
    // definition, so the rebuild decodes the bytes retained at the first response (§8.5.3) rather
    // than paying a second round trip for bytes the server just said had not changed.
    if (res.status === 304) {
      const retained = bytes
      if (retained === undefined) {
        return new AssetError(`re-supply of ${href} answered 304 with nothing retained to decode`)
      }
      const bitmap = await decodeBitmap(env.createImageBitmap, retained, o.signal, href)
      if (isAborted(bitmap)) return ABORTED
      if (bitmap instanceof Error) return bitmap
      return { bitmap, owned: true, freshness: 'unchanged', warning: undefined }
    }

    // 200. The bytes moved under a key §8.5.1 promised would not move. `take` re-records the
    // validator from this response, so the next conditional request asks about the new bytes.
    return takeAsReport(res, o, 'changed', staleSourceWarning(o.key, href))
  }

  return {
    kind: 'url',
    reclaimable: true,
    borrowed: undefined,
    acquire,
    resupply,
  }
}
