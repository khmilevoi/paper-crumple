import { playwright } from '@vitest/browser-playwright'
import { configDefaults, defineConfig } from 'vitest/config'

const sharedExclude = [
  ...configDefaults.exclude,
  '**/dist/**',
  // Sibling plan worktrees live at .claude/worktrees/* inside this repository, and agent run
  // scratch lives in .superpowers/. Without these, `vitest run` from the main checkout collects
  // every sibling's tests — and the gl project opens a browser page for each, against the
  // ~16 live WebGL2 context cap. eslint.config.js and .prettierignore already exclude both.
  '**/.claude/**',
  '**/.superpowers/**',
]

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // `.tsx` is here for @paper-crumple/react: its tests render components, and the task
          // gate for this run is `--project unit`, so a separate DOM project would never run.
          // The environment stays `node` and each React test file opts into jsdom with a
          // `@vitest-environment jsdom` docblock, so no existing unit test changes environment.
          include: ['**/*.test.ts', '**/*.test.tsx'],
          // `foo.gl.test.ts` also matches `**/*.test.ts`. Level 2 is not level 1.
          exclude: [...sharedExclude, '**/*.gl.test.ts'],
        },
      },
      {
        test: {
          name: 'types',
          include: [],
          typecheck: {
            enabled: true,
            only: true,
            checker: 'tsc',
            tsconfig: './tsconfig.json',
            include: ['**/*.test-d.ts'],
            exclude: sharedExclude,
          },
        },
      },
      {
        test: {
          name: 'gl',
          include: ['**/*.gl.test.ts'],
          exclude: sharedExclude,
          // One page per test file, run in parallel, against a cap of ~16 live WebGL2
          // contexts (spec 4.0) is a bounded resource spent unboundedly.
          fileParallelism: false,
          browser: {
            enabled: true,
            // Pinned, not defaulted from process.env.CI: a contributor's run is CI's run.
            headless: true,
            provider: playwright({
              launchOptions: {
                // Selects the new headless mode. Never pass --headless=new by hand.
                channel: 'chromium',
                args: [
                  // ANGLE is the implementation and SwiftShader is the backend it is
                  // pointed at. `--use-gl=swiftshader` is not a Chromium implementation
                  // name and fails GL init outright.
                  '--use-gl=angle',
                  '--use-angle=swiftshader',
                  // Without this, getContext('webgl2') returns null.
                  '--enable-unsafe-swiftshader',
                ],
              },
            }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
