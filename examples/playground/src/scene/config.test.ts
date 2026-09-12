import { expect, it } from 'vitest'
import { configForInitialKnobs, DEFAULT_CONFIG, knobsForConfig } from './config'

it.each(['px', 'percent'] as const)(
  'none needs no edge reserve negotiation under %s',
  (edgeWidthUnit) => {
    const config = { ...DEFAULT_CONFIG, edgeShape: 'none' as const, edgeWidthUnit }
    expect(configForInitialKnobs(config, { 'sheet.edgeWidth': 140 })).toBe(config)
  },
)

it('filters inactive edge knobs without losing the values needed when switching back', () => {
  const stored = { 'sheet.edgeWidth': 0, 'sheet.deckleWidth': 12, 'sheet.sheetCrumple': 0.5 }
  const none = { ...DEFAULT_CONFIG, edgeShape: 'none' as const }
  expect(knobsForConfig(none, stored)).toEqual({ 'sheet.sheetCrumple': 0.5 })
  expect(knobsForConfig({ ...none, edgeShape: 'torn', edgeFinish: 'paper' }, stored)).toEqual(
    stored,
  )
})
