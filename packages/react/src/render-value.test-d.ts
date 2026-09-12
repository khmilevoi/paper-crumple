import { expectTypeOf } from 'vitest'
import type { Crumple, CrumpleProps } from './crumple.js'
import type { RenderValue } from '@paper-crumple/core/bindings'

const value: RenderValue = { ref: () => {}, shown: null, frameStyle: null }
expectTypeOf(value).toExtend<CrumpleProps['value']>()
expectTypeOf<Crumple>().toExtend<RenderValue>()
