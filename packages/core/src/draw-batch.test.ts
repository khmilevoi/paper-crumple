import { describe, expect, it } from 'vitest'
import { batchBySortKey } from './draw-batch.js'

const key = (x: { k: string }) => x.k

describe('batchBySortKey', () => {
  it('groups equal keys together', () => {
    const items = [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: 'c' }, { k: 'b' }]
    expect(batchBySortKey(items, key).map(key)).toEqual(['a', 'a', 'b', 'b', 'c'])
  })

  it('keeps first-seen group order, because the core cannot interpret the key', () => {
    // `sortKey` is opaque: the slot decides what makes two draws cheap to schedule adjacently,
    // and the core sorts by an equality key it cannot interpret. Lexical order would be an
    // interpretation.
    const items = [{ k: 'z' }, { k: 'a' }, { k: 'z' }]
    expect(batchBySortKey(items, key).map(key)).toEqual(['z', 'z', 'a'])
  })

  it('is stable within a group, so registration order survives batching', () => {
    const items = [
      { k: 'a', i: 0 },
      { k: 'a', i: 1 },
      { k: 'a', i: 2 },
    ]
    expect(batchBySortKey(items, (x) => x.k).map((x) => x.i)).toEqual([0, 1, 2])
  })

  it('returns an empty array unchanged and never mutates its input', () => {
    const items = [{ k: 'b' }, { k: 'a' }]
    const copy = [...items]
    batchBySortKey(items, key)
    expect(items).toEqual(copy)
    expect(batchBySortKey([], key)).toEqual([])
  })
})
