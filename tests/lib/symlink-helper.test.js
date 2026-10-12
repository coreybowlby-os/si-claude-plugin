/**
 * Tests for tests/lib/helpers/symlink.js — capability-gated symlink creation
 * for suites that exercise symlink defences.
 *
 * Run with: node tests/lib/symlink-helper.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { trySymlink } = require('./helpers/symlink');
const { test, banner, section, summary } = require('./helpers/mini-test-runner');

let passed = 0;
let failed = 0;

function fakeFs(code) {
  const calls = [];
  return {
    calls,
    symlinkSync(...args) {
      calls.push(args);
      if (code) throw Object.assign(new Error(`${code}: simulated`), { code });
    },
  };
}

banner('symlink helper');

section('unprivileged hosts:');

for (const code of ['EPERM', 'EACCES']) {
  if (test(`returns false instead of throwing on ${code}`, () => {
    assert.strictEqual(trySymlink('/target', '/link', 'file', fakeFs(code)), false);
  })) passed++; else failed++;
}

if (test('rethrows any other error so real failures are not masked', () => {
  assert.throws(() => trySymlink('/target', '/link', 'file', fakeFs('ENOENT')), /ENOENT/);
})) passed++; else failed++;

section('link type:');

if (test('uses a junction for directories on Windows (needs no privilege)', () => {
  const fake = fakeFs();
  trySymlink('/target', '/link', 'dir', fake, 'win32');
  assert.deepStrictEqual(fake.calls, [['/target', '/link', 'junction']]);
})) passed++; else failed++;

if (test('uses a plain dir symlink for directories elsewhere', () => {
  const fake = fakeFs();
  trySymlink('/target', '/link', 'dir', fake, 'linux');
  assert.deepStrictEqual(fake.calls, [['/target', '/link', 'dir']]);
})) passed++; else failed++;

if (test('passes file links through unchanged', () => {
  const fake = fakeFs();
  assert.strictEqual(trySymlink('/target', '/link', 'file', fake, 'win32'), true);
  assert.deepStrictEqual(fake.calls, [['/target', '/link', 'file']]);
})) passed++; else failed++;

section('real filesystem:');

if (test('creates a working directory link on this host', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-symlink-helper-'));
  try {
    const target = path.join(root, 'target');
    const link = path.join(root, 'link');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'probe.txt'), 'ok');
    assert.strictEqual(trySymlink(target, link, 'dir'), true);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.strictEqual(fs.readFileSync(path.join(link, 'probe.txt'), 'utf8'), 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})) passed++; else failed++;

summary(passed, failed);
