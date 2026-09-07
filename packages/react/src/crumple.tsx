import type { CanvasHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from 'react'
import type { CrumpleMethods, CrumpleSnapshot } from './crumple-types.js'

/**
 * What `useCrumple` returns and what `<Crumple value>` takes.
 *
 * **Deliberately NOT identity-stable**: it carries the reactive snapshot, so it is a fresh object
 * per render by construction. Depend on `crumple.shown` or on `crumple.play`, never on `crumple`
 * (§2.1). The methods and `ref` on it are stable; the object around them is not.
 *
 * Declared here rather than beside the other types because the component below shares its name:
 * a value and a type of one name can only be exported together from a single module, where the
 * two declarations merge. Split across two modules it is `TS2300: Duplicate identifier`.
 */
export interface Crumple extends CrumpleSnapshot, CrumpleMethods {}

export interface CrumpleProps extends HTMLAttributes<HTMLDivElement> {
  value: Crumple
  /**
   * The escape hatch for the canvas itself. `ref` belongs to `value.ref`; `width` and `height`
   * belong to the stage — the binding is always `'managed'`, under which the core reads
   * `getBoundingClientRect()` and writes the backing store during the draw, and a React-set
   * attribute would fight it every blit. All three exclusions are compile errors rather than
   * silent losses (§6).
   */
  canvasProps?: Omit<CanvasHTMLAttributes<HTMLCanvasElement>, 'ref' | 'width' | 'height'>
}

/**
 * The canvas fills the wrapper, which is the element `frameStyle` sizes. An explicit CSS box is
 * not decoration: under `size: 'managed'` the core writes `canvas.width/height` from
 * `getBoundingClientRect()` on every draw, and a canvas with no CSS size takes its layout size
 * from those same attributes — the two then feed each other and the element grows by
 * `devicePixelRatio` per blit. `examples/playground/src/stage.ts` records the measurement.
 */
const CANVAS_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%' }

const OVERLAY_STYLE: CSSProperties = { position: 'absolute', inset: 0 }

/**
 * A positioned wrapper, a `<canvas ref={value.ref}>` inside it, and `children` layered over the
 * canvas while `value.shown === null` (§6). It holds no logic: anything it needs is a field on
 * the instance, because the instance is the only thing it is handed.
 *
 * The wrapper is a `<div>` and is not overridable in v1 — an `as` prop is a guess at a
 * requirement nobody has stated, and adding one later breaks nothing.
 */
export function Crumple({ value, canvasProps, children, style, ...rest }: CrumpleProps): ReactNode {
  const { ref, shown, frameStyle } = value
  const { style: canvasStyle, ...canvasRest } = canvasProps ?? {}
  return (
    <div {...rest} style={{ position: 'relative', ...style, ...(frameStyle ?? {}) }}>
      <canvas {...canvasRest} ref={ref} style={{ ...CANVAS_STYLE, ...canvasStyle }} />
      {shown === null && children !== undefined && children !== null ? (
        <div style={OVERLAY_STYLE}>{children}</div>
      ) : null}
    </div>
  )
}
