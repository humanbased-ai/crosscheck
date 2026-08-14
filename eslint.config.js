import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// `npm run lint` has been in package.json since the start, but eslint was never a
// dependency and no config existed, so it failed with "command not found" — a
// quality gate that could not run. This is the missing half.
//
// Deliberately close to the recommended sets: the value here is catching real
// defects (it found a `\s` written inside a template literal, which produced the
// regex `s*` — see loadHarnessSection), not enforcing a house style that CLAUDE.md
// does not ask for. Only two rules are tuned, both because the recommended default
// disagrees with a pattern this codebase uses on purpose.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.claude/**',
      // Prompt/markdown fixtures shipped to vendors, not TypeScript we compile.
      'src/harness/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      // A disable comment that no longer suppresses anything is drift: two in
      // runner.test.ts had slid off the `any` they were written for, so the
      // directive was dead AND the `any` went unreported. Fail on them.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Grouped case labels that share one body — `case 'identical': case 'ahead':`
      // in reviewed-sha.ts — are the intended way to express "these mean the same
      // thing", not an accidental fallthrough.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      // `_`-prefixed names are the established signal here for a binding that must
      // exist (destructuring position, callback arity) but is not read.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
)
