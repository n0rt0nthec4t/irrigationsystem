import stylistic from '@stylistic/eslint-plugin';
import parserTs from '@typescript-eslint/parser';

export default [{
  ignores: ['dist'],
  plugins: {
    '@stylistic': stylistic,
  },
  languageOptions: {
    parser: parserTs,
    ecmaVersion: 'latest',
    sourceType: 'module',
    globals: {
      structuredClone: 'readonly',
      AbortController: 'readonly',
      AggregateError: 'readonly',
    },
  },
  rules: {
    '@stylistic/semi': ['warn'],
    '@stylistic/quotes': ['warn', 'single'],
    '@stylistic/indent': ['warn', 2, {SwitchCase: 1, offsetTernaryExpressions: true}],
    '@stylistic/comma-dangle': ['warn', 'always-multiline'],
    '@stylistic/dot-notation': 'off',
    'eqeqeq': 'warn',
    'curly': ['warn', 'all'],
    '@stylistic/brace-style': ['warn'],
    'prefer-arrow-callback': ['warn'],
    '@stylistic/max-len': ['warn', 140],
    'no-console': ['warn'],
    '@stylistic/no-non-null-assertion': ['off'],
    '@stylistic/comma-spacing': ['error'],
    '@stylistic/no-multi-spaces': ['warn', {ignoreEOLComments: true}],
    '@stylistic/no-trailing-spaces': ['warn'],
    '@stylistic/lines-between-class-members': ['warn', 'always', {exceptAfterSingleLine: true}],
    '@stylistic/explicit-function-return-type': 'off',
    '@stylistic/explicit-module-boundary-types': 'off',
    '@stylistic/member-delimiter-style': ['warn'],
    'no-undef': ['error'],
    'no-unused-vars': ['error'],
    'no-empty': ['error'],
  },
}, {
  // Test harnesses intentionally use Node globals and replace console methods.
  // Keep these allowances scoped to tests so application lint checks stay strict.
  files: ['**/*.test.{js,mjs}'],
  languageOptions: {
    globals: {
      queueMicrotask: 'readonly',
      URL: 'readonly',
      Blob: 'readonly',
      console: 'readonly',
      process: 'readonly',
    },
  },
  rules: {
    'no-console': 'off',
  },
}];
