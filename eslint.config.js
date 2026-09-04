import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { boundaryFiles } from './eslint.boundaries.js'

export const NO_THROW_MESSAGE =
  'Do not throw: return an Error instead (spec §10.8). Only the named boundary helpers may throw — add the file to boundaryFiles in eslint.boundaries.js.'

/**
 * @param {string[]} allowedToThrow globs of the boundary helper files that may throw
 * @returns {import('eslint').Linter.Config[]}
 */
export function makeEslintConfig(allowedToThrow) {
  return [
    {
      ignores: [
        '**/dist/**',
        '**/node_modules/**',
        '.turbo/**',
        'docs/**',
        '.superpowers/**',
        '.claude/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    prettier,
    {
      files: ['**/*.{js,mjs,cjs}'],
      languageOptions: { globals: globals.node },
    },
    {
      files: ['**/*.{ts,mts,cts,tsx,js,mjs,cjs}'],
      rules: {
        'no-restricted-syntax': [
          'error',
          { selector: 'ThrowStatement', message: NO_THROW_MESSAGE },
        ],
      },
    },
    // The React demo in `examples/playground` is the only React code in the repository, and the
    // rules of hooks are the one class of mistake TypeScript cannot catch there — an effect that
    // reads a stale closure still compiles. Scoped to that directory so nothing else pays for it.
    {
      files: ['examples/playground/**/*.{ts,tsx}'],
      plugins: { 'react-hooks': reactHooks },
      rules: reactHooks.configs.recommended.rules,
    },
    // Spread rather than always-present, so an empty allowlist adds no config object at all.
    ...(allowedToThrow.length > 0
      ? [{ files: [...allowedToThrow], rules: { 'no-restricted-syntax': 'off' } }]
      : []),
  ]
}

export default makeEslintConfig(boundaryFiles)
