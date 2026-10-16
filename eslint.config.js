// ESLint: the recommended rules plus the code-quality rules the Airbnb and
// Google style guides share. Layout (line length, one statement per line, ...)
// is left to Prettier. Run: npm run lint
'use strict';
const js = require('@eslint/js');
const globals = require('globals');

const quality = {
  eqeqeq: 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  'one-var': ['error', 'never'],
  'no-shadow': 'error',
  'no-param-reassign': 'error',
  'no-multi-assign': 'error',
  'consistent-return': 'error',
  'no-else-return': 'error',
  'no-nested-ternary': 'error',
  'no-implicit-coercion': 'error',
  'no-restricted-globals': [
    'error',
    {
      name: 'isFinite',
      message: 'Use Number.isFinite: the global one converts its argument first.',
    },
    { name: 'isNaN', message: 'Use Number.isNaN: the global one converts its argument first.' },
  ],
  // the operator pairs Airbnb asks to parenthesise
  'no-mixed-operators': [
    'error',
    {
      groups: [
        ['%', '**'],
        ['%', '+'],
        ['%', '-'],
        ['%', '*'],
        ['%', '/'],
        ['/', '*'],
        ['&', '|', '<<', '>>', '>>>'],
        ['==', '!=', '===', '!=='],
        ['&&', '||'],
      ],
      allowSamePrecedence: false,
    },
  ],
  'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
  curly: ['error', 'multi-line'],
  'guard-for-in': 'error',
  'require-await': 'error',
  'prefer-arrow-callback': 'error',
  'prefer-template': 'error',
  'object-shorthand': 'error',
  complexity: ['error', 20],
  'max-depth': ['error', 4],
  'max-params': ['error', 5],
  'max-lines-per-function': ['error', { max: 100, skipComments: true, skipBlankLines: true }],
};

module.exports = [
  { ignores: ['node_modules/', 'spring-tool.html', 'test/out/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: quality,
  },
  // inlined into the page as classic scripts
  {
    files: ['src/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, SpringSolver: 'readonly' },
    },
  },
  // code passed to page.evaluate runs in the browser
  {
    files: ['test/browser.test.js'],
    languageOptions: { globals: { ...globals.browser, __jig: 'readonly' } },
  },
];
