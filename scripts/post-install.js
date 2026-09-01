#!/usr/bin/env node
'use strict';
// Runs automatically after `npm install si-claude-plugin` or `npm install -g si-claude-plugin`.
// Applies the core profile so hooks, rules, and agents land in ~/.claude/.
// Skips if this exact version was already applied (idempotent).
//
// It deliberately does NOT run when npm is invoked inside a source checkout of
// this repo -- a contributor running `npm install` to pull down devDependencies
// is not asking for their global ~/.claude to be rewritten. Consumer installs
// (as a dependency, or -g) are unaffected and still auto-apply.
//
// Env overrides:
//   SICP_SKIP_POSTINSTALL=1   never auto-apply
//   SICP_FORCE_POSTINSTALL=1  auto-apply even from a source checkout

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const INSTALL_SCRIPT = path.join(PACKAGE_ROOT, 'scripts', 'install-apply.js');

const isTruthy = (value) => /^(1|true|yes)$/i.test(String(value || '').trim());

// A published npm tarball never contains .git, so its presence means we are
// sitting in a working tree rather than an installed package.
const isSourceCheckout = fs.existsSync(path.join(PACKAGE_ROOT, '.git'));

// npm sets INIT_CWD to the directory npm was launched from. When that is the
// package itself, this is `npm install` run inside the repo.
let isSelfInstall = false;
if (process.env.INIT_CWD) {
  try {
    isSelfInstall = fs.realpathSync(path.resolve(process.env.INIT_CWD)) === fs.realpathSync(PACKAGE_ROOT);
  } catch (_) {
    isSelfInstall = path.resolve(process.env.INIT_CWD) === PACKAGE_ROOT;
  }
}

if (!isTruthy(process.env.SICP_FORCE_POSTINSTALL)) {
  if (isTruthy(process.env.SICP_SKIP_POSTINSTALL)) {
    process.stdout.write('\n  [SICP] SICP_SKIP_POSTINSTALL set — skipping core setup.\n\n');
    process.exit(0);
  }
  if (isSourceCheckout || isSelfInstall) {
    process.stdout.write(
      '\n  [SICP] Source checkout detected — skipping automatic core setup.\n' +
      "        Your global ~/.claude was not modified.\n" +
      "        To install into ~/.claude from here, run: npx si-claude-plugin\n\n"
    );
    process.exit(0);
  }
}

let currentVersion = null;
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  currentVersion = pkg.version || null;
} catch (_) { /* intentional noop */ }

// Must match STATE_DIR / versionTrackerPath in scripts/hooks/session-start-plugin-sync.js.
// The directory is named for the Claude Code plugin, not the npm package.
const trackerPath = path.join(os.homedir(), '.claude', 'SI-Claude-Plugin', 'installed-version.txt');
let lastDeployed = null;
try { lastDeployed = fs.readFileSync(trackerPath, 'utf8').trim() || null; } catch (_) { /* intentional noop */ }

if (currentVersion && currentVersion === lastDeployed) {
  process.stdout.write(`\n  [SICP] v${currentVersion} already installed — skipping.\n\n`);
  process.exit(0);
}

process.stdout.write(`\n  [SICP] Running core setup (v${currentVersion || '?'})...\n`);

const result = spawnSync(
  process.execPath,
  [INSTALL_SCRIPT, '--target', 'claude', '--profile', 'core'],
  { encoding: 'utf8', cwd: PACKAGE_ROOT, timeout: 120000, stdio: 'inherit' }
);

if (result.error || result.status !== 0) {
  const reason = result.error ? result.error.message : `exit ${result.status}`;
  process.stdout.write(`\n  [SICP] Auto-setup failed (${reason}).\n  Run manually: npx si-claude-plugin\n\n`);
} else {
  try {
    fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
    fs.writeFileSync(trackerPath, currentVersion || 'unknown');
  } catch (_) { /* intentional noop */ }
  process.stdout.write(`\n  [SICP] Core setup complete! Run 'npx si-claude-plugin' for language-specific rules.\n\n`);
}
