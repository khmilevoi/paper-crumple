---
'@paper-crumple/core': patch
---

Add the sprite source path: `SpriteSource`, its normalisation, and the derived re-supplier.

`add` takes a source rather than only a bitmap. A `string`, `URL` or `Blob` is reclaimable by
construction, because the re-supplier is the fetch the library already performed — which is what
lets the byte budget bound a sprite at all, since a sprite whose bytes cannot be re-fetched cannot
be evicted. The three arms no supplier can be derived from — a bare `ImageBitmap`,
`HTMLImageElement` or `HTMLCanvasElement` — require `pin: true` in the type, so an unbounded front
is a signed decision rather than an omission.

The same-image contract a key stands for is detected rather than merely stated: the first
response's `ETag` / `Last-Modified` is recorded and a conditional request is issued on re-supply.
`304` is a rebuild; `200` reports that the bytes moved, with a warning naming the key. The limit is
stated rather than papered over — a cross-origin response without
`Access-Control-Expose-Headers: ETag` exposes neither header, and there the contract is documented
and unenforced. A `Blob` is immutable and needs no check.

`ImageBitmap` ownership is settled in one place: the library closes every bitmap it obtained and
never closes one it was given, so `stage.add(b, { key, pin: true }); b.close()` in the same turn is
legal, a closed or detached bitmap resolves to an `AddError` rather than rejecting, and a supplier
must mint a fresh bitmap per call.
