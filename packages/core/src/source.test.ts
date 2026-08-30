import { describe, expect, it } from 'vitest'
import { AssetError } from './errors.js'
import { classifySource } from './source.js'
import { blobOf, fakeBitmap, fakeCanvas, fakeImage } from './testing/fake-source.js'

describe('classifySource, over the seven arms of the union (§4.1, amendment 9)', () => {
  it('collapses string and URL to one kind, because they normalise to the same fetch', () => {
    expect(classifySource('/sweater.png')).toEqual({ kind: 'url', src: '/sweater.png' })
    const u = new URL('https://cdn.example/sweater.png')
    expect(classifySource(u)).toEqual({ kind: 'url', src: u })
  })

  it('classifies a Blob, and a File with it — a File is a Blob and an upload is the real case', () => {
    const b = blobOf()
    expect(classifySource(b)).toEqual({ kind: 'blob', src: b })
    const f = new File([new Uint8Array([1])], 'sweater.png', { type: 'image/png' })
    expect(classifySource(f)).toEqual({ kind: 'blob', src: f })
  })

  it('classifies the three arms no re-supplier can be derived from', () => {
    const bitmap = fakeBitmap()
    const img = fakeImage()
    const canvas = fakeCanvas()
    expect(classifySource(bitmap)).toEqual({ kind: 'bitmap', src: bitmap })
    expect(classifySource(img)).toEqual({ kind: 'image', src: img })
    expect(classifySource(canvas)).toEqual({ kind: 'canvas', src: canvas })
  })

  it('classifies a supplier function', () => {
    const supply = async () => fakeBitmap() as unknown as ImageBitmap
    expect(classifySource(supply)).toEqual({ kind: 'supplier', src: supply })
  })

  it('falls back to shape when the object carries no Symbol.toStringTag', () => {
    // The tag is how a cross-realm bitmap — one an iframe produced — classifies correctly where
    // `instanceof` would answer false. The structural fallback is for the object that has neither.
    const untagged = { width: 8, height: 8, close: () => {} } as unknown as ImageBitmap
    expect(classifySource(untagged)).toEqual({ kind: 'bitmap', src: untagged })
    const bareCanvas = { nodeType: 1, tagName: 'canvas' } as unknown as HTMLCanvasElement
    expect(classifySource(bareCanvas)).toEqual({ kind: 'canvas', src: bareCanvas })
  })
})

describe('classifySource, over input that is not a source', () => {
  const HOSTILE: readonly unknown[] = [
    undefined,
    null,
    0,
    Number.NaN,
    true,
    Symbol('nope'),
    {},
    [],
    new Map(),
    new Date(),
  ]

  it('returns an AssetError and never throws', () => {
    for (const x of HOSTILE) {
      const r = classifySource(x)
      expect(AssetError.is(r)).toBe(true)
      expect(r).toBeInstanceOf(Error)
    }
  })

  it('names the union in the message, because the caller passed the wrong thing on purpose', () => {
    const r = classifySource(42)
    expect(r).toBeInstanceOf(Error)
    expect(String(r)).toContain('SpriteSource')
  })
})
