'use strict';

/**
 * standards-rules.js — Rule classification tables for post-edit-standards hook.
 *
 * Separates rule definitions from execution logic so classification can be
 * updated without touching the hook or handler scripts.
 *
 * CRITICAL rules  → exit(1), Claude must refactor before continuing
 * WARNING rules   → exit(0), Claude should address before committing
 */

// ─── ESLint (TypeScript / JavaScript) ────────────────────────────────────────

const ESLINT_CRITICAL = new Set([
  'complexity',                                       // function too complex — split it
  'max-depth',                                        // nesting too deep — use early returns
  '@typescript-eslint/no-explicit-any',               // type gap — use unknown + guard
  '@typescript-eslint/no-non-null-assertion',         // ! assertion — handle null explicitly
  '@typescript-eslint/explicit-function-return-type', // return type missing — declare it
]);

const ESLINT_WARNING = new Set([
  'no-magic-numbers',                                 // extract as named constant
  'max-lines-per-function',                           // too long — extract helpers
  'max-params',                                       // too many params — use config object
  'no-console',                                       // use Logger, not console.*
  '@typescript-eslint/prefer-nullish-coalescing',
  '@typescript-eslint/prefer-optional-chain',
]);

// ─── PHPStan (PHP) ────────────────────────────────────────────────────────────

const PHP_CRITICAL_PATTERNS = [
  /has no return type specified/i,
  /has no @param annotation/i,
  /Parameter .* has no type/i,
  /Call to undefined (method|function)/i,
  /Access to undefined property/i,
  /Argument .* expects .*, .* given/i,
];

const PHP_WARNING_PATTERNS = [
  /should return .* but returns/i,
  /Dead catch/i,
];

// ─── Ruff (Python) ────────────────────────────────────────────────────────────

const PY_CRITICAL = new Set([
  'C901', // function too complex (McCabe)
  'E711', // comparison to None with ==
  'E712', // comparison to True/False with ==
  'F401', // unused import
  'F841', // local variable assigned but never used
  'S101', // use of assert
  'S102', // use of exec
]);

const PY_WARNING = new Set([
  'ANN001', // missing type annotation for function argument
  'ANN201', // missing return type annotation
  'E501',   // line too long
  'W291',   // trailing whitespace
]);

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  ESLINT_CRITICAL,
  ESLINT_WARNING,
  PHP_CRITICAL_PATTERNS,
  PHP_WARNING_PATTERNS,
  PY_CRITICAL,
  PY_WARNING,
};
