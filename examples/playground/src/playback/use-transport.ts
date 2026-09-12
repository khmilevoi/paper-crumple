import * as pc from '@paper-crumple/core'
import type { PoseRef } from '@paper-crumple/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useScene } from '@paper-crumple/react'
import type { Crumple, CrumpleSettleEvent } from '@paper-crumple/react'

import type { AudioHandle, SequenceSpec } from '../sound/audio'
import { playSpec, swapSpec } from '../sound/audio'
import type { BuiltStage } from '../scene/config'
import { useHero } from '../scene/hero'
import type { Sample } from '../source/samples'

export type TransportDirection = 'folding' | 'unfolding' | null

export interface TransportOptions {
  readonly shown: Sample
  readonly audio: Pick<AudioHandle, 'beginSequence' | 'endSequence' | 'cancel'>
  readonly observed: (where: string, error: Error) => void
  readonly onSettle: (event: CrumpleSettleEvent, wasSwap: boolean) => void
}

export interface TransportHandle {
  readonly crumple: Crumple
  readonly dwells: readonly number[]
  readonly direction: TransportDirection
  readonly busy: boolean
  readonly lastStepMs: number | null
  readonly lastDrawMs: number | null
  readonly beginSwap: (key: string) => void
  readonly retrySwap: (key: string) => void
  readonly cancelSwap: (key: string) => void
  readonly draw: (pose: number) => void
  readonly runFold: (from: PoseRef, to: PoseRef) => Promise<void>
}

/** Silent or invalid audio keeps the exact authored duration of the swap armed for this run. */
export function swapDurationFor(fromAudio: number | null | undefined, authored: number): number {
  return typeof fromAudio === 'number' && Number.isFinite(fromAudio) && fromAudio > 0
    ? fromAudio
    : authored
}

type SwapOwner = { readonly kind: 'swap'; readonly key: string }
type TransportOwner = SwapOwner | { readonly kind: 'fold' }

interface PendingRetry {
  readonly owner: SwapOwner
  readonly stage: BuiltStage['stage'] | null
}

