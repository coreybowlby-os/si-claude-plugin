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
  const vcpDir = path.join(tmpDir, 'sicp');
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
    fs.writeFileSync(path.join(vcpDir, 'installed-sicp-version.txt'), version);
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
if (failed === 0) {
  process.stdout.write(`All ${passed} tests passed.\n\n`);
  process.exit(0);
} else {
  process.stdout.write(`${passed} passed, ${failed} failed.\n\n`);
  process.exit(1);
}
