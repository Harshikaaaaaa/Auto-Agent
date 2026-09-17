import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    // Build output, dependencies, and legacy artifacts are never linted.
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'docs/**',
      '*.bak',
      'index.html.bak',
      'server/data/**',
      'server/.wa-auth/**',
    ],
  },

  // ---------- Browser / React source ----------
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // TRACKED DEBT (Task 14 — decompose the canvas god component).
      // WorkflowCanvas/useTools call setState synchronously inside effects, which
      // causes cascading renders. Fixing it properly means restructuring those
      // effects into derived state or event handlers, which belongs with the
      // component split, not with the tooling commit. Kept visible as a warning
      // rather than silenced so it cannot be forgotten.
      'react-hooks/set-state-in-effect': 'warn',

      // `any` is pervasive in the existing graph-state code. It is a warning so it
      // shows up as debt without blocking the build; new code should avoid it.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // Security-relevant: these are the exact primitives Task 4 removes.
      // Keep them hard errors so they can never be reintroduced.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
    },
  },

  // ---------- Tests ----------
  {
    files: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'src/test/**/*.{ts,tsx}',
      'server/**/*.{test,spec}.js',
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests intentionally assert on thrown values without re-wrapping them.
      'preserve-caught-error': 'off',
    },
  },

  // ---------- Node server ----------
  {
    files: ['server/**/*.js', 'scripts/**/*.{js,mjs}', '*.config.{js,ts}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
