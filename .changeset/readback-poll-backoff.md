---
'@paper-crumple/core': patch
'@paper-crumple/paper': patch
---

**The field readback's fence poll backs off instead of spinning a core** (spec §8.10).

`nextTurn()` (`@paper-crumple/core/unstable`) takes one option: `nextTurn({ delay })`, a later
task no sooner than `delay` milliseconds — `scheduler.postTask(fn, { priority: 'user-visible',
delay })` where the scheduler exists, `setTimeout(fn, delay)` where it does not (the
`MessageChannel` route cannot wait, so a delayed turn skips it). Called with no argument, with
`{}`, or with `{ delay: 0 }` it is the function it was, key for key.

`paperSheet().source()` uses it for the fence wait its asynchronous readback sits in. It polled
`clientWaitSync` once per undelayed turn, at ~47 µs a turn, so one core spun for the whole GPU
wait — ~20 ms per add on ANGLE D3D11, ~700 ms on SwiftShader, and up to ~47 s on a driver whose
fence never signals. It now polls eight fast turns — enough that a fence already signalled, or
signalling within a few turns of the issue, is answered with no added latency — and every turn
after that with a 1 ms delay.

Observable timing: a readback whose fence outlives eight turns is noticed 1–4 ms after it signals
(the browser's timer clamp) rather than within a turn, so a single `stage.add()` on a busy GPU can
report up to ~4 ms more wall time while leaving a core free for the whole wait. The give-up bound
that hands the field to the CPU fallback is now ten seconds of wall clock rather than a million
turns; what it answers — the same CPU field, once — is unchanged.
