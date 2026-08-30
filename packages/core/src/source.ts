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
