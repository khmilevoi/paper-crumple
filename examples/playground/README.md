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
- **Inspector** — warnings, the event log, `usage()`, the audio schedule figures, and the two
  error channels side by side.

## Sound (optional, and not in this repository)

The transport has a `sound` tick. It is **off on every load** and nothing is fetched until it is
ticked — a demo page that makes noise, or a network request for a sound, before being asked is
hostile, and leaving the probe until the opt-in is also what keeps a clean clone's console empty.

The clips live in `examples/playground/public/audio/`, which is **gitignored**: they came from the
throwaway spike this library was ported from and are not this repository's to redistribute. So the
folder is absent on a fresh clone, and everything about that path is a first-class state rather
than a failure — `src/audio.ts` degrades to silence, lists the reason in the inspector's **Audio**
section and the two error channels, and prints one visible line under the transport saying the
assets are absent and where they come from. The fold still runs; it is simply quiet.

To hear it, copy the spike's `assets/audio/` (five `.wav` files plus `manifest.json`) into
`examples/playground/public/audio/`. Vite serves `public/` at the root, so no restart is needed.

### How the sound and the fold stay in sync

The spike owned its own `setTimeout` step loop and kept the sound from drifting away from it with
an absolute-deadline helper (`audio.nextDelay(dwell)`). The library owns the scheduler now, and
`stepper.ts` **is** that loop — so the demo has no equivalent and must not grow one. What is left
is the single lever the library does expose: `duration`.

`manifest.json` carries every clip's measured trimmed length, so the schedule is computable before
an `AudioContext` exists (one created before a user gesture starts suspended). In `scale` mode the
run is given `duration = clip length`; `playPlan` spreads that over the traversed dwells as
`(duration × cumulative) / authored`, which is one multiplier over the whole run — the authored
uneven stop-motion cadence in `pc.DWELL_MS` survives exactly, and the run ends when the clip does.
`fixed` mode passes the transport's own 900 ms and lets the clip play over it.

`pc.DWELL_MS` is read and never copied. Unfolding plays the clip reversed, which is a memcpy over
the sample data rather than five more sourced files.

Three sync surfaces, and where they differ:

- **fold / unfold** — exact: the traversed authored total (495 ms out, 490 ms back — the trailing
  dwell is never spent) is rescaled to the clip.
- **swap** — exact in the schedule, but the park at the ball is never rescaled _below_ the time
  the new sprite takes to load, so a first, uncached swap outlasts the clip by that load. The
  `last run` row measures it rather than hiding it; a repeat swap of a cached sprite lands on the
  clip.
- **broadcast** — one clip for the whole broadcast, because `duration` is _per view_. The last
  view still finishes `(views − 1) × stagger` after the clip ends; that overhang is printed under
  the broadcast report rather than hidden.

Under `prefers-reduced-motion: reduce` a swap degrades to one `show()` with no run, and the sound
is cancelled with it — a crumple over a single instantaneous draw is the same unrequested motion
cue in another channel.

### The numbers

A sound cannot be seen in a screenshot, so the inspector's **Audio** section prints what would
otherwise have to be believed: which assets loaded and decoded, the clip's length and whether that
came from the manifest or the decoded buffer, the `AudioContext` state and `currentTime`, the
authored total and rescale factor for a fold, an unfold and a swap, the exact per-step schedule the
next fold will run, and — after each run — the requested duration against the _measured_ one and
its drift from the clip.
