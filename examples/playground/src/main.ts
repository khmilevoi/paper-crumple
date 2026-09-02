import * as pc from '@paper-crumple/core'
import { DEFAULT_SAMPLE_ID, SAMPLES } from './samples'
import { DEFAULT_CONFIG, buildStage } from './config'
import { mountHero } from './scene'

const line = document.getElementById('version-line')

async function boot(): Promise<void> {
  // A duplicate core is a startup failure, not a once-per-session console warning: two copies
  // give two `GlError` classes, and `instanceof` then narrows an Error as a success value.
  const dup = pc.assertSingleCore()
  if (dup instanceof Error) {
    if (line) line.textContent = `core duplicated: ${dup.message}`
    return
  }

  const sample = SAMPLES.find((s) => s.id === DEFAULT_SAMPLE_ID)
  if (sample === undefined) {
    if (line) line.textContent = `playground: unknown default sample "${DEFAULT_SAMPLE_ID}"`
    return
  }

  const controller = new AbortController()
  const onError = (e: pc.StageEvent<'error'>): void => {
    // Task 7 replaces this with the inspector panel; for now the error surface is the console.
    console.warn('playground: stage error', e)
  }

  const built = await buildStage(DEFAULT_CONFIG, onError, controller.signal)
  if (built === pc.ABORTED) {
    if (line) line.textContent = 'playground: stage build aborted'
    return
  }
  if (built instanceof Error) {
    if (line) line.textContent = `playground: stage build failed: ${built.message}`
    return
  }

  const mounted = await mountHero(built, sample, controller.signal)
  if (mounted === pc.ABORTED) {
    if (line) line.textContent = 'playground: hero mount aborted'
    return
  }
  if (mounted instanceof Error) {
    if (line) line.textContent = `playground: hero mount failed: ${mounted.message}`
    return
  }

  if (line)
    line.textContent =
      `core ${pc.VERSION} · ${SAMPLES.length} samples · ${pc.DWELL_MS.length} dwells · ` +
      `${built.stage.warnings.length} warnings · maxTextureSize ${built.stage.caps.maxTextureSize} · ` +
      `built in ${built.buildMs.toFixed(1)}ms`
}

void boot()
