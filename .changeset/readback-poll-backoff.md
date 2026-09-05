---
'@paper-crumple/core': patch
'@paper-crumple/paper': patch
---

**The field readback's fence poll backs off instead of spinning a core** (spec §8.10).

`nextTurn()` (`@paper-crumple/core/unstable`) takes one option: `nextTurn({ delay })`, a later
task no sooner than `delay` milliseconds, always through `setTimeout(fn, delay)`. Neither of the
two faster routes can carry a delay: the `MessageChannel` cannot wait at all, and
`scheduler.postTask`'s own `delay` option wakes on the next frame — measured at a median of
15.5 ms headless and 4.6 ms in a visible window, against 5.0 / 5.3 ms for a chained `setTimeout`,
which pays only the platform's nesting clamp. Called with no argument, with `{}`, or with
`{ delay: 0 }`, `nextTurn` is the function it was, route for route and key for key.

`paperSheet().source()` uses it for the fence wait its asynchronous readback sits in. It polled
`clientWaitSync` once per undelayed turn, at ~47 µs a turn, so one core spun for the whole GPU
wait — ~20 ms per add on ANGLE D3D11, ~700 ms on SwiftShader, and up to ~47 s on a driver whose
fence never signals. It now polls eight fast turns — enough that a fence already signalled, or
signalling within a few turns of the issue, is answered with no added latency — and every turn
after that with a 1 ms delay.

Observable timing: a readback whose fence outlives eight turns is noticed one timer clamp (~4–5 ms)
after it signals rather than within a turn, so a single `stage.add()` on a busy GPU can report a few
milliseconds more wall time while leaving a core free for the whole wait. The give-up bound
that hands the field to the CPU fallback is now ten seconds of wall clock rather than a million
turns; what it answers — the same CPU field, once — is unchanged.
