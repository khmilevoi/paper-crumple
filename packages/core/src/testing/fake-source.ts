/**
 * Level-1 doubles for the sprite source path (§11).
 *
 * **Test-only source.** Reachable from neither `index.ts` nor `unstable.ts`, so `tsdown` bundles
 * none of it and it ships in no tarball. A plain `.ts` file rather than a `.test.ts` one, so other
 * suites import it without Vitest collecting it as a suite of its own — the convention
 * `testing/fake-timers.ts` established.
 *
 * Node has no `ImageBitmap`, no `HTMLImageElement`, no `HTMLCanvasElement` and no
 * `createImageBitmap`, which is exactly why `source.ts` injects its two boundaries and classifies
 * by `Symbol.toStringTag` and shape rather than by `instanceof`. These doubles carry the same tag
 * a real one carries, so the classification they exercise is the classification a browser runs.
 */

import type { SourceDecode, SourceFetch, SourceResponse } from '../source.js'

/** An `ImageBitmap` double that detaches like the real thing and counts its own closes. */
export interface FakeBitmap {
  readonly [Symbol.toStringTag]: string
  readonly width: number
  readonly height: number
  close(): void
  /** How many times `close()` was called. §8.5.4 wants exactly one — and zero when borrowed. */
  readonly closes: number
}

/**
 * A closed bitmap reports `width === 0 && height === 0`, which is how a detached one is detected
 * without a private flag. `createImageBitmap` never produces a zero dimension, so the test is
 * sound in the other direction too.
 */
export function fakeBitmap(o: { width?: number; height?: number } = {}): FakeBitmap {
  const width = o.width ?? 64
  const height = o.height ?? 64
  let open = true
  let closes = 0
  return {
    [Symbol.toStringTag]: 'ImageBitmap',
    get width() {
      return open ? width : 0
    },
    get height() {
      return open ? height : 0
    },
    get closes() {
      return closes
    },
    close() {
      closes += 1
      open = false
    },
  }
}

/** `FakeBitmap` where an `ImageBitmap` is wanted. Structurally compatible; the cast is a formality. */
export function asBitmap(b: FakeBitmap): ImageBitmap {
  return b
}

export function fakeImage(): HTMLImageElement {
  return {
    [Symbol.toStringTag]: 'HTMLImageElement',
    nodeType: 1,
    tagName: 'IMG',
  } as unknown as HTMLImageElement
}

export function fakeCanvas(): HTMLCanvasElement {
  return {
    [Symbol.toStringTag]: 'HTMLCanvasElement',
    nodeType: 1,
    tagName: 'CANVAS',
  } as unknown as HTMLCanvasElement
}

/** Compressed bytes. The content is never decoded here; identity is what the tests assert. */
export function blobOf(text = 'png-bytes'): Blob {
  return new Blob([text], { type: 'image/png' })
}

export interface DecodeStub {
  readonly decode: SourceDecode
  /** Everything the decoder was handed, in order. */
  readonly calls: readonly unknown[]
  /** Every bitmap it produced, in order, so a test can assert who closed what. */
  readonly produced: readonly FakeBitmap[]
}

export function stubDecode(): DecodeStub {
  const calls: unknown[] = []
  const produced: FakeBitmap[] = []
  return {
    calls,
    produced,
    decode: (src) => {
      calls.push(src)
      const b = fakeBitmap()
      produced.push(b)
      return Promise.resolve(asBitmap(b))
    },
  }
}

/** A decoder that fails the way `createImageBitmap` fails: a rejected promise. */
export function failingDecode(cause: unknown): SourceDecode {
  return () => Promise.reject(cause)
}

/** A decoder that settles only when `release()` is called — the abort-during-decode case. */
export interface DeferredDecode extends DecodeStub {
  release(): void
}

export function deferredDecode(): DeferredDecode {
  const calls: unknown[] = []
  const produced: FakeBitmap[] = []
  const pending: Array<() => void> = []
  return {
    calls,
    produced,
    decode: (src) => {
      calls.push(src)
      return new Promise<ImageBitmap>((resolve) => {
        pending.push(() => {
          const b = fakeBitmap()
          produced.push(b)
          resolve(asBitmap(b))
        })
      })
    },
    release() {
      for (const settle of pending.splice(0)) settle()
    },
  }
}

export interface StubResponse {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Blob
}

export interface FetchCall {
  readonly input: string | URL
  readonly headers: Record<string, string>
}

export interface FetchStub {
  readonly fetch: SourceFetch
  /** Every request, in order: what was fetched and which headers went with it. */
  readonly calls: readonly FetchCall[]
  /** Every body actually read, in order. Identity matters: a `304` must read none. */
  readonly bodies: readonly Blob[]
}

/**
 * Answers the scripted responses in order. A request past the end of the script is answered `599`,
 * which no branch treats as success, so a test that over-fetches fails on its own assertion
 * instead of hanging or silently reusing the last response.
 */
export function stubFetch(script: readonly StubResponse[]): FetchStub {
  const calls: FetchCall[] = []
  const bodies: Blob[] = []
  let next = 0
  return {
    calls,
    bodies,
    fetch: (input, init) => {
      calls.push({ input, headers: { ...(init?.headers ?? {}) } })
      const spec = script[next]
      next += 1
      const status = spec?.status ?? (spec === undefined ? 599 : 200)
      const headers = spec?.headers ?? {}
      const body = spec?.body
      const lower = new Map<string, string>()
      for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v)
      const res: SourceResponse = {
        ok: status >= 200 && status < 300,
        status,
        // Real `Headers.get` is case-insensitive and returns `null` for a header the response did
        // not expose. A cross-origin response without `Access-Control-Expose-Headers: ETag` is
        // reproduced exactly by scripting no headers at all.
        headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
        blob: () => {
          const b = body ?? blobOf()
          bodies.push(b)
          return Promise.resolve(b)
        },
      }
      return Promise.resolve(res)
    },
  }
}
