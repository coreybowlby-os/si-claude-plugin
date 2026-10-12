/**
 * Tests for tests/lib/helpers/hermetic-env.js — the environment every suite
 * spawned by tests/run-all.js inherits.
 *
 * Run with: node tests/lib/hermetic-env.test.js
 */

'use strict';

const assert = require('assert');

const { buildHermeticEnv } = require('./helpers/hermetic-env');
const { test, banner, section, summary } = require('./helpers/mini-test-runner');

let passed = 0;
let failed = 0;

banner('hermetic-env');

section('host git hook leakage:');

if (test('strips git variables a host hook sets (GIT_DIR, GIT_WORK_TREE, ...)', () => {
  const env = buildHermeticEnv({
    GIT_DIR: '/host/.git',
    GIT_WORK_TREE: '/host',
    GIT_INDEX_FILE: '/host/.git/index',
    GIT_COMMON_DIR: '/host/.git',
    GIT_PREFIX: 'sub/',
    PATH: '/usr/bin',
  });
  assert.deepStrictEqual(env, { PATH: '/usr/bin' });
})) passed++; else failed++;

section('host agent session leakage:');

if (test('strips CLAUDE_PLUGIN_ROOT so hooks resolve to the repo under test', () => {
  const env = buildHermeticEnv({ CLAUDE_PLUGIN_ROOT: '/home/u/.claude/plugins/cache/other/1.0.0' });
  assert.strictEqual(env.CLAUDE_PLUGIN_ROOT, undefined);
})) passed++; else failed++;

if (test('strips every CLAUDE_* variable, including ones not read today', () => {
  const env = buildHermeticEnv({
    CLAUDE_PROJECT_DIR: '/host',
    CLAUDE_SESSION_ID: 'abc',
    CLAUDE_CONFIG_DIR: '/home/u/.claude',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_SOME_FUTURE_VAR: 'x',
  });
  assert.deepStrictEqual(Object.keys(env).filter(key => key.startsWith('CLAUDE_')), []);
})) passed++; else failed++;

if (test('strips user-level ECC hook and session knobs', () => {
  const env = buildHermeticEnv({
    ECC_HOOK_PROFILE: 'minimal',
    ECC_DISABLED_HOOKS: 'pre:bash:block-no-verify',
    ECC_DISABLED_MCPS: 'github',
    ECC_PLUGIN_ROOT: '/elsewhere',
    ECC_SESSION_ID: 'abc',
  });
  assert.deepStrictEqual(env, {});
})) passed++; else failed++;

section('intentional CI inputs:');

if (test('keeps CLAUDE_CODE_PACKAGE_MANAGER, the CI matrix package-manager lane', () => {
  const env = buildHermeticEnv({ CLAUDE_CODE_PACKAGE_MANAGER: 'pnpm' });
  assert.strictEqual(env.CLAUDE_CODE_PACKAGE_MANAGER, 'pnpm');
})) passed++; else failed++;

if (test('keeps ECC variables CI passes on purpose, such as ECC_RELEASE_PACKAGE', () => {
  const env = buildHermeticEnv({ ECC_RELEASE_PACKAGE: 'release-artifacts/x.tgz' });
  assert.strictEqual(env.ECC_RELEASE_PACKAGE, 'release-artifacts/x.tgz');
})) passed++; else failed++;

if (test('keeps ordinary process variables untouched', () => {
  const source = { PATH: '/usr/bin', HOME: '/home/u', NODE_OPTIONS: '--no-warnings' };
  assert.deepStrictEqual(buildHermeticEnv(source), source);
})) passed++; else failed++;

section('immutability:');

if (test('does not mutate the source environment', () => {
  const source = { CLAUDE_PLUGIN_ROOT: '/x', GIT_DIR: '/y', PATH: '/usr/bin' };
  const snapshot = { ...source };
  buildHermeticEnv(source);
  assert.deepStrictEqual(source, snapshot);
})) passed++; else failed++;

summary(passed, failed);
