# `tools/bench-3d` — the level-3 harness

**Not in CI, not a workspace package, no manifest, no dependencies.** `tools/` sits outside the
workspace glob by design and `tests/workspace-shape.test.ts` asserts `tools/package.json` does not
exist.

```
pnpm --filter @paper-crumple/core build
pnpm --filter @paper-crumple/motion build
node tools/bench-3d/serve.mjs
```

Then open `http://localhost:8317/tools/bench-3d/`.

The server exists for two headers — `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` — without which the page is not cross-origin isolated,
`performance.now()` is clamped to 100 µs, and every CPU figure is quantisation noise.

The recipe, the thresholds and the write-up template are in `docs/level-3-timing.md`. Do not run
this under SwiftShader; the number it produces there answers a different question.
