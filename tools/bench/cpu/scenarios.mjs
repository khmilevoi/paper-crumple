/**
 * The CPU scenarios. Names are the contract the optimisation tasks refer to — keep them.
 *
 * Every scenario runs the real functions from `packages/*\/src` through the loader in
 * `loader.mjs`; the only stand-ins are the GL calls (`sheet.ts`'s resample, `buildField`,
 * `blurField`, `readPixels`) and, for the stage scenarios, the two slot fakes core's own tests
 * drive the stage with (`packages/core/src/testing/fake-slots.ts`), given the real paper and
 * motion knob descriptors so the registry is the size a real mount produces.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  alphaBbox,
  buildHull,
  cpuSdfFromAlpha,
  defaultsFor,
  descriptorsFor,
  DISTANCE_WAVELENGTH_PX,
  edgeParamsFrom,
  extractContours,
  fillHullMask,
  freezeOverscan,
  growBox,
  handleBytesFor,
  hullCache,
  hullComponentCount,
  resolveSdfRes,
  scaleBox,
  sheetRect,
  sheetRectFromExtent,
  signedFieldExtent,
  toleranceFor,
  checkReserve,
} from '@paper-crumple/paper'
import { dimsForLongSide, frontForArtwork } from '../../../packages/paper/src/handle.ts'
import { boundsExtent, hullBounds } from '../../../packages/paper/src/hull-shape.ts'
import {
  checkGuardBand,
  hullCacheKey,
  overscanRadius,
  KNOB_REFERENCE_PX,
  resampleAreaExact,
} from '@paper-crumple/core/unstable'
import { DWELL_MS } from '@paper-crumple/core'
import { decodeFrame, fitSheet, MOTION_KNOBS, parsePack } from '@paper-crumple/motion'
import pack1x1 from '../../../packages/motion/src/packs/1x1.ts'
import { createStage } from '../../../packages/core/src/stage.ts'
import { fakeMotion, fakeSheet, stageEnv } from '../../../packages/core/src/testing/fake-slots.ts'
import { logoArtwork, photoArtwork } from './artworks.mjs'
import { createBenchTimers } from './timers.mjs'

/** `sheet.ts`'s own `HULL_SAMPLE_PX` — module-private there, restated here. */
const HULL_SAMPLE_PX = 4
const EDGE_MODE = 'hull'

// ---------------------------------------------------------------------------------------------
// Shared inputs, built once and memoised across scenarios.
// ---------------------------------------------------------------------------------------------

const memo = new Map()
function once(key, make) {
  let v = memo.get(key)
  if (v === undefined) {
    v = make()
    memo.set(key, v)
  }
  return v
}

const logo = (size) => once(`logo:${size}`, () => logoArtwork(size, { seed: 7, inset: 0.12 }))
const photo = (size) => once(`photo:${size}`, () => photoArtwork(size, 11))
/** The CPU signed field of the logo at its own resolution (texel == pixel). */
const logoField = (size) =>
  once(`field:${size}`, () => {
    const a = logo(size)
    return cpuSdfFromAlpha(a.alpha01, a.width, a.height)
  })

/** The hull parameters `sheet.ts` derives for a front of `size` texels at texel scale 1. */
function hullParams(front, texel) {
  const values = defaultsFor(EDGE_MODE)
  const pxScale = front / KNOB_REFERENCE_PX
  const k = pxScale / texel
  const angularity = values.angularity
  return {
    minDist: values.minDist * k,
    maxDist: values.maxDist * k,
    angularity,
    seed: values.seed,
    tolerance: toleranceFor(angularity) * k,
    wavelength: DISTANCE_WAVELENGTH_PX * k,
    sampleStep: HULL_SAMPLE_PX / texel,
    k,
  }
}

// ---------------------------------------------------------------------------------------------
// Per-add helpers, one at a time.
// ---------------------------------------------------------------------------------------------

function sdfScenario(size) {
  return {
    name: `cpu.sdf.${size}`,
    note: `cpuSdfFromAlpha on a ${size}x${size} logo alpha (two exact EDTs + refinement)`,
    setup: () => logo(size),
    op: (a) => cpuSdfFromAlpha(a.alpha01, a.width, a.height),
  }
}

