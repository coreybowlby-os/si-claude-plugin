/**
 * Tests for session-start-plugin-sync.js
 *
 * Run with: node tests/hooks/session-start-plugin-sync.test.js
 *
 * Covers:
 *   - Fast path (already up to date — no install triggered)
 *   - Cache upgrade detection (installed_plugins.json has higher semver)
 *   - Semver ordering prevents stale-cache downgrades after marketplace deploy
 *   - Fresh install when no tracker and no rules exist
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-start-plugin-sync.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    failed++;
  }
}

/**
 * Creates an isolated temp directory that mimics ~/.claude for a test run.
 */
function makeTempClaude() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-test-'));
  const pluginsDir = path.join(tmpDir, 'plugins');
  const vcpDir = path.join(tmpDir, 'SI-Claude-Plugin');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(vcpDir, { recursive: true });

  function writeInstalledPlugins(version) {
    fs.writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'SI-Claude-Plugin@SI-Claude-Plugin': [{ scope: 'user', version }] }
      })
    );
  }

  function writeTracker(version) {
    fs.writeFileSync(path.join(vcpDir, 'installed-version.txt'), version);
  }

  function writeMarketplaceCheck(ageMs) {
    const ts = ageMs === 'fresh' ? String(Date.now()) : String(Date.now() - ageMs);
    fs.writeFileSync(path.join(vcpDir, 'last-marketplace-check.txt'), ts);
  }

  function run(env = {}) {
    return spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      input: '{"test":true}',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: tmpDir,
        USERPROFILE: tmpDir,
        CLAUDE_PLUGIN_ROOT: '',
        ...env,
      },
    });
  }

  function cleanup() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* intentional noop */ }
  }

  return { tmpDir, writeInstalledPlugins, writeTracker, writeMarketplaceCheck, run, cleanup };
}

// ---------------------------------------------------------------------------

process.stdout.write('\nsession-start-plugin-sync.js\n');
process.stdout.write('=============================\n\n');

process.stdout.write('Fast path:\n');

test('passes stdin through and exits 0 when versions already match', () => {
  const { writeInstalledPlugins, writeTracker, writeMarketplaceCheck, run, cleanup } = makeTempClaude();
  try {
    writeInstalledPlugins('1.13.0');
    writeTracker('1.13.0');
    writeMarketplaceCheck('fresh'); // cooldown active — no pull

    const result = run();
    assert.strictEqual(result.status, 0, `exit ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('"test":true'), 'should pass stdin through');
    assert.ok(!result.stderr.includes('setup'), 'should not run setup');
  } finally {
    cleanup();
  }
});

test('passes stdin through when no installed_plugins.json but tracker exists', () => {
  const { writeTracker, writeMarketplaceCheck, run, cleanup } = makeTempClaude();
  try {
    writeTracker('1.13.0');
    writeMarketplaceCheck('fresh');

    const result = run();
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('"test":true'));
  } finally {
    cleanup();
  }
});

process.stdout.write('\nCache upgrade detection:\n');

test('detects upgrade when installed_plugins.json has higher semver than tracker', () => {
  const { writeInstalledPlugins, writeTracker, writeMarketplaceCheck, run, cleanup } = makeTempClaude();
  try {
    writeInstalledPlugins('1.14.0');
    writeTracker('1.13.0');
    writeMarketplaceCheck('fresh');

    const result = run();
    assert.strictEqual(result.status, 0);
    assert.ok(
      result.stderr.includes('WARNING: could not locate install-apply.js'),
      `expected upgrade attempt — script passed fast-path check and tried to install\nactual: ${result.stderr}`
    );
  } finally {
    cleanup();
  }
});

test('does NOT downgrade when installed_plugins.json is older than tracker (stale cache after marketplace deploy)', () => {
  const { writeInstalledPlugins, writeTracker, writeMarketplaceCheck, run, cleanup } = makeTempClaude();
  try {
    writeInstalledPlugins('1.13.0'); // stale — Claude Code hasn't updated it
    writeTracker('1.14.0');          // we already deployed 1.14.0 from marketplace
    writeMarketplaceCheck('fresh');  // no pull needed

    const result = run();
    assert.strictEqual(result.status, 0);
    assert.ok(!result.stderr.includes('setup'), `must NOT run setup (would downgrade)\nstderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('"test":true'), 'should pass stdin through');
  } finally {
    cleanup();
  }
});

process.stdout.write('\nFresh install:\n');

test('triggers install when no tracker and no rules directory', () => {
  const { writeInstalledPlugins, writeMarketplaceCheck, run, cleanup } = makeTempClaude();
  try {
    writeInstalledPlugins('1.14.0');
    writeMarketplaceCheck('fresh');
    // No tracker, no rules/common

    const result = run();
    assert.strictEqual(result.status, 0);
    assert.ok(
      result.stderr.includes('first install') || result.stderr.includes('WARNING'),
      `expected install attempt\nstderr: ${result.stderr}`
    );
  } finally {
    cleanup();
  }
});

process.stdout.write('\nMarketplace cooldown:\n');

test('skips pull when cooldown has not elapsed', () => {
  const { writeInstalledPlugins, writeTracker, writeMarketplaceCheck, run, cleanup } = makeTempClaude();
  try {
    writeInstalledPlugins('1.13.0');
    writeTracker('1.13.0');
    writeMarketplaceCheck('fresh');

    const result = run();
    assert.strictEqual(result.status, 0);
    assert.ok(!result.stderr.includes('marketplace pull'), `should not attempt pull\nstderr: ${result.stderr}`);
  } finally {
    cleanup();
  }
});

