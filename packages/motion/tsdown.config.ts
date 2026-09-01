import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'packs/2x3': 'src/packs/2x3.ts',
    'packs/1x1': 'src/packs/1x1.ts',
    'packs/3x2': 'src/packs/3x2.ts',
  },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
  // Rolldown emits `new URL('./2x3.bin', import.meta.url)` verbatim and copies nothing. Measured
  // against this repository's tsdown 0.22.14 / rolldown 1.2.6: without these three lines `dist/`
  // holds the modules and no binary, and `files: ["dist"]` publishes three packs that 404.
  // `to` is a directory: pointing it at the file name produces `dist/packs/2x3.bin/2x3.bin`.
  copy: [
    { from: 'src/packs/2x3.bin', to: 'dist/packs' },
    { from: 'src/packs/1x1.bin', to: 'dist/packs' },
    { from: 'src/packs/3x2.bin', to: 'dist/packs' },
  ],
})
