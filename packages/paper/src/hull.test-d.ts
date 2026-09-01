import { expectTypeOf } from 'vitest'
import type { HullCanvas, HullRasterContext } from './hull.js'

// Test that HTMLCanvasElement structurally satisfies HullCanvas
expectTypeOf<HTMLCanvasElement>().toMatchTypeOf<HullCanvas>()

// Test that OffscreenCanvas structurally satisfies HullCanvas
expectTypeOf<OffscreenCanvas>().toMatchTypeOf<HullCanvas>()

// Test that CanvasRenderingContext2D structurally satisfies HullRasterContext
expectTypeOf<CanvasRenderingContext2D>().toMatchTypeOf<HullRasterContext>()
