/** Shared observer-only variation. Workloads continue to issue the exact same raw commands. */
export async function observeReactivity(mode, stage, cells, api) {
  const counts = {
    activeStepSubscriptions: 0,
    activeSemanticSubscriptions: 0,
    semanticPublications: 0,
    progressPublications: 0,
    frameReads: 0,
  }
  const restore = []
  const offs = []
  let disposeModels = () => {}
  let flush = () => {}
  let closed = false
  const disconnect = () => {
    for (const off of offs.splice(0)) off()
    flush()
  }
  const observation = {
    flush: () => flush(),
    snapshot: () => ({ mode, ...counts }),
    disconnect,
    dispose() {
      if (closed) return
      closed = true
      disconnect()
      disposeModels()
      for (const undo of restore.reverse()) undo()
    },
  }
  for (const { view } of cells) {
    const descriptor = Object.getOwnPropertyDescriptor(view, 'frame')
    if (descriptor?.get) {
      Object.defineProperty(view, 'frame', {
        ...descriptor,
        get() {
          counts.frameReads++
          return descriptor.get.call(this)
        },
      })
      restore.push(() => Object.defineProperty(view, 'frame', descriptor))
    }
  }
  if (mode === 'raw') return observation
  const { bind, context, notify, wrap, reatomScene } = api
  const owner = context.start()
  try {
    await bind(async () => {
      const scene = reatomScene({ name: `bench.${mode}`, create: async () => stage })
      disposeModels = bind(() => {
        scene.dispose()
        context.reset()
      }, owner)
      flush = bind(notify, owner)
      await wrap(scene.ready())
      for (const [i, cell] of cells.entries()) {
        const model = scene.view({
          name: `bench.${mode}.view${i}`,
          source: cell.source,
          key: cell.view.sprite.key,
          // Adapter attachment is setup only; finish its existing-content swap before timing.
          duration: 0,
          createView: () => cell.view,
        })
        model.attach({ canvas: cell.canvas })
        await wrap(api.settleReady ? api.settleReady(model.ready()) : model.ready())
        // Count the native connections made by observation, after command-controller setup.
        const view = cell.view
        const on = view.on
        view.on = function (event, listener) {
          const off = on.call(this, event, listener)
          if (event === 'step') counts.activeStepSubscriptions++
          let active = true
          return () => {
            if (!active) return
            active = false
            if (event === 'step') counts.activeStepSubscriptions--
            off()
          }
        }
        const subscribe = view.changes.subscribe
        view.changes.subscribe = function (area, listener) {
          const off = subscribe.call(this, area, listener)
          counts.activeSemanticSubscriptions++
          let active = true
          return () => {
            if (!active) return
            active = false
            counts.activeSemanticSubscriptions--
            off()
          }
        }
        restore.push(() => {
          view.on = on
          view.changes.subscribe = subscribe
        })
        for (const atom of [model.shown, model.frame, model.appliedKnobs])
          offs.push(
            atom.subscribe(() => {
              counts.semanticPublications++
            }),
          )
        if (mode === 'progress')
          offs.push(
            model.progress.subscribe(() => {
              counts.progressPublications++
            }),
          )
      }
      notify()
    }, owner)()
    return observation
  } catch (error) {
    observation.dispose()
    return Promise.reject(error)
  }
}
