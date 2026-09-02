# Publishing the deprecation stub

A **release-time action**, run once by hand, after the family's `1.0.0` is on npm. This directory is
not a workspace package, has no source and no build, and is not versioned by Changesets — it ships
once and is never versioned again.

Order matters: npm will not accept a publish of a version that does not exist yet, so the package is
published first and deprecated second.

```sh
cd release/paper-crumple
npm publish --access public
npm deprecate paper-crumple@1.0.0 "Not the library. Install @paper-crumple/core, @paper-crumple/paper and @paper-crumple/motion."
```

Verify:

```sh
npm view paper-crumple deprecated
```

Then do nothing further with it, ever. If the scoped packages move, edit this README and republish
as `1.0.1`; the deprecation must be reapplied to the new version, because `npm deprecate` is
per-version.
