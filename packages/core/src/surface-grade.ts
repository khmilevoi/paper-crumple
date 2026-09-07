import { GlError } from './errors.js'
import { GL_ATTRIBUTES } from './gl-context.js'

/**
 * §4.0.2 — injected attributes are **graded, not matched**.
 *
 * `getContext('webgl2')` on a canvas that already has a context returns the first call's context
 * and silently discards the attribute bag it was handed, with no way to learn that it did
 * (§4.0). `getContextAttributes()` — the **granted** attributes — is the only way to find out
 * what was actually given, and this function is what reads it.
 */
export interface AttributeGrade {
  /** Set when a **hard** attribute was not granted. The stage refuses to mount on it. */
  readonly error: InstanceType<typeof GlError> | undefined
  /** One sentence per advisory or conditionally-hard attribute that differs. */
  readonly warnings: readonly string[]
  /** Whether the granted attributes permit a view to target the default framebuffer. */
  readonly presentable: boolean
}

/** Hard only when a view targets the default framebuffer; a `stage.warnings` entry otherwise. */
const CONDITIONAL = ['alpha', 'premultipliedAlpha', 'preserveDrawingBuffer'] as const

/** Advisory always. A stage never refuses to mount over one of these. */
const ADVISORY = ['antialias', 'stencil', 'powerPreference'] as const

type Conditional = (typeof CONDITIONAL)[number]
type Advisory = (typeof ADVISORY)[number]

function differs(granted: WebGLContextAttributes, key: Conditional | Advisory): boolean {
  return granted[key] !== GL_ATTRIBUTES[key]
}

function sentence(key: string, want: unknown, got: unknown): string {
  return `the injected context was granted ${key}: ${String(got)} where paper-crumple asks for ${String(want)}`
}

export function gradeAttributes(
  granted: WebGLContextAttributes | null,
  o: { readonly defaultFramebufferView: boolean },
): AttributeGrade {
  // `getContextAttributes()` answers `null` for a context that is already lost. There is nothing
  // to grade and nothing that will work, so it is the same refusal as a missing depth buffer.
  if (granted === null) {
    return {
      error: new GlError(
        'the injected WebGL2 context reports no attributes, which means it is already lost',
      ),
      warnings: [],
      presentable: false,
    }
  }

  const warnings: string[] = []
  const brokenConditionals = CONDITIONAL.filter((k) => differs(granted, k))
  const presentable = brokenConditionals.length === 0

  // Hard, always. Without depth the ball self-occludes wrongly, which reads as corruption rather
  // than as an error — so it is refused rather than warned about.
  if (granted.depth !== true) {
    return {
      error: new GlError(
        'the injected WebGL2 context was granted depth: false; paper-crumple needs a depth buffer, ' +
          'or the crumpled ball self-occludes and renders as corruption rather than as an error',
      ),
      warnings,
      presentable: false,
    }
  }

  for (const key of brokenConditionals) {
    warnings.push(sentence(key, GL_ATTRIBUTES[key], granted[key]))
  }
  for (const key of ADVISORY) {
    if (differs(granted, key)) warnings.push(sentence(key, GL_ATTRIBUTES[key], granted[key]))
  }

  if (o.defaultFramebufferView && !presentable) {
    return {
      error: new GlError(
        `a view targeting the default framebuffer needs ${brokenConditionals.join(', ')} as ` +
          'paper-crumple asks for them; this context was granted otherwise, so only a ' +
          '{ framebuffer } view is available on it',
      ),
      warnings,
      presentable,
    }
  }

  return { error: undefined, warnings, presentable }
}
