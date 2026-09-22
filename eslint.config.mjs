// ESLint 9 flat config for JobTinder NestJS + TypeScript + Vitest
// Reference: https://eslint.org/docs/latest/use/configure/configuration-files-new

import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

const TS_FILES = ['src/**/*.ts', 'test/**/*.ts', 'prisma/seed.ts'];

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'prisma/migrations/**',
      'coverage/**',
      '.pnpm-store/**',
    ],
  },
  js.configs.recommended,
  {
    files: TS_FILES,
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module',
        project: ['./tsconfig.json'],
      },
      globals: {
        ...globals.node,
        ...globals.es2023,
        // Vitest globals:
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        test: 'readonly',
        beforeEach: 'readonly',
        beforeAll: 'readonly',
        afterEach: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier,
    },
    rules: {
      ...tseslint.configs['recommended-type-checked']?.rules ?? {},
      ...prettierConfig.rules,
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Disable type-checked rules that need strict tsconfig.project alignment
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      // Promise-returning test doubles and provider adapters intentionally
      // use async interface-compatible methods without awaiting locally.
      '@typescript-eslint/require-await': 'off',
      // Prisma's GetPayload uses `{}` as its default argument by design.
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      'prettier/prettier': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-undef': 'off',
    },
  },
  {
    // Test-specific overrides
    files: ['test/**/*.ts', 'src/**/__tests__/**/*.ts', 'src/**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    // Prisma seed overrides
    files: ['prisma/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
