# tools/tiles

The one-time encoder for the four paper tiles on `@paper-crumple/paper/tiles`, and the command
that produced the files committed at `packages/paper/src/tiles/`.

`sharp` is not a dependency of this repository and must not become one: `tools/` sits outside the
workspace glob, `tools/package.json` must never exist, and every published package declares
`"dependencies": {}`. Point `--modules` at any checkout whose `node_modules` holds `sharp`.

## The command that produced the committed files

```bash
node tools/tiles/encode-tiles.mjs \
  --modules "C:/Users/Khmil/JsProjects/odeja/spikes/paper-fold" \
  --crumple "C:/Users/Khmil/JsProjects/odeja/spikes/paper-fold/assets/paper-crumple.png" \
  --fibre   "C:/Users/Khmil/JsProjects/odeja/spikes/paper-fold/assets/paper-fibre.png" \
  --out     "packages/paper/src/tiles"
```

Sources: `paper-crumple.png` (992 273 B, 512x512 RGBA8) and `paper-fibre.png` (857 141 B,
512x512 RGBA8), both from the `paper-fold` spike, which is this design's only source of truth for
behaviour (spec 1).

## Output

The encoder's own stdout from the run that produced the committed files:

```
crumple-r.webp: 106632 B
crumple-g.webp: 104862 B
crumple-a.webp: 41690 B
fibre-a.webp: 80160 B
total: 333344 B
```

| file             | channel                              |       bytes |
| ---------------- | ------------------------------------ | ----------: |
| `crumple-r.webp` | `round(crumple.r * crumple.a / 255)` |     106 632 |
| `crumple-g.webp` | `round(crumple.g * crumple.a / 255)` |     104 862 |
| `crumple-a.webp` | `crumple.a`                          |      41 690 |
| `fibre-a.webp`   | `fibre.a`                            |      80 160 |
| **total**        |                                      | **333 344** |

## Why these four, in this form

Only 4 of the 8 channels are ever sampled (spec 14, **[verified]**): `crumple.rg`
(`paper.js:1302`, `:1644`), `crumple.a` (`:1321`, `:1648`) and `fibre.a` (`:1563`, `:1704`,
`material.js:79`). `crumple.b` and `fibre.rgb` are dead weight, since the normal's z component is
the literal `1.0` in both `normalize(vec3(..., 1.0))`.

Grayscale WebP at quality 84, uploaded as `R8`. Grayscale coding has no colour transform, which is
why four separate files beat one packed RGBA tile at every budget: three independent noise fields
in shared RGB planes absorb each other's quantisation error, and the best packed AVIF measured
RMSE 5.31 at 406 740 B against 3.15 for four grayscale files at 397 478 B (measured at q84 on the
stored, non-premultiplied values; see below for why the committed bytes differ).

The bytes are the **premultiplied product** (spec 14.1): `paper.js:2126` leaves
`createImageBitmap`'s `premultiplyAlpha` at `'default'`, Chromium chooses `premultiply`, and
`UNPACK_PREMULTIPLY_ALPHA_WEBGL` is ignored for an `ImageBitmap` source, so the shipped look is the
premultiplied one and baking from the stored values would change it. Premultiplication does not
alter an alpha channel, so the two alpha planes pass through untouched. This is why the committed
total (333 344 B) differs from the 397 478 B figure quoted above: premultiplied `crumple.r` and
`crumple.g` compress differently than the stored, unmultiplied planes the spec's own measurement
was run against, but the total remains comfortably inside the ≤400 KB budget asserted later, by
P13, against the packed tarball.