test('attempts pull when cooldown has elapsed (7 hours)', () => {
  const { writeInstalledPlugins, writeTracker, writeMarketplaceCheck, run, cleanup } = makeTempClaude();
  try {
    writeInstalledPlugins('1.13.0');
    writeTracker('1.13.0');
    writeMarketplaceCheck(7 * 60 * 60 * 1000); // 7h ago — past 6h cooldown

    const result = run();
    // Pull will fail (no marketplace clone at tmpDir) — script logs warning and continues
    assert.strictEqual(result.status, 0, `should not crash\nstderr: ${result.stderr}`);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------

process.stdout.write('\n');

// ---------------------------------------------------------------------------
// Regression: Claude Code stores marketplace clones under plugins/marketplaces/
// (PLURAL). resolvePluginRoot() previously searched only the singular
// 'marketplace', so a marketplace-installed plugin was never found and the hook
// aborted with "could not locate install-apply.js" while silently doing nothing.
//
// NOTE: these build the fixture at <home>/.claude/... because that is what the
// hook reads. makeTempClaude() above builds it at <home>/... (one level high),
// which is why the tests using it never exercise real path resolution.
// ---------------------------------------------------------------------------

process.stdout.write('Marketplace resolution:' + String.fromCharCode(10));

function makeMarketplaceFixture(marketplaceDirName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sicp-mkt-'));
  const base = path.join(tmp, '.claude');
  fs.mkdirSync(path.join(base, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(base, 'SI-Claude-Plugin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'SI-Claude-Plugin@SI-Claude-Plugin': [{ scope: 'user', version: '1.0.0' }] } }));
  fs.writeFileSync(path.join(base, 'SI-Claude-Plugin', 'last-marketplace-check.txt'), String(Date.now()));
  const mk = path.join(base, 'plugins', marketplaceDirName, 'SI-Claude-Plugin');
  fs.mkdirSync(path.join(mk, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(mk, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(mk, 'scripts', 'install-apply.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(mk, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  return {
    tmp,
    run: () => spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8', input: '{"t":1}',
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDE_PLUGIN_ROOT: '' },
    }),
    cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ } },
  };
}

test('resolves a plugin under plugins/marketplaces/<slug>', () => {
  const { run, cleanup } = makeMarketplaceFixture('marketplaces');
  try {
    const result = run();
    assert.ok(!result.stderr.includes('could not locate install-apply.js'),
      'plural marketplaces layout must resolve; stderr: ' + result.stderr);
    assert.ok(result.stderr.includes('core setup'),
      'should proceed to core setup; stderr: ' + result.stderr);
  } finally { cleanup(); }
});


// ---------------------------------------------------------------------------
// This hook pulls code and then executes it, unattended, at session start.
// It must refuse to pull from any remote other than the plugin's own repo.
// ---------------------------------------------------------------------------

process.stdout.write('Remote trust gate:' + String.fromCharCode(10));

function makeClonedFixture(remoteUrl) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sicp-trust-'));
  const base = path.join(tmp, '.claude');
  fs.mkdirSync(path.join(base, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(base, 'SI-Claude-Plugin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'SI-Claude-Plugin@SI-Claude-Plugin': [{ scope: 'user', version: '1.0.0' }] } }));
  const mk = path.join(base, 'plugins', 'marketplaces', 'SI-Claude-Plugin');
  fs.mkdirSync(path.join(mk, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(mk, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(mk, 'scripts', 'install-apply.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(mk, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: mk });
  spawnSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: mk });
  // No cooldown file -> a marketplace check (and therefore a pull) is attempted.
  return {
    run: () => spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8', input: '{"t":1}',
      env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDE_PLUGIN_ROOT: '' },
    }),
    cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* noop */ } },
  };
}

test('refuses to pull when the marketplace remote is not the plugin repo', () => {
  const { run, cleanup } = makeClonedFixture('https://github.com/attacker/evil-plugin.git');
  try {
    const result = run();
    assert.ok(result.stderr.includes('refusing to pull'),
      'must refuse an untrusted remote; stderr: ' + result.stderr);
  } finally { cleanup(); }
});

test('does not refuse when the remote is the plugin repo', () => {
  const { run, cleanup } = makeClonedFixture('https://github.com/coreybowlby-os/si-claude-plugin.git');
  try {
    const result = run();
    assert.ok(!result.stderr.includes('refusing to pull'),
      'trusted remote must not be refused; stderr: ' + result.stderr);
  } finally { cleanup(); }
});

test('accepts the ssh form of the trusted remote', () => {
  const { run, cleanup } = makeClonedFixture('git@github.com:coreybowlby-os/si-claude-plugin.git');
  try {
    const result = run();
    assert.ok(!result.stderr.includes('refusing to pull'),
      'ssh form of the trusted remote must be accepted; stderr: ' + result.stderr);
  } finally { cleanup(); }
});

if (failed === 0) {
  process.stdout.write(`All ${passed} tests passed.\n\n`);
  process.exit(0);
} else {
  process.stdout.write(`${passed} passed, ${failed} failed.\n\n`);
  process.exit(1);
}
