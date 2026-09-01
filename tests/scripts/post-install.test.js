/**
 * Tests for scripts/post-install.js
 *
 * The postinstall hook installs into ~/.claude. It must only do that for a real
 * npm package install. The gate is a positive signal: npm - local or global -
 * always unpacks a package into a node_modules directory. A git checkout, an
 * extracted ZIP, or a copied tree is not a consumer install.
 *
 * Every case runs against a throwaway copy of the script with a stub
 * install-apply.js and redirected HOME/USERPROFILE, so the real home directory
 * is never touched.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'post-install.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write('  ✓ ' + name + '\n');
    passed++;
  } catch (error) {
    process.stdout.write('  ✗ ' + name + '\n    ' + error.message + '\n');
    failed++;
  }
}

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_) { /* intentional noop */ }
}

/**
 * Build a fake package. `insideNodeModules` decides whether it looks like
 * something npm installed or like a source tree someone downloaded.
 */
function makePackage(options) {
  const opts = options || {};
  const insideNodeModules = opts.insideNodeModules !== false;
  const tmp = createTempDir('sicp-postinstall-');
  const pkgRoot = insideNodeModules
    ? path.join(tmp, 'node_modules', 'si-claude-plugin')
    : path.join(tmp, 'si-claude-plugin');
  fs.mkdirSync(path.join(pkgRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(pkgRoot, 'scripts', 'post-install.js'));
  fs.writeFileSync(
    path.join(pkgRoot, 'scripts', 'install-apply.js'),
    "require('fs').writeFileSync(require('path').join(__dirname, '..', 'INSTALL_RAN'), 'yes');\n"
  );
  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: 'si-claude-plugin', version: '9.9.9' }, null, 2)
  );
  if (opts.withGit) fs.mkdirSync(path.join(pkgRoot, '.git'), { recursive: true });
  return { tmp, pkgRoot };
}

function run(pkgRoot, options) {
  const opts = options || {};
  const childEnv = Object.assign({}, process.env, opts.env || {}, {
    HOME: opts.homeDir,
    USERPROFILE: opts.homeDir,
  });
  if (opts.initCwd === undefined) delete childEnv.INIT_CWD;
  else childEnv.INIT_CWD = opts.initCwd;
  try {
    const stdout = execFileSync('node', [path.join(pkgRoot, 'scripts', 'post-install.js')], {
      cwd: pkgRoot,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
    });
    return { code: 0, stdout: stdout };
  } catch (error) {
    return { code: error.status || 1, stdout: error.stdout || '' };
  }
}

function installRan(pkgRoot) {
  return fs.existsSync(path.join(pkgRoot, 'INSTALL_RAN'));
}

process.stdout.write('\n=== Testing post-install.js ===\n\n');

// --- Must NOT touch the user's home ----------------------------------------

test('skips an extracted source tree (not under node_modules)', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: false });
  const homeDir = createTempDir('sicp-home-');
  try {
    const result = run(pkgRoot, { initCwd: tmp, homeDir: homeDir });
    assert.strictEqual(result.code, 0);
    assert.ok(/Not an npm package install/.test(result.stdout), 'should explain the skip');
    assert.ok(!installRan(pkgRoot), 'must NOT run install-apply');
    assert.ok(!fs.existsSync(path.join(homeDir, '.claude')), 'must not create ~/.claude');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
  }
});

test('skips an extracted source tree when INIT_CWD is unset', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: false });
  const homeDir = createTempDir('sicp-home-');
  try {
    run(pkgRoot, { initCwd: undefined, homeDir: homeDir });
    assert.ok(!installRan(pkgRoot), 'must NOT run install-apply');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
  }
});

test('skips a git checkout even when placed under node_modules', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: true, withGit: true });
  const homeDir = createTempDir('sicp-home-');
  try {
    run(pkgRoot, { initCwd: tmp, homeDir: homeDir });
    assert.ok(!installRan(pkgRoot), 'a .git directory means a working tree, not a package');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
  }
});

