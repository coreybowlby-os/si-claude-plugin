'use strict';

/**
 * Tests for post-edit-standards hook and supporting lib modules.
 */

const assert = require('assert');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');

const { findProjectRoot, findBin } = require('../../scripts/lib/standards-handlers');
const {
  ESLINT_CRITICAL, ESLINT_WARNING,
  PHP_CRITICAL_PATTERNS,
  PY_CRITICAL, PY_WARNING,
} = require('../../scripts/lib/standards-rules');
const { run } = require('../../scripts/hooks/post-edit-standards');

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    process.stdout.write('  PASS ' + description + '\n');
    passed++;
  } catch (err) {
    process.stdout.write('  FAIL ' + description + '\n    ' + err.message + '\n');
    failed++;
  }
}

// --- findProjectRoot ---

test('findProjectRoot: walks up to marker file', function() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-standards-'));
  const sub = path.join(tmp, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
  try {
    assert.strictEqual(findProjectRoot(sub, ['package.json']), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('findProjectRoot: returns startDir when no marker found', function() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'si-standards-'));
  const sub = path.join(tmp, 'src');
  fs.mkdirSync(sub, { recursive: true });
  try {
    assert.strictEqual(findProjectRoot(sub, ['package.json']), sub);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// --- findBin ---

test('findBin: returns existing absolute path', function() {
  assert.strictEqual(findBin(process.execPath), process.execPath);
});

test('findBin: returns null for non-existent absolute path', function() {
  assert.strictEqual(findBin('/definitely/does/not/exist/bin'), null);
});

test('findBin: finds node on system PATH', function() {
  assert.ok(typeof findBin('node') === 'string');
});

// --- standards-rules ---

test('ESLINT_CRITICAL is a non-empty Set containing expected rules', function() {
  assert.ok(ESLINT_CRITICAL instanceof Set && ESLINT_CRITICAL.size > 0);
  assert.ok(ESLINT_CRITICAL.has('complexity'));
  assert.ok(ESLINT_CRITICAL.has('@typescript-eslint/no-explicit-any'));
});

test('ESLINT_WARNING contains expected rules', function() {
  assert.ok(ESLINT_WARNING instanceof Set && ESLINT_WARNING.size > 0);
  assert.ok(ESLINT_WARNING.has('no-magic-numbers'));
});

test('PHP_CRITICAL_PATTERNS is a non-empty RegExp array', function() {
  assert.ok(Array.isArray(PHP_CRITICAL_PATTERNS) && PHP_CRITICAL_PATTERNS.length > 0);
  assert.ok(PHP_CRITICAL_PATTERNS.every(function(p) { return p instanceof RegExp; }));
});

test('PY_CRITICAL contains C901 (McCabe complexity)', function() {
  assert.ok(PY_CRITICAL instanceof Set && PY_CRITICAL.has('C901'));
});

test('ESLINT_CRITICAL and ESLINT_WARNING are disjoint', function() {
  const overlap = [...ESLINT_CRITICAL].filter(function(r) { return ESLINT_WARNING.has(r); });
  assert.strictEqual(overlap.length, 0);
});

test('PY_CRITICAL and PY_WARNING are disjoint', function() {
  const overlap = [...PY_CRITICAL].filter(function(c) { return PY_WARNING.has(c); });
  assert.strictEqual(overlap.length, 0);
});

// --- run() routing ---

test('run(): passes through unhandled file extension (.yaml)', function() {
  const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/tmp/file.yaml' } });
  assert.strictEqual(run(input), input);
});

test('run(): passes through when no file_path in tool_input', function() {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(run(input), input);
});

test('run(): passes through for non-existent file', function() {
  const input = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/no/such/file.ts' } });
  assert.strictEqual(run(input), input);
});

test('run(): passes through invalid JSON', function() {
  assert.strictEqual(run('not json'), 'not json');
});

// --- Summary ---

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