function contoursScenario(size) {
  return {
    name: `cpu.contours.${size}`,
    note: `extractContours on the ${size}x${size} signed field at the hull band's iso`,
    setup: () => {
      const p = hullParams(size, 1)
      return { field: logoField(size), size, iso: -(p.minDist + p.maxDist) * 0.5 }
    },
    op: (c) => extractContours(c.field, c.size, c.size, c.iso),
  }
}

function hullScenario(size) {
  return {
    name: `cpu.hull.${size}`,
    note: `buildHull (contours + simplify + slide + repair + pack) on the ${size}x${size} field`,
    setup: () => ({ field: logoField(size), size, p: hullParams(size, 1) }),
    op: (c) =>
      buildHull({
        field: c.field,
        width: c.size,
        height: c.size,
        minDist: c.p.minDist,
        maxDist: c.p.maxDist,
        angularity: c.p.angularity,
        seed: c.p.seed,
        tolerance: c.p.tolerance,
        wavelength: c.p.wavelength,
        sampleStep: c.p.sampleStep,
      }),
  }
}

const maskScenario = {
  name: 'cpu.mask',
  note: 'alphaBbox + sheetRect over 1024x1024 RGBA',
  setup: () => logo(1024),
  op: (a) => {
    const box = alphaBbox(a.rgba, a.width, a.height)
    return box === undefined ? undefined : sheetRect(box, a.width, a.height)
  },
}

const extentScenario = {
  name: 'cpu.extent',
  note: 'signedFieldExtent + growBox + scaleBox + sheetRectFromExtent over the 1024x1024 field',
  setup: () => ({ field: logoField(1024), size: 1024, p: hullParams(1024, 1) }),
  op: (c) => {
    const raw = signedFieldExtent(c.field, c.size, c.size)
    if (raw === undefined) return undefined
    const box = growBox(raw, c.p.maxDist, c.size, c.size)
    return sheetRectFromExtent(scaleBox(box, 1), c.size, c.size)
  },
}

function resampleScenario(name, art, note) {
  return {
    name,
    note,
    setup: () => {
      const a = art()
      const reserve = freezeOverscan(edgeParamsFrom(EDGE_MODE, defaultsFor(EDGE_MODE)), 0)
      const framing = frontForArtwork({
        overscan: reserve.overscan,
        srcW: a.width,
        srcH: a.height,
        maxSize: 384,
        exact: false,
      })
      return {
        source: { data: a.rgba, width: a.width, height: a.height },
        rect: { x: 0, y: 0, w: a.width, h: a.height },
        dst: framing.artwork,
      }
    },
    op: (c) => resampleAreaExact(c.source, c.rect, c.dst.w, c.dst.h),
  }
}

// ---------------------------------------------------------------------------------------------
// The per-add chain, sequenced as `sheet.ts` sequences it.
// ---------------------------------------------------------------------------------------------

/**
 * `readBackField`'s CPU half (`sheet.ts`): the decode loop over the field-sized `readPixels`
 * buffer, RED/FLOAT flavour. The GL read itself is the stand-in: `buf` is prepared in setup.
 */
function readbackDecode(buf, w, h, decode, texelPx) {
  const out = new Float32Array(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 1) {
    out[i] = (buf[p] * decode[0] + decode[1]) / texelPx
  }
  return out
}

