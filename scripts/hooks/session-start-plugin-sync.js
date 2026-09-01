#!/usr/bin/env node
/**
 * session-start-plugin-sync.js
 *
 * Installs or reinstalls SICP plugin artifacts when a newer version is available.
 *
 * Three trigger conditions:
 *   1. Claude Code upgrade  — installed_plugins.json has a HIGHER semver than lastDeployed
 *   2. Marketplace upgrade  — marketplace clone (pulled fresh) has a HIGHER semver than lastDeployed
 *   3. Fresh install        — no version was ever tracked AND no rules are installed
 *
 * For condition 2 (marketplace upgrade), this script pulls the marketplace git clone
 * directly rather than waiting for Claude Code to discover the new version through its
 * own update schedule. This makes auto-update work on every session start.
 *
 * Cooldown: marketplace pull runs at most once every 6 hours to keep session startup fast.
 *
 * Version comparison uses semver ordering (>, not !=) so a stale installed_plugins.json
 * never causes a downgrade after a marketplace-sourced upgrade.
 *
 * Version tracker: ~/.claude/SI-Claude-Plugin/installed-version.txt
 * Cooldown tracker: ~/.claude/SI-Claude-Plugin/last-marketplace-check.txt
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const homeDir = os.homedir();
const claudeDir = path.join(homeDir, '.claude');
const installedPluginsPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
// The slug is the Claude Code PLUGIN name — as in .claude-plugin/plugin.json and the
// directory Claude Code creates at ~/.claude/plugins/marketplaces/<slug>. It is not the
// npm package name. It also names this plugin's private state directory under ~/.claude/.
const PLUGIN_SLUG = 'SI-Claude-Plugin';
const STATE_DIR = PLUGIN_SLUG;

const versionTrackerPath = path.join(claudeDir, STATE_DIR, 'installed-version.txt');
const marketplaceCheckPath = path.join(claudeDir, STATE_DIR, 'last-marketplace-check.txt');
const rulesCorePath = path.join(claudeDir, 'rules', 'common');
const MARKETPLACE_CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

function parseSemver(v) {
  const parts = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!parts) return null;
  return [Number(parts[1]), Number(parts[2]), Number(parts[3])];
}

/**
 * Returns true when semver string `a` is strictly greater than `b`.
 * Non-parseable versions return false (safe: avoid false positives).
 */
function semverGreater(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  if (pa[0] !== pb[0]) return pa[0] > pb[0];
  if (pa[1] !== pb[1]) return pa[1] > pb[1];
  return pa[2] > pb[2];
}

// ---------------------------------------------------------------------------
// Marketplace helpers
// ---------------------------------------------------------------------------

function resolveMarketplacePath() {
  const candidate = path.join(claudeDir, 'plugins', 'marketplaces', PLUGIN_SLUG);
  return fs.existsSync(path.join(candidate, 'scripts', 'install-apply.js')) ? candidate : null;
}

function shouldCheckMarketplace() {
  try {
    const ts = parseInt(fs.readFileSync(marketplaceCheckPath, 'utf8').trim(), 10);
    return Number.isFinite(ts) ? Date.now() - ts > MARKETPLACE_CHECK_COOLDOWN_MS : true;
  } catch (_) {
    return true;
  }
}

function writeMarketplaceCheckTimestamp() {
  try {
    fs.mkdirSync(path.dirname(marketplaceCheckPath), { recursive: true });
    fs.writeFileSync(marketplaceCheckPath, String(Date.now()), 'utf8');
  } catch (_) { /* intentional noop */ }
}

