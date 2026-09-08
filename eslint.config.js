const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['.opencode/dist/**', '.cursor/**', 'node_modules/**', '.venv/**', 'venv/**', 'coverage/**', 'workflows/**/*.workflow.*', '.claude/workflows/**']
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.es2022
            }
        },
        rules: {
            'no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }],
            'no-undef': 'error',
            'eqeqeq': 'warn',

            // post-edit-standards CRITICAL rules — hook exits(1) on violation (detected by rule name,
            // not ESLint severity). Set as warn here so CI lint does not block on existing debt
            // while the refactor backlog (PR4) is completed. Change back to error once clean.
            'complexity': ['warn', { max: 20 }],
            'max-depth': ['error', { max: 5 }],

            // post-edit-standards WARNING rules — reported but non-blocking
            'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
            'max-params': ['warn', { max: 5 }]
        }
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            sourceType: 'module'
        }
    },
    {
        // Test files use sequential runTests() enumerators — complexity and line-length rules
        // are intentionally relaxed. The hook rules (complexity, max-lines-per-function) are
        // production code quality gates and do not apply to test infrastructure.
        files: ['tests/**/*.js'],
        rules: {
            'complexity': 'off',
            'max-lines-per-function': 'off',
            'no-useless-assignment': 'off',
        }
    }
];