/** `sheet.ts`'s `artworkPlacement`, `reachRect` and `frontRectToSourceRect` — module-private. */
function artworkPlacement(front, artwork) {
  return {
    x: Math.round((front.w - artwork.w) / 2),
    y: Math.round((front.h - artwork.h) / 2),
    w: artwork.w,
    h: artwork.h,
  }
}
function reachRect(centres, radius, field, front) {
  const sx = front.w / field.w
  const sy = front.h / field.h
  const x0 = (centres.minX + 0.5 - radius) * sx
  const y0 = (centres.minY + 0.5 - radius) * sy
  const x1 = (centres.maxX + 0.5 + radius) * sx
  const y1 = (centres.maxY + 0.5 + radius) * sy
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
function frontRectToSourceRect(frontRect, placement, src) {
  const sx = src.w / placement.w
  const sy = src.h / placement.h
  const x0 = (frontRect.x - placement.x) * sx
  const y0 = (frontRect.y - placement.y) * sy
  const x1 = (frontRect.x + frontRect.w - placement.x) * sx
  const y1 = (frontRect.y + frontRect.h - placement.y) * sy
  return {
    x: Math.round(x0),
    y: Math.round(y0),
    w: Math.max(1, Math.round(x1 - x0)),
    h: Math.max(1, Math.round(y1 - y0)),
  }
}

function ingestSetup(srcSize, maxSize) {
  const knobDescriptors = descriptorsFor(EDGE_MODE)
  const values = defaultsFor(EDGE_MODE)
  const reserve = freezeOverscan(edgeParamsFrom(EDGE_MODE, values), 0)
  const framing = frontForArtwork({
    overscan: reserve.overscan,
    srcW: srcSize,
    srcH: srcSize,
    maxSize,
    exact: false,
  })
  const { artwork, front } = framing
  const frontLongSide = Math.max(front.w, front.h)
  const sdfRes = resolveSdfRes(values.sdfRes ?? 0, frontLongSide)
  const field = dimsForLongSide(sdfRes, front.w, front.h, 2)
  const placement = artworkPlacement(front, artwork)
  const texel = front.w / field.w
  // The GL passes' product, stood in for: the artwork placed in the front at the field's
  // resolution (`artworkUvFor`), as a signed field in texels — computed once here by the CPU
  // transform on a box-filtered alpha at exactly the placement `buildField`'s seed pass frames.
  const art = logoArtwork(field.w, { seed: 7, inset: placement.x / front.w })
  const fieldValues = cpuSdfFromAlpha(art.alpha01, field.w, field.h)
  // What `readPixels` would hand back: pass A's texels, encoded through `field.decode`. The
  // identity decode keeps the stand-in exact.
  const readback = new Float32Array(fieldValues.length)
  for (let i = 0; i < readback.length; i++) readback[i] = fieldValues[i] * texel
  // The fallback branch's input: the alpha `cpuFieldFallback` draws at the field's size.
  const fallbackAlpha = art.alpha01
  return {
    srcSize,
    maxSize,
    knobDescriptors,
    values,
    reserve,
    artwork,
    front,
    sdfRes,
    field,
    placement,
    texel,
    readback,
    decode: [1, 0],
    fallbackAlpha,
    cache: hullCache(),
    counter: 0,
  }
}

/**
 * `source()` steps 1-9 with the GL calls removed, then the CPU half of `build()` (the reserve
 * check, the hull-tier compare, the hull mask), then the stage's own per-add `motion.fit`.
 * `cpuBranch` selects how the CPU field is obtained: `'readback'` (the specified path: decode
 * the `readPixels` buffer) or `'fallback'` (`cpuFieldFallback`'s `cpuSdfFromAlpha`, the degraded
 * branch of spec 8.2.1).
 */
function ingestOp(c, cpuBranch) {
  const { values, knobDescriptors, front, artwork, field, placement, texel } = c
  const edgeParams = edgeParamsFrom(EDGE_MODE, values)
  const spriteKey = `paper:${c.counter++}`
  const srcW = c.srcSize
  const srcH = c.srcSize
  const frontLongSide = Math.max(front.w, front.h)
  // Step 4 again, as source() does it (cheap, kept for fidelity).
  const sdfRes = resolveSdfRes(values.sdfRes ?? 0, frontLongSide)
  // Steps 5-8 are GL (pools, resample, buildField, blurField): stood in for.
  // Step 9: the CPU field, the hull, the rect, the guard band.
  const pxScale = front.h / KNOB_REFERENCE_PX
  const k = pxScale / texel
  const knobKey = hullCacheKey(knobDescriptors, values)
  const cacheKey = { spriteKey, sdfRes, knobKey }
  let hull = c.cache.get(cacheKey)
  if (hull === undefined) {
    const cpu =
      cpuBranch === 'readback'
        ? readbackDecode(c.readback, field.w, field.h, c.decode, texel)
        : cpuSdfFromAlpha(c.fallbackAlpha, field.w, field.h)
    const built = buildHull({
      field: cpu,
      width: field.w,
      height: field.h,
      minDist: values.minDist * k,
      maxDist: values.maxDist * k,
      angularity: values.angularity,
      seed: values.seed,
      tolerance: toleranceFor(values.angularity) * k,
      wavelength: DISTANCE_WAVELENGTH_PX * k,
      sampleStep: HULL_SAMPLE_PX / texel,
    })
    hull = built.hull
    c.cache.set(cacheKey, hull)
  }
  const bounds = hullBounds(hull)
  let box = boundsExtent(bounds, field.w, field.h)
  const beyond = (overscanRadius(edgeParams) - edgeParams.maxDist) * k
  const reach = reachRect(bounds, beyond, field, front)
  const frontBox = scaleBox(box, texel)
  const frontRect = sheetRectFromExtent(frontBox, front.w, front.h)
  const guardBand = checkGuardBand({ frontSize: front, hullExtent: reach })
  if (guardBand !== undefined) return guardBand
  const rect = frontRectToSourceRect(frontRect, placement, { w: srcW, h: srcH })
  const hullKnobs = {}
  for (const d of knobDescriptors) {
    if (d.invalidates === 'hull' && values[d.key] !== undefined) hullKnobs[d.key] = values[d.key]
  }
  const handle = {
    spriteKey,
    rect,
    frontRect,
    front,
    artwork,
    overscan: c.reserve.overscan,
    sdfRes,
    srcW,
    srcH,
    aspect: srcW / srcH,
    exact: false,
    edgeMode: EDGE_MODE,
    hull,
    hullKnobs,
    alive: true,
    bytes: 0,
  }
  handle.bytes = handleBytesFor(handle)

  // The stage's per-add fit (`bakedMotion.fit` -> `fitSheet`), on the handle's front rect.
  const fit = fitSheet(handle.frontRect.w, handle.frontRect.h, null)
  const size = { w: Math.ceil(fit.sheetW), h: Math.ceil(fit.sheetH) }

  // build(), CPU half: steps 4-6b.
  const reserveCheck = checkReserve(c.reserve, edgeParamsFrom(EDGE_MODE, values))
  if (reserveCheck !== undefined) return reserveCheck
  const buildField = dimsForLongSide(handle.sdfRes, size.w, size.h, 2)
  const buildPlacement = artworkPlacement(size, handle.artwork)
  const hullTierKeys = knobDescriptors.filter((d) => d.invalidates === 'hull')
  const hullChanged = hullTierKeys.some((d) => values[d.key] !== handle.hullKnobs[d.key])
  if (hullChanged) return new Error('unreachable: same values')
  const srcField = dimsForLongSide(handle.sdfRes, handle.front.w, handle.front.h, 2)
  const tracePlacement = artworkPlacement(handle.front, handle.artwork)
  const hullSx = (handle.front.w / srcField.w) * (buildField.w / size.w)
  const hullSy = (handle.front.h / srcField.h) * (buildField.h / size.h)
  const hullTx = ((buildPlacement.x - tracePlacement.x) * buildField.w) / size.w
  const hullTy = ((buildPlacement.y - tracePlacement.y) * buildField.h) / size.h
  let mask
  if (hull.kind === 'polygons' && hullComponentCount(hull) > 0) {
    mask = fillHullMask(hull, buildField.w, buildField.h, hullSx, hullSy, hullTx, hullTy)
  }
  return { handle, fit, mask }
}

function ingestScenario(name, cpuBranch, note) {
  return {
    name,
    note,
    setup: () => ingestSetup(1024, 1024),
    prepare: (c) => c.cache.clear(),
    op: (c) => ingestOp(c, cpuBranch),
  }
}

const readbackDecodeScenario = {
  name: 'cpu.readback.decode.512',
  note: "readBackField's decode loop over a 512x512 RED/FLOAT readPixels buffer",
  setup: () => ingestSetup(1024, 1024),
  op: (c) => readbackDecode(c.readback, c.field.w, c.field.h, c.decode, c.texel),
}

const hullMaskScenario = {
  name: 'cpu.hullmask.512',
  note: 'fillHullMask (build() step 6b) of the traced hull into a 512x512 RGBA mask',
  setup: () => {
    const c = ingestSetup(1024, 1024)
    const out = ingestOp(c, 'readback')
    return { hull: out.handle.hull, field: c.field }
  },
  op: (c) => fillHullMask(c.hull, c.field.w, c.field.h, 1, 1, 0, 0),
}

// ---------------------------------------------------------------------------------------------
// Motion packs.
// ---------------------------------------------------------------------------------------------

const packScenario = {
  name: 'cpu.pack.parse',
  note: 'parsePack over the shipped 1x1 pack (539 KB .bin + manifest), as loadPack calls it',
  setup: () => {
    const bytes = readFileSync(fileURLToPath(pack1x1.binUrl))
    // `loadPack` hands `parsePack` the `ArrayBuffer` from `response.arrayBuffer()`; the copy a
    // view would trigger (`ownBuffer`) is not on that path, so the buffer is passed as-is.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    return { buffer, manifest: pack1x1.manifest }
  },
  op: (c) => parsePack(c.buffer, c.manifest),
}

const packDecodeScenario = {
  name: 'cpu.pack.decode',
  note: 'decodeFrame for the six key frames (not on the draw path: mesh.ts uploads frameBytes)',
  setup: () => {
    const bytes = readFileSync(fileURLToPath(pack1x1.binUrl))
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const pack = parsePack(buffer, pack1x1.manifest)
    if (pack instanceof Error) return Promise.reject(pack)
    return pack
  },
  op: (pack) => {
    for (const frame of pack.keyFrames) decodeFrame(pack, frame)
  },
}

// ---------------------------------------------------------------------------------------------
// The stage: scheduler steps and knob patches over a 64-tile grid with fake slots.
// ---------------------------------------------------------------------------------------------

const ctx2d = { clearRect() {}, drawImage() {} }
function benchCanvas() {
  return {
    width: 64,
    height: 64,
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ width: 32, height: 32 }),
  }
}

