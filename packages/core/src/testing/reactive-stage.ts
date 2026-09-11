import { isAborted } from '../abort.js'
import { expect } from 'vitest'
import { createStage, type BlitStage } from '../stage.js'
import { fakeMotion, fakeSheet, stageEnv } from './fake-slots.js'

/** Real stage, fake platform and rendering slots; no stage behavior is replaced. */
export async function makeReactiveStage(): Promise<BlitStage> {
  const stage = await createStage(
    { sheet: fakeSheet(), motion: fakeMotion(), maxSize: 384, present: 'blit' },
    stageEnv(),
  )
  if (stage instanceof Error || isAborted(stage)) return expect.fail('stage refused')
  return stage
}

export function makeReactiveCanvas(css = { width: 150, height: 75 }) {
  const ops: string[] = []
  const ctx2d = {
    clearRect: (...a: number[]) => ops.push(`clearRect(${a.join(',')})`),
    drawImage: (...a: unknown[]) => ops.push(`drawImage(${a.slice(1).join(',')})`),
  }
  return {
    width: 300,
    height: 150,
    ops,
    getContext: (id: string) => (id === '2d' ? ctx2d : null),
    getBoundingClientRect: () => ({ width: css.width, height: css.height }),
  } as unknown as HTMLCanvasElement & { ops: string[] }
}
