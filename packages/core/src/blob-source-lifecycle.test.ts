/**
 * # A `Blob` source is reclaimable (spec §2.9, source.ts:22-28)
 *
 * `SpriteSource` accepts a `Blob` and the library derives the re-supplier itself — the `Blob` is
 * retained and re-decoded — so a `Blob` sprite is LRU-reclaimable and the byte budget bounds it.
 * A dropped `File` IS a `Blob`, which is what lets a consumer pass the file straight to `add()`
 * instead of minting an object URL it then has to revoke. Nothing tested that claim end to end:
 * the `Blob`s elsewhere in the suite are fake fetch bodies on the *url* arm.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { isAborted } from './abort.js'
import type { PinFor, SpriteSource } from './source.js'
import type { Sprite } from './sprite.js'
import { createStage } from './stage.js'
import type { StageOptions } from './stage-types.js'
import { asBitmap, fakeBitmap } from './testing/fake-source.js'
import { fakeMotion, fakeSheet, stageEnv } from './testing/fake-slots.js'

const base = (): StageOptions => ({ sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384 })

describe('a Blob SpriteSource', () => {
  it('is re-decoded from the retained Blob after the budget drops its front', async () => {
    const decoded: (Blob | HTMLImageElement | HTMLCanvasElement)[] = []
    const blob = new Blob(['png'], { type: 'image/png' })
    const stage = await createStage(
      { ...base(), present: 'blit' },
      stageEnv({
        sourceEnv: {
          createImageBitmap: async (src) => {
            decoded.push(src)
            return asBitmap(fakeBitmap({ width: 40, height: 30 }))
          },
        },
      }),
    )
    if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')

    // No `pin` — a Blob is not a PinnedSource, so the type does not demand one.
    const a = await stage.add(blob, { key: 'a' })
    if (a instanceof Error || isAborted(a)) return expect.fail('add refused')
    expect(decoded).toEqual([blob])

    // `b` is an unreclaimable pinned bitmap that takes the one artwork slot; the budget then drops
    // `a`'s front, which is the only way to reach the re-source path.
    const b = await stage.add(asBitmap(fakeBitmap()), { key: 'b', pin: true })
    if (b instanceof Error || isAborted(b)) return expect.fail('add refused')
    stage.budget({ bytes: 1 })
    expect(stage.usage().fronts).toBe(1)

    const rebuilt = await stage.prepare('a')
    expect(rebuilt instanceof Error || isAborted(rebuilt)).toBe(false)
    expect((rebuilt as Sprite).key).toBe('a')
    expect(stage.usage().fronts).toBe(2)
    // The rebuild went back to the SAME Blob object — nothing was re-fetched and nothing was
    // stashed as a URL. This is the whole of §2.9's premise.
    expect(decoded).toEqual([blob, blob])
    expect(decoded[1]).toBe(blob)

    stage.dispose()
  })

  it('needs no pin flag, and a File satisfies the same arm', () => {
    // `PinFor` is what makes `pin: true` mandatory for the three unreclaimable arms. A Blob is not
    // one of them, so the flag stays optional — this is the type-level half of the claim above,
    // enforced by `pnpm typecheck` rather than at runtime.
    expectTypeOf<PinFor<Blob>>().toEqualTypeOf<{ pin?: true }>()
    expectTypeOf<Blob>().toExtend<SpriteSource>()
    // A dropped File is a Blob by TypeScript's own lib declaration, which is the fact the
    // playground's `File` handling (P7) and USAGE §6 (P8) rest on.
    expectTypeOf<File>().toExtend<Blob>()
    expectTypeOf<File>().toExtend<SpriteSource>()
  })
})