function benchBitmap(width, height) {
  return { width, height, close() {} }
}

/** Three aspects in rotation, so the fake's sortKey batches and the LRU see a mixed grid. */
function bitmapFor(i) {
  const shape = i % 3
  return shape === 0
    ? benchBitmap(640, 640)
    : shape === 1
      ? benchBitmap(480, 720)
      : benchBitmap(720, 480)
}

/**
 * The URL arm, as a grid page uses it: `source.ts` fetches (stubbed to a 200 with an empty
 * blob) and decodes (stubbed to a sized bitmap-like), which is what makes the sprite evictable
 * and lets the bench go through the real source normalisation rather than `pin: true`.
 */
function benchSourceEnv() {
  let decoded = 0
  return {
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      blob: async () => new Blob(['png'], { type: 'image/png' }),
    }),
    createImageBitmap: async () => bitmapFor(decoded++),
  }
}

async function gridStage(n) {
  const timers = createBenchTimers()
  const sheet = fakeSheet({ knobs: descriptorsFor(EDGE_MODE) })
  const motion = fakeMotion({ knobs: MOTION_KNOBS, poseCount: DWELL_MS.length })
  const stage = await createStage(
    { sheet, motion, maxSize: 384, present: 'blit' },
    stageEnv({ timers, sourceEnv: benchSourceEnv() }),
  )
  if (stage instanceof Error || typeof stage === 'symbol') return Promise.reject(stage)
  const views = []
  const sprites = []
  for (let i = 0; i < n; i += 1) {
    const sprite = await stage.add(`/tiles/${i}.png`, { key: `tile-${i}` })
    if (sprite instanceof Error || typeof sprite === 'symbol') return Promise.reject(sprite)
    const view = stage.view({ canvas: benchCanvas(), tag: `tile-${i}` })
    if (view instanceof Error) return Promise.reject(view)
    view.show(sprite)
    views.push(view)
    sprites.push(sprite)
  }
  // One consumer-side listener per event, as a grid page would have (a step counter, say).
  let steps = 0
  stage.on('step', () => {
    steps += 1
  })
  return { stage, timers, views, sprites, steps: () => steps }
}

