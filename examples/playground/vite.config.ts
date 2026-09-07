import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The three packages resolve their own assets with `new URL('./x', import.meta.url)` from
// modules inside `dist` — the four paper tiles and the three motion pack binaries. Vite's
// dependency pre-bundler rewrites those modules into `.vite/deps`, which moves them away from
// the assets sitting beside them, and every tile and pack then 404s with no error the library
// can report as anything but a fetch failure. Excluding the packages keeps the modules where
// their assets are.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@paper-crumple/core', '@paper-crumple/paper', '@paper-crumple/motion'],
  },
  server: { port: 5180 },
})