function pullMarketplace(marketplacePath) {
  const result = spawnSync('git', ['pull', '--ff-only', '--quiet'], {
    encoding: 'utf8',
    cwd: marketplacePath,
    timeout: 15000,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    process.stderr.write(
      `[plugin-sync] WARNING: marketplace pull failed (${result.error ? result.error.message : `exit ${result.status}`}) -- will retry next session\n`
    );
    return false;
  }
  return true;
}

function getVersionFromDir(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin cache resolver
// ---------------------------------------------------------------------------

function resolvePluginRoot() {
  const envRoot = (process.env.CLAUDE_PLUGIN_ROOT || '').trim();
  if (envRoot && fs.existsSync(path.join(envRoot, 'scripts', 'install-apply.js'))) {
    return envRoot;
  }

  const rels = [
    PLUGIN_SLUG,
    `${PLUGIN_SLUG}@${PLUGIN_SLUG}`,
    path.join('marketplaces', PLUGIN_SLUG),
  ];
  for (const rel of rels) {
    const candidate = path.join(claudeDir, 'plugins', rel);
    if (fs.existsSync(path.join(candidate, 'scripts', 'install-apply.js'))) {
      return candidate;
    }
  }

  try {
    {
      const cacheBase = path.join(claudeDir, 'plugins', 'cache', PLUGIN_SLUG);
      for (const org of fs.readdirSync(cacheBase, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        for (const ver of fs.readdirSync(path.join(cacheBase, org.name), { withFileTypes: true })) {
          if (!ver.isDirectory()) continue;
          const candidate = path.join(cacheBase, org.name, ver.name);
          if (fs.existsSync(path.join(candidate, 'scripts', 'install-apply.js'))) {
            return candidate;
          }
        }
      }
    }
  } catch (_) { /* intentional noop */ }

  return null;
}

// ---------------------------------------------------------------------------
// Version readers / writers
// ---------------------------------------------------------------------------

let stdinData = '';
try { stdinData = fs.readFileSync(0, 'utf8'); } catch (_) { /* intentional noop */ }

function passThrough() {
  if (stdinData) process.stdout.write(stdinData);
}

function getInstalledVersion() {
  try {
    const data = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf8'));
    const plugins = data.plugins || {};
    for (const key of Object.keys(plugins)) {
      if (key.startsWith(PLUGIN_SLUG)) {
        const entries = plugins[key];
        const ver = entries && entries[0] && entries[0].version;
        if (ver) return ver;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

function getLastDeployedVersion() {
  try { return fs.readFileSync(versionTrackerPath, 'utf8').trim() || null; } catch (_) { return null; }
}

function writeTrackerVersion(version) {
  try {
    fs.mkdirSync(path.dirname(versionTrackerPath), { recursive: true });
    fs.writeFileSync(versionTrackerPath, version, 'utf8');
  } catch (e) {
    process.stderr.write(`[plugin-sync] WARNING: could not write version tracker: ${e.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

const currentVersion = getInstalledVersion();  // from installed_plugins.json (Claude Code's record)
const lastDeployed = getLastDeployedVersion();  // from our tracker (what we actually installed)
const rulesInstalled = fs.existsSync(rulesCorePath);

// Check marketplace for a newer version (respects cooldown).
let marketplaceVersion = null;
let marketplacePath = null;

const marketplaceClonePath = resolveMarketplacePath();
if (marketplaceClonePath && shouldCheckMarketplace()) {
  writeMarketplaceCheckTimestamp();
  pullMarketplace(marketplaceClonePath);
  marketplaceVersion = getVersionFromDir(marketplaceClonePath);
  if (marketplaceVersion) {
    marketplacePath = marketplaceClonePath;
  }
}

// Trigger conditions (all use semver > to prevent stale-cache downgrades):
//   1. Claude Code upgraded the cache (installed_plugins.json has HIGHER version than tracker)
const cacheUpgrade = semverGreater(currentVersion, lastDeployed);
//   2. Marketplace clone (freshly pulled) has HIGHER version than tracker
const marketplaceUpgrade = semverGreater(marketplaceVersion, lastDeployed);
//   3. Fresh install: no tracker file and no rules on disk
const freshInstall = lastDeployed === null && !rulesInstalled;

const needsSetup = cacheUpgrade || marketplaceUpgrade || freshInstall;

if (!needsSetup) {
  passThrough();
  process.exit(0);
}

// Choose source: marketplace clone for marketplace upgrades; cached plugin for cache upgrades/fresh.
const pluginRoot = (marketplaceUpgrade && marketplacePath) ? marketplacePath : resolvePluginRoot();
const installScript = pluginRoot ? path.join(pluginRoot, 'scripts', 'install-apply.js') : null;

if (!installScript || !fs.existsSync(installScript)) {
  process.stderr.write(
    '[plugin-sync] WARNING: could not locate install-apply.js -- ' +
    'set CLAUDE_PLUGIN_ROOT or run: npx si-claude-plugin\n'
  );
  passThrough();
  process.exit(0);
}

const newVersion = marketplaceUpgrade
  ? (marketplaceVersion || 'installed')
  : (currentVersion || 'installed');

const label = lastDeployed
  ? `updated (${lastDeployed} -> ${newVersion})`
  : `first install (${newVersion})`;
const source = (marketplaceUpgrade && marketplacePath) ? 'marketplace' : 'cache';
process.stderr.write(`[plugin-sync] SI-Claude-Plugin ${label} [source: ${source}] -- running core setup...\n`);

const nodeModulesPath = path.join(pluginRoot, 'node_modules');
if (!fs.existsSync(nodeModulesPath)) {
  process.stderr.write('[plugin-sync] node_modules missing -- running npm install...\n');
  const npmInstall = spawnSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], {
    encoding: 'utf8',
    env: process.env,
    cwd: pluginRoot,
    timeout: 120000,
    shell: true,
  });
  if (npmInstall.error || npmInstall.status !== 0) {
    const reason = npmInstall.error ? npmInstall.error.message : `exit ${npmInstall.status}`;
    process.stderr.write(`[plugin-sync] ERROR: npm install failed (${reason}) -- run: npx si-claude-plugin\n`);
    if (npmInstall.stderr) process.stderr.write(npmInstall.stderr);
    passThrough();
    process.exit(0);
  }
  process.stderr.write('[plugin-sync] npm install complete.\n');
}

const result = spawnSync(
  process.execPath,
  ['scripts/install-apply.js', '--target', 'claude', '--profile', 'core'],
  { encoding: 'utf8', env: process.env, cwd: pluginRoot, timeout: 120000 }
);

if (result.error || result.status !== 0) {
  const reason = result.error ? result.error.message : `exit ${result.status}`;
  process.stderr.write(`[plugin-sync] ERROR: setup failed (${reason}) -- run: npx si-claude-plugin\n`);
  if (result.stderr) process.stderr.write(result.stderr);
} else {
  writeTrackerVersion(newVersion);
  process.stderr.write(
    `[plugin-sync] SICP core setup complete (v${newVersion}).\n`
  );
}

passThrough();
process.exit(0);
