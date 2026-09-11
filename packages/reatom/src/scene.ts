import type {
  ChangeArea,
  Knobs,
  PoseRef,
  SpriteSource,
  StageCommon,
  StageEvent,
  StagePlayOptions,
  StagePlayReport,
  View,
} from '@paper-crumple/core'
import { createSceneController, type BindingStage } from '@paper-crumple/core/bindings'
import {
  abortVar,
  action,
  atom,
  bind,
  context,
  reatomObservable,
  top,
  withAsyncData,
  wrap,
} from '@reatom/core'
import { observeExternal, readAtRevision } from './observable.js'
import { joinReady } from './ready.js'
import { toAsyncValue } from './result.js'
import { createResource } from './resource.js'
import { createViewModel } from './view.js'
import type { Ready, ResourceOptions, SceneOptions, SurfaceSize, ViewOptions } from './types.js'

const emptyKnobs: Readonly<Knobs> = Object.freeze({})
const emptyDescriptors: StageCommon['knobs'] = Object.freeze([])
const emptyWarnings: readonly Error[] = Object.freeze([])

/** Allocate within one model context; readiness is explicit and owns the raw stage lifetime. */
export function reatomScene<S extends BindingStage>({ name, create }: SceneOptions<S>) {
  const owner = top()
  const ownerRoot = owner.root
  const assertOwner = (): void => {
    if (context().root !== ownerRoot)
      toAsyncValue(new Error(`${name} must be used in its owner context`))
  }
  const controller = createSceneController(bind(create, owner))
  const observe = <T>(
    property: string,
    read: () => T,
    areas: readonly ChangeArea[] = ['lifecycle'],
  ) =>
    observeExternal({
      name: `${name}.${property}`,
      owner,
      assertOwner,
      read,
      areas,
      entity: () => controller.stage,
      subscribeReplacement: controller.subscribe,
    })
  const knobs = atom<Knobs>({}, `${name}.knobs`)
  const trackReady = action(async () => {
    const desiredKnobs = knobs()
    const operation = abortVar.require()
    const cancel = bind(() => operation.abort(), owner)
    controller.signal.addEventListener('abort', cancel, { once: true })
    if (controller.signal.aborted) cancel()
    try {
      const stage = toAsyncValue<S>(await wrap(controller.ensure()))
      // Desired keys are dynamic; the core registry owns descriptor and value validation.
      toAsyncValue(stage.set(desiredKnobs as never))
      return stage
    } finally {
      controller.signal.removeEventListener('abort', cancel)
    }
  }, `${name}._ready`).extend(withAsyncData({ initState: null as S | null }))
  const ready: Ready<S> = Object.assign(
    joinReady(
      bind(() => trackReady(), owner),
      () => {
        assertOwner()
        return controller.signal
      },
    ),
    {
      data: trackReady.data,
      error: trackReady.error,
      pending: trackReady.pending,
      ready: trackReady.ready,
    },
  )
  const dispose = action(() => {
    assertOwner()
    controller.dispose()
  }, `${name}.dispose`)
  const play = action(async (from: PoseRef, to: PoseRef, options?: StagePlayOptions) => {
    assertOwner()
    const stage = controller.stage ?? (await wrap(ready()))
    const operation = abortVar.require()
    const stop = bind(() => stage.stop(), owner)
    const cancel = bind(() => operation.abort(), owner)
    operation.signal.addEventListener('abort', stop, { once: true })
    controller.signal.addEventListener('abort', cancel, { once: true })
    try {
      return await wrap(stage.play(from, to, options))
    } finally {
      operation.signal.removeEventListener('abort', stop)
      controller.signal.removeEventListener('abort', cancel)
    }
  }, `${name}.play`).extend(withAsyncData({ initState: null as StagePlayReport<View> | null }))
  let size: SurfaceSize | null = null
  let warnings: readonly Error[] = emptyWarnings
  let event: StageEvent<'error'> | null = null
  // Event history belongs to the explicit scene lifetime, independent of optional observation.
  controller.onError(
    bind((next) => {
      event = next
    }, owner),
  )
  const lastEvent = reatomObservable<StageEvent<'error'> | null>(
    (trigger) => ({
      getState: () => {
        assertOwner()
        return event
      },
      subscribe: () => controller.onError(bind(() => trigger(), owner)),
    }),
    `${name}.lastEvent`,
  )
  const resources = new Map<string, ReturnType<typeof createResource<S>>>()
  const sourceClaims = new Map<
    string,
    { source: SpriteSource; controller: AbortController; replacing: boolean }
  >()
  const claimSource = (key: string, source: SpriteSource): AbortSignal => {
    const previous = sourceClaims.get(key)
    if (previous?.replacing)
      return toAsyncValue<AbortSignal>(
        new Error(
          `resource '${key}' has a source replacement in progress; await replace() before acquiring it`,
        ),
      )
    if (previous !== undefined && !Object.is(previous.source, source))
      toAsyncValue(
        new Error(`resource '${key}' already exists with another source; use replace() explicitly`),
      )
    const claim = previous ?? { source, controller: new AbortController(), replacing: false }
    sourceClaims.set(key, claim)
    return claim.controller.signal
  }
  const beginReplacement = (key: string) => {
    const previous = sourceClaims.get(key)!
    const claim = { source: previous.source, controller: new AbortController(), replacing: true }
    sourceClaims.set(key, claim)
    // Only consumers are cancelled: core still owns any shared acquisition already in flight.
    previous.controller.abort()
    const current = () => sourceClaims.get(key) === claim
    return {
      current,
      settle(source?: SpriteSource) {
        // A committed predecessor is a successor's rollback source, never its active claim.
        if (source !== undefined) claim.source = source
        if (!current() || !claim.replacing) return
        claim.source = source ?? previous.source
        claim.replacing = false
      },
    }
  }
  let viewKey = 0
  const view = <Source extends SpriteSource>(options: ViewOptions<S, Source>) => {
    assertOwner()
    return createViewModel<S>(options, {
      controller,
      ready,
      owner,
      assertOwner,
      claimSource,
      mintKey: () => `${name}.view:${++viewKey}`,
    })
  }
  const resource = <Source extends SpriteSource>(options: ResourceOptions<Source>) => {
    assertOwner()
    claimSource(options.key, options.source)
    const found = resources.get(options.key)
    if (found !== undefined) {
      return found.model
    }
    const entry = createResource(options, {
      controller,
      ready,
      owner,
      assertOwner,
      claimSource,
      beginReplacement,
    })
    resources.set(options.key, entry)
    return entry.model
  }
  return {
    ready,
    dispose,
    resource,
    view,
    play,
    knobs,
    lastEvent,
    raw: observe('raw', () => controller.stage),
    lifecycle: observe('lifecycle', () => controller.status),
    lost: observe('lost', () => controller.lost || (controller.stage?.lost ?? false)),
    warnings: observe('warnings', () => {
      const next = controller.stage?.warnings ?? emptyWarnings
      if (warnings.length !== next.length || warnings.some((item, index) => item !== next[index]))
        warnings = Object.freeze([...next])
      return warnings
    }),
    surface: observe<S['surface'] | null>('surface', () => controller.stage?.surface ?? null),
    surfaceSize: observe(
      'surfaceSize',
      () => {
        const surface = controller.stage?.surface
        if (surface === undefined) return (size = null)
        if (size?.width !== surface.width || size.height !== surface.height)
          size = Object.freeze({ width: surface.width, height: surface.height })
        return size
      },
      ['lifecycle', 'resources'],
    ),
    capabilities: observe('capabilities', () => controller.stage?.caps ?? null),
    descriptors: observe('descriptors', () => controller.stage?.knobs ?? emptyDescriptors),
    defaults: observe('defaults', () => controller.stage?.defaults ?? emptyKnobs),
    appliedKnobs: observe(
      'appliedKnobs',
      readAtRevision(
        () => controller.stage,
        'settings',
        () => controller.stage?.appliedKnobs ?? emptyKnobs,
      ),
      ['settings'],
    ),
  }
}

export type SceneModel<S extends BindingStage> = ReturnType<typeof reatomScene<S>>
