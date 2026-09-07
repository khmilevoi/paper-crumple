/**
 * What the smoothness bench imports from the library: the GL bench's dist entry points
 * (`../gl/deps.ts` explains why dist and why relative) plus the paper tiles the playground mounts.
 */
export {
  bakedMotion,
  isAborted,
  pack1x1,
  pack2x3,
  pack3x2,
  paperSheet,
  paperStage,
} from '../gl/deps.js'
export type { Sprite, View } from '../gl/deps.js'
export type { BlitStage } from '../../../packages/core/dist/index.js'
export { tiles } from '../../../packages/paper/dist/tiles.js'
