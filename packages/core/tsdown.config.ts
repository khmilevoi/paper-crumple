import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    unstable: 'src/unstable.ts',
    bindings: 'src/bindings.ts',
  },
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
})
