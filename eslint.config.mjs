// typescript-eslint's recommended rules, less the ones the code has good
// reason to break: server answers are untyped json (any), and some older
// code aliases `this` or reads a var before its declaration, and
// `import x = require('lodash/x')` pulls one module into the bundle. Unused names
// warn rather than fail: the older files still have some, and they go as the
// code around them is touched.
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['out/**', 'dist/**', 'node_modules/**', 'media/**', 'syntaxes/**', '.vscode-test/**'] },
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-this-alias': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
            '@typescript-eslint/no-require-imports': ['error', { allowAsImport: true }],
            'no-var': 'warn',
        },
    },
);
