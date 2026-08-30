/**
 * The version this copy of core reports on the duplicate-core marker (§10.4).
 *
 * It is a literal rather than a read of `package.json`, because the published build is a
 * browser bundle and must not carry a JSON import. `single-core.test.ts` asserts it against the
 * manifest, so a release that bumps one and not the other fails the gate rather than shipping a
 * marker that lies about which copy is loaded.
 */
export const VERSION = '0.0.0'