const stepScenario = {
  name: 'cpu.step.grid64',
  note: 'one dwell tick of a stage.play over 64 views: 64 x (render -> draw -> blit -> step emit)',
  setup: async () => {
    const g = await gridStage(64)
    return { ...g, tick: DWELL_MS.length, run: null }
  },
  prepare: (c) => {
    // A run lasts DWELL_MS.length ticks; tick 0 fires synchronously inside stage.play (untimed
    // here), ticks 1..5 are what `advance` fires. Restart when the run in flight has ended.
    if (c.tick >= DWELL_MS.length - 1) {
      c.run = c.stage.play('flat', 'ball')
      c.tick = 0
    }
  },
  op: (c) => {
    c.timers.advance(DWELL_MS[c.tick])
    c.tick += 1
  },
  teardown: (c) => c.stage.dispose(),
}

const knobPatchScenario = {
  name: 'cpu.knobs.patch',
  note: 'sprite.set of a front-class knob: registry.normalise + validate + delta + rebuild + redraw (1 view)',
  setup: async () => ({ ...(await gridStage(64)), flip: 0 }),
  op: (c) => {
    c.flip ^= 1
    return c.sprites[0].set({ 'sheet.shadow': c.flip === 0 ? 0.5 : 0.55 })
  },
  teardown: (c) => c.stage.dispose(),
}

