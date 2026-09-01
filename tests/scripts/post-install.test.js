/**
 * Tests for scripts/post-install.js
 *
 * The postinstall hook installs into ~/.claude. It must NOT do that when npm is
 * run inside a source checkout -- a contributor pulling devDependencies is not
 * asking for their global config to be rewritten.
 *
 * Every case runs against a throwaway copy of the script inside a temp dir with
 * a stub install-apply.js, and with HOME/USERPROFILE redirected, so the real
 * home directory is never touched.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REAL_SCRIPT = path.join(REPO_ROOT, 'scripts', 'post-install.js');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

/**
 * Build a fake installed package: real post-install.js plus a stub
 * install-apply.js that just records that it ran.
 */
function makePackage({ withGit }) {
  const pkgRoot = createTempDir('sicp-postinstall-');
  fs.mkdirSync(path.join(pkgRoot, 'scripts'), { recursive: true });
  fs.copyFileSync(REAL_SCRIPT, path.join(pkgRoot, 'scripts', 'post-install.js'));
  fs.writeFileSync(
    path.join(pkgRoot, 'scripts', 'install-apply.js'),
    "require('fs').writeFileSync(require('path').join(__dirname, '..', 'INSTALL_RAN'), 'yes');\n"
  );
  fs.writeFileSync(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: 'sicp', version: '9.9.9' }, null, 2)
  );
  if (withGit) fs.mkdirSync(path.join(pkgRoot, '.git'), { recursive: true });
  return pkgRoot;
}

function run(pkgRoot, { initCwd, homeDir, env = {} }) {
  const childEnv = {
    ...process.env,
    ...env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    INIT_CWD: initCwd,
  };
  try {
    const stdout = execFileSync('node', [path.join(pkgRoot, 'scripts', 'post-install.js')], {
      cwd: pkgRoot,
      env: childEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 20000,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status || 1, stdout: error.stdout || '' };
  }
}

const installRan = (pkgRoot) => fs.existsSync(path.join(pkgRoot, 'INSTALL_RAN'));

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing post-install.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('skips when a .git directory is present (source checkout)', () => {
    const pkgRoot = makePackage({ withGit: true });
    const homeDir = createTempDir('sicp-home-');
    try {
      const result = run(pkgRoot, { initCwd: os.tmpdir(), homeDir });
      assert.strictEqual(result.code, 0, 'should exit 0');
      assert.ok(/Source checkout detected/.test(result.stdout), 'should explain the skip');
      assert.ok(!installRan(pkgRoot), 'must NOT run install-apply');
      assert.ok(!fs.existsSync(path.join(homeDir, '.claude')), 'must not create ~/.claude');
    } finally {
      cleanup(pkgRoot);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('skips when INIT_CWD is the package itself (npm install in-repo)', () => {
    const pkgRoot = makePackage({ withGit: false });
    const homeDir = createTempDir('sicp-home-');
    try {
      const result = run(pkgRoot, { initCwd: pkgRoot, homeDir });
      assert.strictEqual(result.code, 0);
      assert.ok(/Source checkout detected/.test(result.stdout));
      assert.ok(!installRan(pkgRoot), 'must NOT run install-apply');
    } finally {
      cleanup(pkgRoot);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('runs for a consumer install (no .git, INIT_CWD elsewhere)', () => {
    const pkgRoot = makePackage({ withGit: false });
    const homeDir = createTempDir('sicp-home-');
    const consumer = createTempDir('sicp-consumer-');
    try {
      const result = run(pkgRoot, { initCwd: consumer, homeDir });
      assert.strictEqual(result.code, 0);
      assert.ok(installRan(pkgRoot), 'should run install-apply for a real consumer install');
      const tracker = path.join(homeDir, '.claude', 'sicp', 'installed-sicp-version.txt');
      assert.ok(fs.existsSync(tracker), 'should record the installed version');
      assert.strictEqual(fs.readFileSync(tracker, 'utf8').trim(), '9.9.9');
    } finally {
      cleanup(pkgRoot);
      cleanup(homeDir);
      cleanup(consumer);
    }
  })) passed++; else failed++;

  if (test('SICP_SKIP_POSTINSTALL=1 suppresses a consumer install', () => {
    const pkgRoot = makePackage({ withGit: false });
    const homeDir = createTempDir('sicp-home-');
    const consumer = createTempDir('sicp-consumer-');
    try {
      const result = run(pkgRoot, {
        initCwd: consumer, homeDir, env: { SICP_SKIP_POSTINSTALL: '1' },
      });
      assert.strictEqual(result.code, 0);
      assert.ok(/SICP_SKIP_POSTINSTALL set/.test(result.stdout));
      assert.ok(!installRan(pkgRoot), 'must NOT run install-apply');
    } finally {
      cleanup(pkgRoot);
      cleanup(homeDir);
      cleanup(consumer);
    }
  })) passed++; else failed++;

  if (test('SICP_FORCE_POSTINSTALL=1 overrides the source-checkout guard', () => {
    const pkgRoot = makePackage({ withGit: true });
    const homeDir = createTempDir('sicp-home-');
    try {
      const result = run(pkgRoot, {
        initCwd: pkgRoot, homeDir, env: { SICP_FORCE_POSTINSTALL: '1' },
      });
      assert.strictEqual(result.code, 0);
      assert.ok(installRan(pkgRoot), 'force flag should run install-apply anyway');
    } finally {
      cleanup(pkgRoot);
      cleanup(homeDir);
    }
  })) passed++; else failed++;

  if (test('skips a repeat install of the same version', () => {
    const pkgRoot = makePackage({ withGit: false });
    const homeDir = createTempDir('sicp-home-');
    const consumer = createTempDir('sicp-consumer-');
    try {
      const trackerDir = path.join(homeDir, '.claude', 'sicp');
      fs.mkdirSync(trackerDir, { recursive: true });
      fs.writeFileSync(path.join(trackerDir, 'installed-sicp-version.txt'), '9.9.9');
      const result = run(pkgRoot, { initCwd: consumer, homeDir });
      assert.strictEqual(result.code, 0);
      assert.ok(/already installed/.test(result.stdout));
      assert.ok(!installRan(pkgRoot), 'must NOT reinstall the same version');
    } finally {
      cleanup(pkgRoot);
      cleanup(homeDir);
      cleanup(consumer);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
