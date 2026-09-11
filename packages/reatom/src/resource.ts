import {
  ABORTED,
  type BitmapSupplier,
  type ChangeArea,
  type Knobs,
  type Sprite,
  type SpriteSource,
} from '@paper-crumple/core'
import {
  createAcquisitions,
  type BindingStage,
  type SceneController,
} from '@paper-crumple/core/bindings'
import { abortVar, action, atom, bind, type Frame, withAsyncData, wrap } from '@reatom/core'
import { observeExternal, readAtRevision } from './observable.js'
import { cancelWithOwner } from './owner.js'
import { toAsyncValue } from './result.js'
import type { Ready, ResourceOptions, ResourceReplace } from './types.js'

const emptyKnobs: Readonly<Knobs> = Object.freeze({})

/** Scene-owned model allocation; the public entry point is scene.resource's identity cache. */
export function createResource<S extends BindingStage>(
  options: ResourceOptions<SpriteSource>,
  scope: { controller: SceneController<S>; ready: Ready<S>; owner: Frame; assertOwner(): void },
) {
  const { name, key } = options
  const { controller, owner, assertOwner } = scope
  let registeredSource = options.source
  let pin = options.pin
  const source = atom<SpriteSource>(() => options.source, `${name}.source`)
  const knobs = atom<Knobs>({}, `${name}.knobs`)
  const suppliers = new WeakMap<BitmapSupplier, BitmapSupplier>()
  const coreSource = (desired: SpriteSource): SpriteSource => {
    if (typeof desired !== 'function') return desired
    let bound = suppliers.get(desired)
    if (bound === undefined) {
      // Core retains suppliers for later re-supply, outside the initiating command's frame.
      bound = bind(desired, owner)
      suppliers.set(desired, bound)
    }
    return bound
  }
  const readRaw = () => controller.stage?.get(key) ?? null
  const subscribeReplacement = (trigger: () => void) => {
    let stage = controller.stage
    let offStage = stage?.changes.subscribe('resources', trigger)
    const offController = controller.subscribe(
      bind(() => {
        const next = controller.stage
        if (next !== stage) {
          offStage?.()
          stage = next
          offStage = next?.changes.subscribe('resources', trigger)
        }
        trigger()
      }, owner),
    )
    return () => {
      offController()
      offStage?.()
    }
  }
  const observe = <T>(property: string, read: () => T, areas: readonly ChangeArea[]) =>
    observeExternal({
      name: `${name}.${property}`,
      owner,
      assertOwner,
      read,
      areas,
      entity: readRaw,
      subscribeReplacement,
    })
  const prepare = action(async () => {
    assertOwner()
    const desiredSource = source()
    const desiredKnobs = knobs()
    const signal = abortVar.require().signal
    const release = cancelWithOwner(controller.signal)
    try {
      const stage = await wrap(scope.ready())
      if (controller.stage !== stage) return toAsyncValue<Sprite>(ABORTED)
      if (stage.get(key) !== undefined && !Object.is(desiredSource, registeredSource)) {
        return toAsyncValue<Sprite>(
          new Error(`resource '${key}' changed source; use replace() explicitly`),
        )
      }
      const sprite = toAsyncValue<Sprite>(
        await wrap(createAcquisitions(stage).acquire(key, coreSource(desiredSource), pin, signal)),
      )
      // Dynamic descriptor keys are validated by core's registry, as in the core view binding.
      toAsyncValue(sprite.set(desiredKnobs as never))
      registeredSource = desiredSource
      return sprite
    } finally {
      release()
    }
  }, `${name}.prepare`).extend(withAsyncData({ initState: null as Sprite | null }))
  const replace: ResourceReplace = action(
    async (next: SpriteSource, nextOptions?: { pin?: true }) => {
      assertOwner()
      const desiredKnobs = knobs()
      const signal = abortVar.require().signal
      const release = cancelWithOwner(controller.signal)
      try {
        source.set(() => next)
        const stage = await wrap(scope.ready())
        if (controller.stage !== stage) return toAsyncValue<Sprite>(ABORTED)
        if (nextOptions?.pin) stage.pin(key)
        const sprite = toAsyncValue<Sprite>(
          await wrap(stage.replace(key, coreSource(next), { signal })),
        )
        registeredSource = next
        pin = nextOptions?.pin ?? pin
        toAsyncValue(sprite.set(desiredKnobs as never))
        return sprite
      } finally {
        release()
      }
    },
    `${name}.replace`,
  ).extend(withAsyncData({ initState: null as Sprite | null }))
  const remove = action((removeOptions?: { detach?: true }) => {
    assertOwner()
    return toAsyncValue<void>(controller.stage?.remove(key, removeOptions))
  }, `${name}.remove`)
  return {
    matchesSource: (next: SpriteSource) => Object.is(next, registeredSource),
    model: {
      key,
      source,
      knobs,
      prepare,
      replace,
      remove,
      raw: observe('raw', readRaw, []),
      resident: observe('resident', () => readRaw()?.resident ?? false, ['resources']),
      frontSize: observe(
        'frontSize',
        readAtRevision(readRaw, 'geometry', () => readRaw()?.frontSize ?? null),
        ['geometry'],
      ),
      rect: observe('rect', () => readRaw()?.rect ?? null, ['geometry']),
      attachCount: observe('attachCount', () => readRaw()?.attachCount ?? 0, ['resources']),
      pinned: observe('pinned', () => readRaw()?.pinned ?? false, ['resources']),
      appliedKnobs: observe(
        'appliedKnobs',
        readAtRevision(readRaw, 'settings', () => readRaw()?.appliedKnobs ?? emptyKnobs),
        ['settings'],
      ),
    },
  }
}

export type ResourceModel = ReturnType<typeof createResource>['model']
