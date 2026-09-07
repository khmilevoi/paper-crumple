---
'@paper-crumple/core': major
'@paper-crumple/paper': major
'@paper-crumple/motion': major
---

Packaging gates, and the documentation that makes three scoped packages findable as one family.

`publint` and `arethetypeswrong --profile esm-only` run against the **packed tarballs** rather than
the source tree, alongside an asserted entry list per tarball — which is spec 14's "review the pack
output in CI" turned into something binding. The packed manifest is checked where `workspace:^` has
already become the range a consumer resolves: `^1.x`, a caret and never a tilde, because minors here
are additive and a tilde would make every routine upgrade a three-package flag day. The built output
is checked for the literal `new URL("./2x3.bin", import.meta.url)`, which rolldown is known to
rewrite and which can regress on a toolchain upgrade. The zero-dependency rule is promoted from a
per-manifest assertion to a CI gate that walks `packages/*`. The shipped tiles are gated against
spec 14's 397 478 B budget, and the tarball's copies are asserted byte-identical to the committed
ones, so a "temporary" quality bump fails a release instead of quietly growing the download.

Core's README becomes the canonical entry point: the errors-are-values convention is its first
section rather than a footnote, the what-is-in-the-box table sits under the install line, and the
identical install-and-import block appears verbatim in all three READMEs while all three manifests
point `homepage` at the same URL. It carries the paragraph addressed to wrapper authors — declare
`@paper-crumple/core` in `peerDependencies`, never in `dependencies` — which is the named mitigation
for the duplicate-core hazard alongside `assertSingleCore()`. The `/unstable` subpath is documented
as unstable on the argument that an import path greps cleanly where a JSDoc tag TypeScript does not
enforce would not, and the one real cost of shipping without an umbrella package is recorded rather
than left to be rediscovered: there is no single `esm.sh/paper-crumple` URL for a CDN or a
playground.

A deprecation stub is prepared at the freed unscoped `paper-crumple` name — one README, no source,
no build, no workspace entry — for a release-time publish.