export function useTransport(o: TransportOptions): TransportHandle {
  const { audio, observed, onSettle, shown } = o
  const scene = useScene<BuiltStage>()
  const built = scene.status === 'ready' ? scene.meta : null
  const stage = scene.status === 'ready' ? scene.stage : null
  const dwells = built?.motion.poses?.dwells ?? pc.DWELL_MS

  const [direction, setDirection] = useState<TransportDirection>(null)
  const [swapDuration, setSwapDuration] = useState(() => swapSpec(0, dwells).authored)
  const [retryVersion, setRetryVersion] = useState(0)
  const [lastStepMs, setLastStepMs] = useState<number | null>(null)
  const [lastDrawMs, setLastDrawMs] = useState<number | null>(null)
  const stepAtRef = useRef<number | null>(null)
  const ownerRef = useRef<TransportOwner | null>(null)
  const pendingRetryRef = useRef<PendingRetry | null>(null)

  const beginTransport = useCallback(
    (
      owner: TransportOwner,
      nextDirection: Exclude<TransportDirection, null>,
      spec: SequenceSpec,
    ): number | undefined => {
      if (ownerRef.current !== null) audio.cancel()
      ownerRef.current = owner
      setDirection(nextDirection)
      return audio.beginSequence(spec)
    },
    [audio],
  )

  const closeTransport = useCallback(
    (owner: TransportOwner, settled: boolean): void => {
      if (ownerRef.current !== owner) return
      ownerRef.current = null
      if (settled) audio.endSequence()
      else audio.cancel()
      setDirection(null)
    },
    [audio],
  )

  const onHeroSettle = useCallback(
    (event: CrumpleSettleEvent): void => {
      const owner = ownerRef.current
      const wasSwap = owner?.kind === 'swap' && owner.key === event.key
      if (wasSwap) closeTransport(owner, true)
      onSettle(event, wasSwap)
    },
    [closeTransport, onSettle],
  )

  const crumple = useHero({
    shown,
    duration: swapDuration,
    onSettle: onHeroSettle,
    observed,
  })

  const view = crumple.view
  useEffect(() => {
    if (view === null) return
    stepAtRef.current = null
    const offStart = view.on('start', () => {
      stepAtRef.current = null
    })
    const offStep = view.on('step', (event) => {
      const previous = stepAtRef.current
      stepAtRef.current = event.ms
      if (previous !== null) setLastStepMs(event.ms - previous)
    })
    return () => {
      offStart()
      offStep()
    }
  }, [view])

  const drawPose = crumple.draw
  const draw = useCallback(
    (next: number): void => {
      const startedAt = performance.now()
      drawPose(next)
      setLastDrawMs(performance.now() - startedAt)
    },
    [drawPose],
  )

  const armSwap = useCallback(
    (key: string): SwapOwner => {
      const owner: SwapOwner = { kind: 'swap', key }
      const spec = swapSpec(crumple.pose, dwells)
      const duration = beginTransport(owner, 'folding', spec)
      setSwapDuration(swapDurationFor(duration, spec.authored))
      return owner
    },
    [beginTransport, crumple.pose, dwells],
  )

  const beginSwap = useCallback(
    (key: string): void => {
      armSwap(key)
    },
    [armSwap],
  )

  const retrySwap = useCallback(
    (key: string): void => {
      const owner = armSwap(key)
      pendingRetryRef.current = { owner, stage }
      setRetryVersion((current) => current + 1)
    },
    [armSwap, stage],
  )

  const retry = crumple.retry
  // `useCrumple` publishes its latest options in a layout effect. Crossing this passive-effect
  // boundary guarantees the duration above is committed before its synchronous retry reads it.
  useEffect(() => {
    const pendingRetry = pendingRetryRef.current
    if (pendingRetry === null) return
    pendingRetryRef.current = null
    if (ownerRef.current !== pendingRetry.owner) return
    if (
      stage !== pendingRetry.stage ||
      shown.id !== pendingRetry.owner.key ||
      crumple.requested !== pendingRetry.owner.key ||
      crumple.status !== 'rolled-back'
    ) {
      closeTransport(pendingRetry.owner, false)
      return
    }
    retry()
  }, [closeTransport, crumple.requested, crumple.status, retry, retryVersion, shown.id, stage])

  const cancelSwap = useCallback(
    (key: string): void => {
      const owner = ownerRef.current
      if (owner?.kind !== 'swap' || owner.key !== key) return
      closeTransport(owner, false)
    },
    [closeTransport],
  )

  const play = crumple.play
  const runFold = useCallback(
    async (from: PoseRef, to: PoseRef): Promise<void> => {
      const fromIdx = from === 'flat' ? 0 : from === 'ball' ? dwells.length - 1 : from
      const toIdx = to === 'flat' ? 0 : to === 'ball' ? dwells.length - 1 : to
      if (fromIdx === toIdx) return

      const owner: TransportOwner = { kind: 'fold' }
      const duration = beginTransport(
        owner,
        toIdx > fromIdx ? 'folding' : 'unfolding',
        playSpec(fromIdx, toIdx, '', dwells),
      )
      try {
        const run = play(from, to, { duration })
        if (run === null) return
        const result = await run
        if (result === pc.ABORTED) return
        if (result instanceof Error) {
          observed('crumple.play', result)
          return
        }
      } catch (reason: unknown) {
        observed('crumple.play', reason instanceof Error ? reason : new Error(String(reason)))
      } finally {
        closeTransport(owner, true)
      }
    },
    [beginTransport, closeTransport, dwells, observed, play],
  )

  const busy = crumple.pending !== null || crumple.state === 'playing'
  const pose = crumple.pose
  const lastPose = dwells.length - 1

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const tag = event.target instanceof HTMLElement ? event.target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return
      if (busy) return
      if (event.key === 'ArrowRight') {
        draw(Math.min(lastPose, pose + 1))
        event.preventDefault()
      } else if (event.key === 'ArrowLeft') {
        draw(Math.max(0, pose - 1))
        event.preventDefault()
      } else if (event.key === ' ') {
        void (pose >= lastPose ? runFold('ball', 'flat') : runFold('flat', 'ball'))
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [busy, draw, lastPose, pose, runFold])

  return {
    crumple,
    dwells,
    direction,
    busy,
    lastStepMs,
    lastDrawMs,
    beginSwap,
    retrySwap,
    cancelSwap,
    draw,
    runFold,
  }
}
