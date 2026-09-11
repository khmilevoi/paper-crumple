/**
 * Registers the resolve hook that lets plain `node` run the packages' TypeScript sources directly
 * (Node >= 23.6 strips types natively; the repo's `devEngines` floor is 22.18, whose
 * `--experimental-strip-types` the `bench:cpu` script does not pass — run the bench on 24+).
 * Two rewrites, nothing else:
 *
 *   - `@paper-crumple/core`, its `unstable` and `bindings` entries, `@paper-crumple/paper`,
 *     `@paper-crumple/motion`, `@paper-crumple/reatom` -> the matching source barrel, so one copy of
 *     core is shared by every package (the `instanceof` guarantee of spec 10.4 holds in the bench
 *     exactly as it does in a real install).
 *   - a relative `./x.js` specifier -> `./x.ts` when that file exists, which is how the sources
 *     spell their own imports (`moduleResolution: node16` style).
 *
 * The bench therefore measures the sources as written, and every profile frame cites a `src`
 * file and line — which is what the optimisation tasks need to act on. `dist` is a tsdown bundle
 * of the same JavaScript; the hot loops are byte-identical after type stripping.
 */
import { register, registerHooks } from 'node:module'
import { resolve } from './hooks.mjs'

if (typeof registerHooks === 'function') {
  registerHooks({ resolve })
} else {
  register('./hooks.mjs', import.meta.url)
}
