import { test } from 'vitest'
import { GlError } from './errors.js'
import { matchError } from './match.js'

test('else is mandatory, so tag dispatch survives §10.2 growth by construction', () => {
  matchError(new GlError('x'), {
    GlError: () => 1,
    else: () => 0,
  })

  // @ts-expect-error - amendment 4: `else` is required by the type
  matchError(new GlError('x'), { GlError: () => 1 })
})

test('a handler may be typed to the class it routes', () => {
  matchError(new GlError('x'), {
    GlError: (e: InstanceType<typeof GlError>) => e.message,
    else: (e: Error) => e.message,
  })
})
