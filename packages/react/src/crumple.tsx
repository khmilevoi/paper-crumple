import type { CrumpleMethods, CrumpleSnapshot } from './crumple-types.js'

/**
 * What `useCrumple` returns and what `<Crumple value>` takes.
 *
 * **Deliberately NOT identity-stable**: it carries the reactive snapshot, so it is a fresh object
 * per render by construction. Depend on `crumple.shown` or on `crumple.play`, never on `crumple`
 * (§2.1). The methods and `ref` on it are stable; the object around them is not.
 *
 * Declared here rather than beside the other types because the component below shares its name:
 * a value and a type of one name can only be exported together from a single module, where the
 * two declarations merge. Split across two modules it is `TS2300: Duplicate identifier`.
 */
export interface Crumple extends CrumpleSnapshot, CrumpleMethods {}
