---
'@paper-crumple/core': minor
---

**Nested `scope()` restores nothing, and `createGlContext` can be told it owns the context** (the
`/unstable` GL seam, spec §5.1, §7.3, §7.4.1).

`scope()` no longer saves and restores per level. The outermost scope on a context restores §5.1's
enumerated set at its exit; a scope entered while another is already live restores **nothing** at
its own — the way §7.3's nested `batch` is a no-op rather than a double save. Two nested slots
therefore pay one save and one restore between them instead of two of each, and the guarantee a
slot may rely on is unchanged in the only place it is observable from outside: state a slot leaves
behind cannot survive the outermost scope. What a slot may **not** do is lean on a sibling's scope
exit having put something back mid-flight; it sets every piece of state it relies on inside its own
body, which is what §5.1 already required.

`createGlContext(gl, o)` takes a new second argument, `GlContextOptions` (exported from
`@paper-crumple/core/unstable`). Its one field, `owned`, says the stage created this context on a
canvas of its own and nothing but the library ever writes to it — true for both owned presentation
modes, `present: 'direct'` included, where the consumer holds the canvas element but must never
call `getContext` on it. With `owned: true` the pinned ambient state (§7.4.1) is captured once at
creation and every outermost scope restores to that one constant, so the hot path performs no
`getParameter` and no `isEnabled` at all. It defaults to `false`, which is the behaviour that
shipped: an injected context (§7.3) may carry any state between two library calls, so every
outermost scope still captures for real. Existing one-argument calls are unaffected.
