/** @vitest-environment jsdom */
import { Crumple } from '@paper-crumple/react'
import {
  action,
  bind,
  clearStack,
  context,
  isAbort,
  notify,
  withAsyncData,
  wrap,
} from '@reatom/core'
import { reatomComponent, reatomContext } from '@reatom/react'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { reatomScene } from '@paper-crumple/reatom'
import { render, flush } from '../../react/src/testing/render.js'
import { deferred, sceneFixture } from './testing.js'
import { asBitmap, fakeBitmap } from '../../core/src/testing/fake-source.js'

beforeEach(() => {
  // jsdom replaces DOMException but retains Node's Error/AbortController. Match the
  // latter's native realm so Reatom's instanceof Error cancellation check is meaningful.
  vi.stubGlobal('DOMException', (AbortSignal.abort().reason as Error).constructor)
  expect(new DOMException('fixture abort', 'AbortError')).toBeInstanceOf(Error)
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect() {},
    drawImage() {},
  } as unknown as CanvasRenderingContext2D)
})

it('keeps initial source failure on ready.error and distinct owner scenes independent', async () => {
  const owners = [context.start(), context.start()]
  const fixtures = await Promise.all([sceneFixture(), sceneFixture()])
  const models = owners.map((owner, index) =>
    bind(() => {
      const scene = reatomScene({
        name: `owner.${index}`,
        create: async () => fixtures[index]!.stage,
      })
      const picture = scene.view({
        name: 'picture',
        source: index === 0 ? async () => new Error('source unavailable') : '/ok.webp',
      })
      return { scene, picture }
    }, owner)(),
  )
  const Picture = reatomComponent<{ index: number }>(({ index }) => {
    const picture = models[index]!.picture
    return (
      <>
        <Crumple value={picture.render()} />
        <output>{String(picture.ready.error() ?? '')}</output>
      </>
    )
  }, 'OwnedPicture')
  const mounted = await render(
    <>
      {owners.map((owner, index) => (
        <reatomContext.Provider key={index} value={owner}>
          <Picture index={index} />
        </reatomContext.Provider>
      ))}
    </>,
  )
  try {
    await act(async () => {
      await Promise.all(
        models.map(({ picture }, index) => bind(picture.ready, owners[index]!)().catch(() => {})),
      )
      owners.forEach((owner) => bind(notify, owner)())
    })
    expect(mounted.container.textContent).toContain('AssetError')
    expect(bind(models[0]!.picture.ready.error, owners[0]!)()).toBeTruthy()
    expect(bind(models[0]!.picture.swap.error, owners[0]!)()).toBeUndefined()
    expect(bind(models[1]!.picture.sprite, owners[1]!)()).not.toBeNull()
    bind(models[0]!.scene.dispose, owners[0]!)()
    expect(bind(models[1]!.scene.raw, owners[1]!)()).toBe(fixtures[1]!.stage)
    expect(bind(models[1]!.picture.raw, owners[1]!)()).not.toBeNull()
  } finally {
    await mounted.unmount()
    models.forEach(({ scene }, index) => bind(scene.dispose, owners[index]!)())
    owners.forEach((owner) => bind(context.reset, owner)())
  }
})