const knobPatchDrawScenario = {
  name: 'cpu.knobs.patch.draw',
  note: 'view.set of a draw-class knob: normalise + validate + one redraw',
  setup: async () => ({ ...(await gridStage(64)), flip: 0 }),
  op: (c) => {
    c.flip ^= 1
    return c.views[0].set({ 'motion.ambient': c.flip === 0 ? 0.2 : 0.25 })
  },
  teardown: (c) => c.stage.dispose(),
}

const knobPatchStageScenario = {
  name: 'cpu.knobs.patch.stage64',
  note: 'stage.set of a draw-class knob: normalise + delta + invalidate 64 sprites -> 64 redraws',
  setup: async () => ({ ...(await gridStage(64)), flip: 0 }),
  op: (c) => {
    c.flip ^= 1
    return c.stage.set({ 'motion.ambient': c.flip === 0 ? 0.2 : 0.25 })
  },
  teardown: (c) => c.stage.dispose(),
}

const addScenario = {
  name: 'cpu.stage.add',
  note: 'stage.add (URL arm, stubbed fetch/decode) + view + show with fake slots: per-add orchestration',
  setup: async () => {
    const g = await gridStage(1)
    return { ...g, i: 1, pending: null }
  },
  prepare: (c) => {
    // Keep the sprite count flat: the previous call's sprite and view go before the next add.
    if (c.pending !== null) {
      c.pending.view.dispose()
      c.stage.remove(c.pending.key)
      c.pending = null
    }
  },
  // Async on purpose: `add` awaits the slots, which with fakes settle on the microtask queue,
  // and the harness times the whole chain until the promise settles.
  op: async (c) => {
    const i = c.i++
    const key = `x-${i}`
    const sprite = await c.stage.add(`/tiles/${key}.png`, { key })
    if (sprite instanceof Error || typeof sprite === 'symbol') return sprite
    const view = c.stage.view({ canvas: benchCanvas(), tag: key })
    if (view instanceof Error) return view
    view.show(sprite)
    c.pending = { view, key }
    return undefined
  },
  teardown: (c) => c.stage.dispose(),
}

// ---------------------------------------------------------------------------------------------

export const scenarios = [
  sdfScenario(512),
  sdfScenario(1024),
  {
    name: 'cpu.sdf.1024.photo',
    note: 'cpuSdfFromAlpha on a fully opaque 1024x1024 alpha (no outside seeds)',
    setup: () => photo(1024),
    op: (a) => cpuSdfFromAlpha(a.alpha01, a.width, a.height),
  },
  contoursScenario(512),
  contoursScenario(1024),
  hullScenario(512),
  hullScenario(1024),
  maskScenario,
  extentScenario,
  resampleScenario(
    'cpu.resample',
    () => logo(1024),
    'resampleAreaExact 1024x1024 logo -> maxSize 384 artwork',
  ),
  resampleScenario(
    'cpu.resample.photo',
    () => photo(1024),
    'resampleAreaExact 1024x1024 opaque photo -> maxSize 384 artwork',
  ),
  readbackDecodeScenario,
  hullMaskScenario,
  ingestScenario(
    'cpu.ingest.1024',
    'readback',
    'source()+build() CPU chain for a 1024 source at maxSize 1024 (field 512), readback branch',
  ),
  ingestScenario(
    'cpu.ingest.1024.fallback',
    'fallback',
    'same chain with cpuFieldFallback (cpuSdfFromAlpha at 512x512) instead of the readback',
  ),
  packScenario,
  packDecodeScenario,
  stepScenario,
  knobPatchScenario,
  knobPatchDrawScenario,
  knobPatchStageScenario,
  addScenario,
]
