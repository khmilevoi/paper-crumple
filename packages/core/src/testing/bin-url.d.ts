/**
 * §11.1: "a fixture loads as `import '…/tiny.bin?url'` followed by a `fetch`". Vite resolves the
 * suffix to a served URL; TypeScript needs telling that it is a string.
 *
 * This file has no top-level `import` or `export` on purpose — an ambient module declaration for
 * a wildcard pattern is only legal in a script, not in a module.
 */
declare module '*.bin?url' {
  const url: string
  export default url
}
