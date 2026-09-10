import type { Crumple } from '../crumple.js'

export function detachedCrumple(over: Partial<Crumple> = {}): Crumple {
  return {
    state: 'detached',
    status: 'detached',
    parked: false,
    pose: 0,
    shown: null,
    sprite: null,
    requested: null,
    pending: null,
    error: null,
    frame: null,
    frameStyle: null,
    artworkStyle: null,
    view: null,
    ref: () => {},
    play: () => null,
    stop: () => {},
    refresh: () => {},
    draw: () => {},
    sync: () => {},
    retry: () => {},
    ...over,
  }
}
