# paper-crumple

**This package is deprecated and contains no code.** It exists only so that the name cannot be
taken by someone else, because every document and search result for this library says
"paper-crumple".

Install the three scoped packages instead:

```sh
npm install @paper-crumple/core @paper-crumple/paper @paper-crumple/motion
```

- **[@paper-crumple/core](https://www.npmjs.com/package/@paper-crumple/core)** — the stage, views,
  the knob registry, the scheduler, events, the WebGL2 foundation and the errors. Start here:
  <https://github.com/paper-crumple/paper-crumple/tree/main/packages/core#readme>
- **[@paper-crumple/paper](https://www.npmjs.com/package/@paper-crumple/paper)** — the sheet
  renderer.
- **[@paper-crumple/motion](https://www.npmjs.com/package/@paper-crumple/motion)** — the baked
  motion source and its packs.

The three share one version number. There is no umbrella package and there will not be one: the
pack and tile subpaths cannot be re-exported without defeating the reason they are subpaths.
