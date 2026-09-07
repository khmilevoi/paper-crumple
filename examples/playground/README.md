# playground

A local demo of the `@paper-crumple` family. Not published, not in CI.

```sh
pnpm --filter @paper-crumple/playground dev   # builds the three packages, then serves on :5180
```

## The control panel is a port, not a design of its own

The whole page is a literal port of `Paper Crumple Control Panel v2.dc.html`, the Claude Design
mockup this demo is built to — same header, same stage, same transport, same five numbered
sections, same copy, same colours and spacing. `src/styles.css` is that file's inline styles moved
onto a class per node, value for value; where the two disagree, this repository is wrong.

React, and not the hand-written DOM this demo used to be, for one reason: the mockup is itself a
component with `state` and a `render`, so a component tree can mirror it node for node instead of
re-deriving its structure from imperative `createElement` calls.

Exactly two things on the page have **no counterpart in the mockup**, and both are marked as such
where they appear:

- **the canvas-background switcher** (bottom of "05 Look & debug") — dark / light / checker behind
  the sheet, so a reader can see whether the canvas is really transparent rather than take it on
  faith;
- **the numbered sections after "05"** — the engine declares about forty knobs and the mockup
  curates about twenty of them, so the rest keep a home here, grouped by the library's own
  taxonomy (`src/labels.ts`) and drawn with the same row primitives, followed by the `DemoConfig`
  factory options.

Everything else the pre-port playground carried and the mockup does not — the six-tile broadcast
grid, the inspector, the "copy as code" panel, the standalone stop button and the broadcast
controls — is gone.

## How it is put together

| file             | what it owns                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `src/main.tsx`   | the React root, and the duplicate-core check that must run before it                         |
| `src/ui/App.tsx` | all page state, the playback and swap paths, and the diagnostics figures                     |
| `src/ui/*.tsx`   | one component per node group of the mockup                                                   |
| `src/scene.ts`   | the stage lifecycle over `usePaperScene`: build, dispose, and the knob carry-over on rebuild |
| `src/hero.ts`    | the one hero view over `useCrumple`: entrance, swap and the frame style the slot renders     |
| `src/stage.ts`   | prefetching the other samples, and the renderer string the diagnostics footer uses           |
| `src/config.ts`  | `DemoConfig` — everything §6.5 calls a factory option — and `buildStage`                     |
| `src/knobs.ts`   | descriptor collection, keyed the way `stage.set` wants                                       |
| `src/audio.ts`   | the sound controller, headless: a snapshot plus a subscription                               |
| `src/state.ts`   | the URL fragment, encoded and decoded                                                        |

**Factory options rebuild; knobs do not.** That split (§6.5) is why `scene.ts`'s `useDemoScene`
depends on exactly `config`: a knob write goes straight to the live stage and costs one draw. A
rebuild is not a reset — every knob a reader moved away from its default is carried onto the new
stage, and any key the new slot set no longer declares is skipped.

The address bar is always a live share link: every landed rebuild and every knob write rewrites the
fragment with `replaceState`, so dragging a slider adds no history entries.

## The diagnostics strip

Five of the six tiles are measured, not quoted:

- **texture** — the sprite's front texture; **sheet** and **bucket / stretch** — `fitSheet` against
  the silhouette's real bounding box.
- **pass a / b** — `paperStage` plus both slots, then `view` + `show` after the front bake.
- **hull** — the front bake itself, which is where the hull polygon is built; an em dash under
  `edgeShape: 'torn'`, which builds no polygon, exactly as the mockup prints it.
- **draw / step** — the mockup's tile here reads "draw / upload". Nothing in the library reports an
  upload separately (it happens inside `add()`, which the **hull** tile already times), so this one
  pairs the two per-frame numbers that _are_ measurable: a draw-only pose change timed at the call,
  and the interval between two scheduled renders of the last run. `step.ms` is
  elapsed-since-`start`, not a per-step cost, so the interval is the difference of two of them.

## Sound (optional, and not in this repository)

There is no on/off switch, because the mockup has none: **`none — silent` in the clip picker is
off**, and it is the default. Nothing is fetched at boot; the manifest probe runs when "04 Sound"
is first opened, which is also the gesture the autoplay policy wants — a demo page that makes a
sound, or a request for one, before being asked is hostile.

The clips live in `examples/playground/public/audio/`, which is **gitignored**: they came from the
throwaway spike this library was ported from and are not this repository's to redistribute. So the
folder is absent on a fresh clone, and everything about that path is a first-class state rather
than a failure — `src/audio.ts` degrades to silence and says so in the readout box, naming where
the assets come from. The fold still runs; it is simply quiet.

To hear it, copy the spike's `assets/audio/` (five `.wav` files plus `manifest.json`) into
`examples/playground/public/audio/`. Vite serves `public/` at the root, so no restart is needed.

### How the sound and the fold stay in sync

The spike owned its own `setTimeout` step loop and kept the sound from drifting away from it with
an absolute-deadline helper (`audio.nextDelay(dwell)`). The library owns the scheduler now, and
`stepper.ts` **is** that loop — so the demo has no equivalent and must not grow one. What is left
is the single lever the library does expose: `duration`.

`manifest.json` carries every clip's measured trimmed length, so the schedule is computable before
an `AudioContext` exists (one created before a user gesture starts suspended). In `Scale to sound`
mode the run is given `duration = clip length`; `playPlan` spreads that over the traversed dwells
as `(duration × cumulative) / authored`, which is one multiplier over the whole run — the authored
uneven stop-motion cadence in `pc.DWELL_MS` survives exactly, and the run ends when the clip does.
`Fixed` passes the transport's own 900 ms and lets the clip play over it.

`pc.DWELL_MS` is read and never copied. Unfolding plays the clip reversed, which is a memcpy over
the sample data rather than five more sourced files.

Two sync surfaces, and where they differ:

- **fold / unfold** — exact: the traversed authored total (the trailing dwell is never spent) is
  rescaled to the clip. The readout box prints that schedule and, after a run, its drift.
- **swap** — exact in the schedule, but the park at the ball is never rescaled _below_ the time the
  new sprite takes to load, so a first, uncached swap outlasts the clip by that load. A repeat swap
  of a cached sprite lands on the clip.

## Errors

Every narrowed Error the page observes — a refused knob write, a stage build that failed, a swap
that 404'd and rolled back, an audio asset that is not there — goes to the header's status pill and
nowhere else. That is the mockup's own error channel (its `statusBad` branch carries exactly this
kind of message), and a second log panel beside it would only be one more thing to keep in sync.
