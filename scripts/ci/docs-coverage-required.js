#!/usr/bin/env node
/**
 * Decide whether a pull request must update README.md, from its
 * conventional-commit title (the format this repo's commits use).
 *
 * Only a change that can add or alter user-facing capability needs README
 * coverage: `feat`, or any type marked breaking with `!`. Maintenance types
 * (fix, refactor, test, ci, chore, perf, docs, style, build, revert) do not.
 * Anything that is not a recognized conventional title fails closed and still
 * requires the README update.
 *
 * CLI: reads the title from the PR_TITLE environment variable (never from a
 * shell-interpolated argument, since titles are untrusted) and prints
 * "true" or "false".
 */

'use strict';

const NON_CAPABILITY_TYPES = new Set([
  'fix', 'refactor', 'test', 'ci', 'chore', 'perf', 'docs', 'style', 'build', 'revert',
]);

const CONVENTIONAL_TITLE = /^([a-z]+)(?:\([^)]*\))?(!)?: \S/;

function requiresDocsUpdate(title) {
  const match = String(title || '').trim().match(CONVENTIONAL_TITLE);
  if (!match) return true;
  const [, type, breaking] = match;
  if (breaking) return true;
  return !NON_CAPABILITY_TYPES.has(type);
}

if (require.main === module) {
  process.stdout.write(`${requiresDocsUpdate(process.env.PR_TITLE)}\n`);
}

module.exports = { requiresDocsUpdate };
