# playground

A local demo of the `@paper-crumple` family. Not published, not in CI.

```sh
pnpm --filter @paper-crumple/playground dev   # builds the three packages, then serves on :5180
```

Four blocks:

- **Factory options** — settings that change the shape of the program, the set of resources, or
  the set of other knobs (§6.5). Changing one disposes the stage and rebuilds it, then re-applies
  your knob values.
- **Knobs** — every descriptor the two slots declare, live. The controls are _generated_ from
  `sheet.knobs` / `motion.knobs`, which are `readonly KnobDescriptor[]` at runtime; nothing here
  is a hand-written list, so a knob added to the library appears by itself.
- **Stage** — one WebGL2 context: a hero view and a six-tile grid. The grid is there to show that
  `presetForImageId(key)` gives each sprite its own fold, so a broadcast does not fold in unison.
- **Inspector** — warnings, the event log, `usage()`, and the two error channels side by side.
