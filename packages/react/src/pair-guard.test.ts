import type { SpriteSource } from '@paper-crumple/core'
import { expect, test } from 'vitest'
import { rememberPair } from './pair-guard.js'

test('a first sighting of a key is remembered and allowed', () => {
  const pairs = new Map<string, SpriteSource>()
  expect(rememberPair(pairs, 'a', 'url1')).toBeUndefined()
  expect(pairs.get('a')).toBe('url1')
})

test('the same pair again is allowed and changes nothing', () => {
  const pairs = new Map<string, SpriteSource>([['a', 'url1']])
  expect(rememberPair(pairs, 'a', 'url1')).toBeUndefined()
})

test('a changed src under an unchanged key is refused, and names the reason (§5.3)', () => {
  const pairs = new Map<string, SpriteSource>([['a', 'url1']])
  const refused = rememberPair(pairs, 'a', 'url2')
  expect(refused).toBeInstanceOf(Error)
  expect(refused?.message).toContain("'a'")
  expect(refused?.message).toContain('hull cache')
  expect(refused?.message).toContain('replace')
  // The remembered pair is NOT overwritten: the next render must be refused too.
  expect(pairs.get('a')).toBe('url1')
})

test('a MAP and not the last pair — (a,url1), (b,urlB), (a,url2) is still caught', () => {
  const pairs = new Map<string, SpriteSource>()
  expect(rememberPair(pairs, 'a', 'url1')).toBeUndefined()
  expect(rememberPair(pairs, 'b', 'urlB')).toBeUndefined()
  // A last-pair check passes this, and the §5.3 cache hit then shows url1 while the prop says
  // url2 — a silent wrong picture.
  expect(rememberPair(pairs, 'a', 'url2')).toBeInstanceOf(Error)
})

test('identity, not structure: two equal URL objects are two different sources', () => {
  const pairs = new Map<string, SpriteSource>()
  expect(rememberPair(pairs, 'a', new URL('https://example.test/a.png'))).toBeUndefined()
  expect(rememberPair(pairs, 'a', new URL('https://example.test/a.png'))).toBeInstanceOf(Error)
})