// --- Must still work for real installs --------------------------------------

test('runs for a consumer install under node_modules', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: true });
  const homeDir = createTempDir('sicp-home-');
  const consumer = createTempDir('sicp-consumer-');
  try {
    const result = run(pkgRoot, { initCwd: consumer, homeDir: homeDir });
    assert.strictEqual(result.code, 0);
    assert.ok(installRan(pkgRoot), 'should run install-apply');
    const tracker = path.join(homeDir, '.claude', 'SI-Claude-Plugin', 'installed-version.txt');
    assert.ok(fs.existsSync(tracker), 'should record the installed version');
    assert.strictEqual(fs.readFileSync(tracker, 'utf8').trim(), '9.9.9');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
    cleanup(consumer);
  }
});

test('runs for a global install (node_modules, no INIT_CWD)', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: true });
  const homeDir = createTempDir('sicp-home-');
  try {
    run(pkgRoot, { initCwd: undefined, homeDir: homeDir });
    assert.ok(installRan(pkgRoot), 'a global install has no INIT_CWD and must still apply');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
  }
});

test('skips a repeat install of the same version', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: true });
  const homeDir = createTempDir('sicp-home-');
  const consumer = createTempDir('sicp-consumer-');
  try {
    const trackerDir = path.join(homeDir, '.claude', 'SI-Claude-Plugin');
    fs.mkdirSync(trackerDir, { recursive: true });
    fs.writeFileSync(path.join(trackerDir, 'installed-version.txt'), '9.9.9');
    const result = run(pkgRoot, { initCwd: consumer, homeDir: homeDir });
    assert.ok(/already installed/.test(result.stdout));
    assert.ok(!installRan(pkgRoot), 'must NOT reinstall the same version');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
    cleanup(consumer);
  }
});

// --- Env overrides -----------------------------------------------------------

test('SICP_SKIP_POSTINSTALL suppresses a real install', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: true });
  const homeDir = createTempDir('sicp-home-');
  const consumer = createTempDir('sicp-consumer-');
  try {
    const result = run(pkgRoot, {
      initCwd: consumer, homeDir: homeDir, env: { SICP_SKIP_POSTINSTALL: '1' },
    });
    assert.ok(/SICP_SKIP_POSTINSTALL set/.test(result.stdout));
    assert.ok(!installRan(pkgRoot), 'must NOT run install-apply');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
    cleanup(consumer);
  }
});

test('SICP_SKIP_POSTINSTALL beats SICP_FORCE_POSTINSTALL', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: true });
  const homeDir = createTempDir('sicp-home-');
  const consumer = createTempDir('sicp-consumer-');
  try {
    const result = run(pkgRoot, {
      initCwd: consumer,
      homeDir: homeDir,
      env: { SICP_SKIP_POSTINSTALL: '1', SICP_FORCE_POSTINSTALL: '1' },
    });
    assert.ok(/SICP_SKIP_POSTINSTALL set/.test(result.stdout), 'the safety opt-out must win');
    assert.ok(!installRan(pkgRoot), 'must NOT run install-apply');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
    cleanup(consumer);
  }
});

test('SICP_FORCE_POSTINSTALL applies from a source tree', () => {
  const { tmp, pkgRoot } = makePackage({ insideNodeModules: false, withGit: true });
  const homeDir = createTempDir('sicp-home-');
  try {
    run(pkgRoot, { initCwd: tmp, homeDir: homeDir, env: { SICP_FORCE_POSTINSTALL: '1' } });
    assert.ok(installRan(pkgRoot), 'force flag should apply anyway');
  } finally {
    cleanup(tmp);
    cleanup(homeDir);
  }
});

process.stdout.write('\nResults: Passed: ' + passed + ', Failed: ' + failed + '\n');
process.exit(failed > 0 ? 1 : 0);
