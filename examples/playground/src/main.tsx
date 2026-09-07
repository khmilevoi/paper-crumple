import { createRoot } from 'react-dom/client'
import * as pc from '@paper-crumple/core'
import { App } from './ui/App'

/**
 * No `<StrictMode>`, deliberately: its development double-invoke would build, mount and dispose a
 * second WebGL2 stage on every render pass of `usePaperScene`'s effect (`scene.ts`'s
 * `useDemoScene`), which costs a full front bake each time and makes the diagnostics timings
 * describe a stage nobody is looking at.
 */
const root = document.getElementById('root')
if (root === null) {
  document.body.textContent = 'playground: #root is missing from index.html'
} else {
  // A duplicate core is a startup failure, not a once-per-session console warning: two copies give
  // two `GlError` classes, and `instanceof` then narrows an Error as a success value.
  const duplicated = pc.assertSingleCore()
  if (duplicated instanceof Error) {
    root.textContent = `core duplicated: ${duplicated.message}`
  } else {
    createRoot(root).render(<App />)
  }
}
