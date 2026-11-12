import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  __dirname: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.vite/**',
      'docs/**',
      '.mona/**',
      'tests/**',
      'tools/**',
      'tests/**',
      'package-lock.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: nodeGlobals,
    },
  },
);