it('handles event-launched cancellation on unmount without losing shared scene resources', async () => {
  const owner = context.start()
  const { stage } = await sceneFixture()
  const source = deferred<ImageBitmap>()
  const entered = deferred<void>()
  const { scene, picture } = bind(() => {
    const scene = reatomScene({ name: 'cancel.scene', create: async () => stage })
    return { scene, picture: scene.view({ name: 'picture', source: '/first.webp' }) }
  }, owner)()
  const rejected = deferred<unknown>()
  const Picture = reatomComponent(
    () => (
      <>
        <Crumple value={picture.render()} />
        <button
          onClick={wrap(() => {
            void picture
              .swap(() => {
                entered.resolve()
                return source.promise
              })
              .catch(rejected.resolve)
          })}
        >
          Load
        </button>
      </>
    ),
    'CancelPicture',
  )
  const mounted = await render(
    <reatomContext.Provider value={owner}>
      <Picture />
    </reatomContext.Provider>,
  )
  try {
    await act(async () => {
      await bind(picture.ready, owner)()
    })
    const sprite = bind(picture.sprite, owner)()
    await act(async () => {
      mounted.container.querySelector('button')!.click()
      await entered.promise
    })
    await mounted.unmount()
    const reason = await rejected.promise
    expect(reason).toBeInstanceOf(Error)
    expect(isAbort(reason)).toBe(true)
    expect(bind(picture.swap.error, owner)()).toBeUndefined()
    expect(bind(picture.raw, owner)()).toBeNull()
    expect(bind(scene.raw, owner)()).toBe(stage)
    expect(stage.get(sprite!.key)).toBe(sprite)
    source.resolve(asBitmap(fakeBitmap()))
    await flush()
    expect(bind(picture.raw, owner)()).toBeNull()
  } finally {
    source.resolve(asBitmap(fakeBitmap()))
    bind(scene.dispose, owner)()
    bind(context.reset, owner)()
  }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  clearStack()
})

it('renders the approved DX in its owner Provider with independent data and error subscriptions', async () => {
  const owner = context.start()
  const { stage } = await sceneFixture()
  const { scene, picture, nextArtwork } = bind(() => {
    const scene = reatomScene({ name: 'artwork.scene', create: async () => stage })
    const picture = scene.view({ name: 'artwork.picture', source: '/first.webp' })
    const nextArtwork = action(async (source: string) => {
      await wrap(picture.swap(source))
      return source
    }, 'artwork.next').extend(withAsyncData({ initState: null as string | null }))
    return { scene, picture, nextArtwork }
  }, owner)()
  const rejection = vi.fn()
  const renders = { data: 0, error: 0 }
  const Result = reatomComponent(() => {
    renders.data++
    return <output data-testid="result">{nextArtwork.data() ?? ''}</output>
  }, 'Result')
  const Failure = reatomComponent(() => {
    renders.error++
    return <output data-testid="error">{String(nextArtwork.error() ?? '')}</output>
  }, 'Failure')
  const Picture = reatomComponent(
    () => (
      <>
        <Crumple value={picture.render()}>
          <span>Loading</span>
        </Crumple>
        <button
          onClick={wrap(() => {
            void nextArtwork('/second.webp').catch(rejection)
          })}
        >
          Next
        </button>
      </>
    ),
    'Picture',
  )
  const ui = (
    <reatomContext.Provider value={owner}>
      <Picture />
      <Result />
      <Failure />
    </reatomContext.Provider>
  )
  let mounted = await render(ui)
  try {
    await act(async () => {
      await bind(picture.ready, owner)()
      bind(notify, owner)()
    })
    const original = bind(picture.raw, owner)()
    const ref = picture.ref
    await act(async () => {
      mounted.container.querySelector('button')!.click()
    })
    await flush()
    expect(mounted.container.querySelector('[data-testid=result]')!.textContent).toBe(
      '/second.webp',
    )
    expect(bind(picture.raw, owner)()).toBe(original)
    expect(picture.ref).toBe(ref)
    const resultRenders = renders.data
    await act(async () => {
      picture.ref(null)
      await bind(nextArtwork, owner)('/failed.webp').catch(rejection)
      bind(notify, owner)()
    })
    expect(mounted.container.querySelector('[data-testid=error]')!.textContent).toContain(
      'ViewError',
    )
    expect(mounted.container.querySelector('[data-testid=result]')!.textContent).toBe(
      '/second.webp',
    )
    expect(renders.data).toBe(resultRenders)
    expect(rejection).toHaveBeenCalledTimes(1)
    expect(isAbort(rejection.mock.calls[0]![0])).toBe(false)
    await mounted.unmount()
    expect(bind(scene.raw, owner)()).toBe(stage)
    mounted = await render(ui)
    await act(async () => {
      await bind(picture.ready, owner)()
      bind(notify, owner)()
    })
    expect(bind(picture.raw, owner)()).not.toBe(original)
    expect(bind(picture.sprite, owner)()).not.toBeNull()
  } finally {
    await mounted.unmount()
    bind(scene.dispose, owner)()
    bind(context.reset, owner)()
  }
})
