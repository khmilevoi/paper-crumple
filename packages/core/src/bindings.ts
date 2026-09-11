/** Framework-free lifetime helpers shared by adapters. */
export { createAcquisitions } from './bindings/acquire.js'
export type { Acquisition, AcquisitionStage, Acquisitions } from './bindings/acquire.js'
export { createRequestGate } from './bindings/request.js'
export type { RequestGate } from './bindings/request.js'
export { createSceneController } from './bindings/scene.js'
export { createTargetViewController, createViewController } from './bindings/view.js'
export { artworkStyleFor, frameStyleFor } from './bindings/frame.js'
export {
  createCrumpleCore,
  onRunStart,
  onRunStep,
  onRunEnd,
  readCrumple,
} from './bindings/state.js'
export type { CrumpleCore, CrumpleReading } from './bindings/state.js'
export type {
  RenderValue,
  TargetFor,
  TargetViewController,
  ViewController,
  ViewControllerOptions,
  ViewInputs,
  Entrance,
  ReducedMotion,
  CrumpleState,
  CrumpleStatus,
  CrumpleFrameStyle,
  CrumpleArtworkStyle,
  CrumplePending,
  CrumpleSettleEvent,
  CrumpleSnapshot,
  CrumpleMethods,
} from './bindings/types.js'
export type {
  BindingStage,
  SceneController,
  SceneControllerStatus,
  SceneFactory,
} from './bindings/types.js'
