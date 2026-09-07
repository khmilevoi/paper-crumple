import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    tiles: 'src/tiles.ts',
  },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
  // The four tiles `src/tiles.ts` addresses with `new URL('./tiles/<name>.webp',
  // import.meta.url)`. `files: ["dist"]` is the whole tarball story (spec 14), so an asset that
  // is not copied here does not ship, and the specifier has to resolve the same way from `src/`
  // under Vitest and from `dist/` in a tarball.
  copy: [{ from: 'src/tiles/*.webp', to: 'dist/tiles', flatten: true }],
})
