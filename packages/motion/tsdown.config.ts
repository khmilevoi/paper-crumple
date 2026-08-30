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
})
