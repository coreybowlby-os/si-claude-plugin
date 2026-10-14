/**
 * Tests for scripts/ci/docs-coverage-required.js — decides whether a PR must
 * update README.md, from its conventional-commit title.
 *
 * Run with: node tests/ci/docs-coverage-required.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const { requiresDocsUpdate } = require('../../scripts/ci/docs-coverage-required');
const { test, banner, section, summary } = require('../lib/helpers/mini-test-runner');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'ci', 'docs-coverage-required.js');

let passed = 0;
let failed = 0;

banner('docs-coverage-required');

section('titles that can add user-facing capability:');

for (const title of [
  'feat: add kimi install target',
  'feat(hooks): new gate',
  'fix!: drop node 16 support',
  'refactor(api)!: rename the public CLI',
]) {
  if (test(`requires a README update for "${title}"`, () => {
    assert.strictEqual(requiresDocsUpdate(title), true);
  })) passed++; else failed++;
}

section('titles that cannot:');

for (const title of [
  'fix: satisfy ESLint 10 recommended rules and bump @eslint/js to 10',
  'refactor: make yarn.lock the only lockfile',
  'test: align README guards with the rebranded README',
  'ci(deps): pin actions',
  'chore(deps): bump js-yaml from 4.3.2 to 5.4.3',
  'perf: cache the catalog scan',
  'docs: fix a typo',
  'style: reformat',
  'build: bump node',
  'revert: undo the rename',
]) {
  if (test(`does not require a README update for "${title}"`, () => {
    assert.strictEqual(requiresDocsUpdate(title), false);
  })) passed++; else failed++;
}

section('fail closed:');

for (const title of ['', '   ', 'Add a new feature', 'Update README', 'feature: lookalike type', 'fixes: not a known type']) {
  if (test(`requires a README update for non-conventional title ${JSON.stringify(title)}`, () => {
    assert.strictEqual(requiresDocsUpdate(title), true);
  })) passed++; else failed++;
}

if (test('treats a missing title as requiring a README update', () => {
  assert.strictEqual(requiresDocsUpdate(undefined), true);
})) passed++; else failed++;

section('CLI (as the workflow calls it):');

if (test('reads the title from PR_TITLE and prints the decision', () => {
  const run = title => spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PR_TITLE: title },
  });
  assert.strictEqual(run('fix: x').stdout.trim(), 'false');
  assert.strictEqual(run('feat: x').stdout.trim(), 'true');
})) passed++; else failed++;

if (test('passes hostile titles through as data, never as shell', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PR_TITLE: 'fix: $(touch /tmp/pwned) `id` "; exit 1' },
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout.trim(), 'false');
})) passed++; else failed++;

summary(passed, failed);
