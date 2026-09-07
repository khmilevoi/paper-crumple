---
'@paper-crumple/core': minor
---

Add the knob registry (§6): the `KnobDescriptor` union with `min` and `max` required on the
numeric kinds, `knobs()` and `enumKnob()`, `KnobValue` / `KnobsOf` / `KnobsAt` / `Flatten`, the
patch types, `NoExcess`, the four-level invalidation ladder, the core-declared shared knobs
`paperColor` and `paperBack` with `hexToRgb`, and the runtime resolver behind them.

Ground truth is namespaced and the flat form is a resolver over it. The generated flat union
excludes every key more than one slot declares, so an ambiguous bare key is a compile error rather
than a `KnobError` — while the runtime check stays, because a JavaScript consumer has no types and
a descriptor-driven panel writes a dynamic key.

**Maintainers, at every minor:** review descriptor keys for collisions. A slot that adds a key
colliding with an existing unique one removes that key from the generated flat union and breaks a
TypeScript consumer's build. This is deliberate — the alternative was a fatal collision at mount,
which turns an additive minor into an application that dies on `pnpm update` — but it makes
descriptor collision review a release-checklist item rather than a runtime concern.

There is one `set()`. Its patch parameter rejects excess properties in a variable as well as in a
literal, and it returns `KnobError | undefined` — `undefined`, not `void`, so `if (err)` narrows
and the result is storable.
