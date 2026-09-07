---
'@paper-crumple/core': minor
---

**`stage.defaults` — every knob's default, under the registry's own path.**

`stage.knobs` is `readonly KnobDescriptor[]` carrying slot-local keys with no path, so a consumer
holding a knob key had no way to ask what its default was. Resetting a knob meant keeping a
hand-maintained copy of the defaults beside the stage, and a consumer that wrote knobs
declaratively could only ever write the keys it had been given — never clear one.

The knob registry has built a frozen, namespaced default map once at mount since it was written.
The stage now hands that same object out:

```ts
stage.defaults['core.paperColor'] // '#f7f4ed'
stage.defaults['sheet.grain'] // the sheet's own default

// A slot-scoped default is written back under the very path it is keyed by:
stage.set({ 'sheet.grain': stage.defaults['sheet.grain'] })
// A core-declared shared knob is written back under its BARE key, which is what writes core's
// descriptor and every descriptor bound to it at once:
stage.set({ paperColor: stage.defaults['core.paperColor'] })
```

- **Namespaced paths.** `<slot>.<key>` — `sheet.grain`, `motion.grain`, `core.paperColor`. A path
  is the only unambiguous spelling when both slots declare the same key, which is why `defaults`
  is keyed this way rather than by the bare keys `stage.knobs` carries.
- **Shared knobs are written back by their bare key.** `set()` resolves only the `sheet.` and
  `motion.` namespaces, and separately refuses the namespaced path of any descriptor that declares
  `binds`. So `core.paperColor` and `core.paperBack` — and any slot descriptor bound to one of
  them — are keyed by path in `defaults` but written back as `paperColor` / `paperBack`, which is
  what keeps every bound slot identical. Every other path is written back exactly as `defaults`
  keys it.
- **One frozen object, handed out by identity.** It is not rebuilt per read, so it is safe as a
  React effect dependency; an undeclared key reads `undefined`.
- `KnobPrimitive` and `KnobValues` are re-exported from the package root so the field's type can
  be named.

Also in this release: `PlayOptions.duration`'s docblock called it "one multiplier". It is wall time
in milliseconds for the whole traversal, which is what `swapPlan` and every other statement of it
already said. Behaviour is unchanged; only the comment was wrong.
