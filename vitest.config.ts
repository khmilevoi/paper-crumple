import { configDefaults, defineConfig } from 'vitest/config'

const sharedExclude = [...configDefaults.exclude, '**/dist/**']

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['**/*.test.ts'],
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
    ],
  },
})
