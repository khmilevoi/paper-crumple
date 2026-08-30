# tools

Kept in the repository and never published (spec §13). `pnpm-workspace.yaml` lists `packages/*`
and nothing else, so nothing here is a workspace package and nothing here can reach a tarball —
the guarantee is structural rather than a matter of discipline.

`tools/bake/` will hold the Python pack writer and its unit tests, the Blender launcher, the
synthetic-pack generator, the JS twin writer and the `tiny` fixture. P12 creates it.
`synthetic.bin` (539 KB) is a fixture and must not ship.

The Blender-dependent parts of the bake pipeline — `crumple.py`, `smoke.py`, `foldTable.mjs`,
`folds.json` — are excluded from the published graph. `run.mjs` honours a `BLENDER=` environment
override over its hard-coded Steam path.
