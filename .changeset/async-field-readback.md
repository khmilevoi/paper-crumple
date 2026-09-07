---
'@paper-crumple/paper': patch
---

**`paperSheet().source()` reads its field back asynchronously** (spec §8.10).

The signed field pass A leaves on the GPU used to come back through a synchronous `readPixels`
— a full GPU drain on the main thread, of this sprite's jump flood and of everything queued
ahead of it (every step draw, the previous sprite's build). `source()` now issues the
`readPixels` into a `PIXEL_PACK_BUFFER`, fences it, polls the fence once per platform turn
(`nextTurn()` from `@paper-crumple/core/unstable`: `scheduler.postTask` → `MessageChannel` →
`setTimeout(0)`) and copies the bytes out with `getBufferSubData` once it has signalled. The
decode, the hull and both rects are byte-identical to the synchronous path (pinned by goldens).
A `readPixels` the driver refuses is read once the fence signals — one `getError` after the
copy, before any decode — and falls to the same CPU field it always did, turns later; a wait
that fails (`WAIT_FAILED`, a lost context) takes that fallback too, and a `dispose()` while the
readback is in flight answers a `SheetError` instead of a handle. Torn mode reads the field once
per add where it read it twice. Abort check point 2 (spec §10.5) is the fence wait: a
signal fired while the readback is in flight answers `ABORTED` on the next turn, with the fence
deleted and no pack buffer left bound. On an injected (consumer) context both halves of the
readback leave the consumer's own `PIXEL_PACK_BUFFER` binding null — the issue at once, the
completion in a later task — because §5.1's restore set does not carry that binding; a consumer
that keeps a pack buffer bound across a `source()` rebinds it.

Observable timing: `source()` — and so `stage.add()` — now resolves at least one macrotask after
the call where it used to resolve on a microtask, and on a busy GPU it resolves when the readback
lands rather than blocking the main thread until it does. Two direct concurrent `source()` calls
on one sheet each get their own field now (the second takes the synchronous read while the pack
buffer is busy) where they used to race on the shared field slot.
