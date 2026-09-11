import {
  GlError,
  type BlitStage,
  type PlayOptions,
  type PoseRef,
  type SpriteSource,
  type View,
} from '@paper-crumple/core'
import {
  artworkStyleFor,
  frameStyleFor,
  createCrumpleCore,
  readCrumple,
  createSceneController,
  createViewController,
  type CrumpleReading,
  type SceneController,
  type ViewController,
  type ViewInputs,
} from '@paper-crumple/core/bindings'
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Crumple } from './crumple.js'
import type { CrumpleOptions } from './crumple-types.js'
import { useScene } from './scene-context.js'
import { createVersionedStore } from './store.js'
import { useEvent } from './use-event.js'

// External Scene values and usePaperScene values keep the same public shape. The raw stage
// identifies the internal lifetime; metadata remains on the public SceneBuild.
const lifetimes = new WeakMap<BlitStage, SceneController<BlitStage>>()
function sceneFor(stage: BlitStage): SceneController<BlitStage> {
  let scene = lifetimes.get(stage)
  if (scene === undefined) {
    scene = createSceneController(async () => stage)
    lifetimes.set(stage, scene)
  }
  return scene
}

interface Live {
  controller: ViewController | null
  canvas: HTMLCanvasElement | null
  createdView: View | null
  created: Pick<ViewInputs, 'fit' | 'tag'> | null
  warned: boolean
}

export function useCrumple<S extends SpriteSource>(o: CrumpleOptions<S>): Crumple {
  const provided = useScene()
  const scene = o.scene ?? provided
  const latest = useEvent((): ViewInputs => ({
    ...o,
    key: o.spriteKey,
    source: o.src,
    pin: (o as CrumpleOptions<SpriteSource>).pin,
  }))
  const [empty] = useState(createCrumpleCore)
  const [sourcePairs] = useState(() => new Map<string, SpriteSource>())
  const [live] = useState<Live>(() => ({
    controller: null,
    canvas: null,
    createdView: null,
    created: null,
    warned: false,
  }))
  const [store] = useState(() =>
    createVersionedStore<CrumpleReading>(() => live.controller?.read() ?? readCrumple(empty)),
  )
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  // Props are read in render, so the wrapper and artwork box move in the same commit.
  const frameStyle = useMemo(
    () => frameStyleFor(snapshot.frame, o.frameTo),
    [snapshot.frame, o.frameTo],
  )
  const artworkStyle = useMemo(
    () => artworkStyleFor(snapshot.frame, o.frameTo),
    [snapshot.frame, o.frameTo],
  )
  const width = frameStyle?.width ?? null
  const height = frameStyle?.height ?? null
  useLayoutEffect(() => {
    if (width !== null && height !== null) live.controller?.view?.refresh()
  }, [width, height, live])

  const ref = useEvent((canvas: HTMLCanvasElement | null): void => {
    // eslint-disable-next-line react-hooks/immutability -- This stable record owns the external controller; the versioned store publishes changes.
    live.canvas = canvas
    live.controller?.ref(canvas)
  })
  const stage = scene.status === 'ready' ? scene.stage : null
  useEffect(() => {
    if (stage === null) return
    const lifetime = sceneFor(stage)
    const controller = createViewController({
      ...latest(),
      scene: lifetime,
      sourcePairs,
      state: empty,
      readLatest: latest,
      onChange: () => {
        if (live.controller !== controller) return
        if (controller.view !== null && controller.view !== live.createdView) {
          live.createdView = controller.view
          live.created = { fit: latest().fit, tag: latest().tag }
          live.warned = false
        }
        store.bump()
      },
      // The legacy React snapshot still tracks every pose. Other adapters can omit this.
      onStep: () => store.bump(),
    })
    // eslint-disable-next-line react-hooks/immutability -- Controller ownership is external state, published through store.bump().
    live.controller = controller
    controller.ref(live.canvas)
    let active = true
    void lifetime.ensure().then(() => {
      if (!active || controller.view !== null || !lifetime.disposed) return
      empty.error = new GlError('this stage is disposed; build a new one')
      live.controller = null
      store.bump()
      latest().onError?.({ error: empty.error, observed: true, view: null })
    })
    return () => {
      active = false
      controller.detach()
      if (live.controller === controller) live.controller = null
      live.createdView = null
      store.bump()
    }
  }, [stage, latest, live, empty, sourcePairs, store])

  const view = snapshot.view
  useEffect(() => {
    if (view !== null) void live.controller?.request()
  }, [view, o.spriteKey, o.src, live])

  useEffect(() => {
    const created = live.created
    const environment = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
    if (environment?.NODE_ENV === 'production' || created === null || live.warned) return
    if (created.fit === o.fit && created.tag === o.tag) return
    // eslint-disable-next-line react-hooks/immutability -- The per-View warning latch is external bookkeeping, not render state.
    live.warned = true
    console.warn(
      "[paper-crumple] useCrumple: 'fit' and 'tag' are fixed when the view is created and a change " +
        'to either has no effect. This view was created with fit=' +
        String(created.fit) +
        ' tag=' +
        String(created.tag) +
        ' and now sees fit=' +
        String(o.fit) +
        ' tag=' +
        String(o.tag) +
        '. Remount the <Crumple> under a new React key to apply new values.',
    )
  }, [o.fit, o.tag, view, live])

  useEffect(() => live.controller?.prepare(), [scene.knobEpoch, live])
  const play = useEvent(
    (from: PoseRef, to: PoseRef, options?: PlayOptions) =>
      live.controller?.play(from, to, options) ?? null,
  )
  const stop = useEvent((): void => {
    live.controller?.stop()
  })
  const refresh = useEvent((): void => {
    live.controller?.refresh()
  })
  const draw = useEvent((pose: PoseRef): void => {
    live.controller?.draw(pose)
  })
  const sync = useEvent((): void => {
    store.bump()
  })
  const retry = useEvent((): void => {
    void live.controller?.retry()
  })
  return { ...snapshot, frameStyle, artworkStyle, ref, play, stop, refresh, draw, sync, retry }
}
