import { describe, expect, it } from 'vitest'
import { GlError } from './errors.js'
import { gradeAttributes } from './surface-grade.js'

/** What three.js grants by default (§4.0.2). */
const threeJs: WebGLContextAttributes = {
  alpha: false,
  antialias: true,
  depth: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  stencil: true,
  powerPreference: 'default',
}

describe('gradeAttributes', () => {
  it('refuses a context without depth, whatever the view targets', () => {
    for (const defaultFramebufferView of [true, false]) {
      const g = gradeAttributes({ ...threeJs, depth: false }, { defaultFramebufferView })
      expect(g.error).toBeInstanceOf(GlError)
      expect(g.error?.message).toContain('depth')
    }
  })

  it("accepts three.js's bag for a framebuffer view and warns rather than failing", () => {
    const g = gradeAttributes(threeJs, { defaultFramebufferView: false })
    expect(g.error).toBeUndefined()
    expect(g.warnings.join(' ')).toContain('alpha')
    expect(g.warnings.join(' ')).toContain('premultipliedAlpha')
    expect(g.warnings.join(' ')).toContain('preserveDrawingBuffer')
  })

  it("refuses three.js's bag once a view targets the default framebuffer", () => {
    const g = gradeAttributes(threeJs, { defaultFramebufferView: true })
    expect(g.error).toBeInstanceOf(GlError)
  })

  it('reports presentable from the three conditional attributes alone', () => {
    expect(gradeAttributes(threeJs, { defaultFramebufferView: false }).presentable).toBe(false)
    const ours: WebGLContextAttributes = {
      alpha: true,
      antialias: false,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: false,
      powerPreference: 'high-performance',
    }
    expect(gradeAttributes(ours, { defaultFramebufferView: true }).presentable).toBe(true)
    expect(gradeAttributes(ours, { defaultFramebufferView: true }).error).toBeUndefined()
  })

  it('never fails on an advisory attribute, and warns about each that differs', () => {
    const ours: WebGLContextAttributes = {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      stencil: true,
      powerPreference: 'low-power',
    }
    const g = gradeAttributes(ours, { defaultFramebufferView: true })
    expect(g.error).toBeUndefined()
    const text = g.warnings.join(' ')
    expect(text).toContain('antialias')
    expect(text).toContain('stencil')
    expect(text).toContain('powerPreference')
  })

  it('treats a null attribute bag as a lost context and refuses it', () => {
    const g = gradeAttributes(null, { defaultFramebufferView: false })
    expect(g.error).toBeInstanceOf(GlError)
    expect(g.presentable).toBe(false)
  })
})
